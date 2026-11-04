const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rate-limit');
const { signUser } = require('../utils/security');
const { toLocalDateString, generateNoSPK, generateNoInvoice, defaultChecklist } = require('../utils/helper');
const { generateMitraInvoicePdf } = require('../services/pdfservice');
const router = express.Router();
const publicAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const publicUser = (u) => ({ id: u.id, nama: u.nama, email: u.email, telepon: u.telepon, role: u.role, mitra_id: u.mitra_id || null });

function validSchedule(tanggal, waktu) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tanggal || '');
  if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(waktu || '')) return false;
  const [hour, minute] = waktu.split(':').map(Number);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute);
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) && date.getHours() === hour && date.getMinutes() === minute && date >= new Date();
}

router.post('/register', publicAuthLimit, async (req, res) => {
  const { nama_showroom, pic_nama, telepon, email, password } = req.body;
  if (!nama_showroom || !pic_nama || !telepon || !email || !password) return res.status(400).json({ error: 'Semua data mitra wajib diisi' });
  if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  if (await db.get('SELECT id FROM users WHERE telepon=? OR (email IS NOT NULL AND email=?)', [telepon, email])) return res.status(409).json({ error: 'Email atau nomor WhatsApp sudah terdaftar' });
  const user = await db.transaction(async (connection) => {
    const mitra = await db.run('INSERT INTO mitra (nama_showroom, alamat, telepon, email, pic_nama, pic_telepon, diskon_persen) VALUES (?, ?, ?, ?, ?, ?, ?)', [nama_showroom, null, telepon, email, pic_nama, telepon, 15], connection);
    const result = await db.run('INSERT INTO users (nama, email, telepon, password, role, mitra_id, aktif) VALUES (?, ?, ?, ?, ?, ?, ?)', [pic_nama, email, telepon, bcrypt.hashSync(password, 10), 'mitra', mitra.insertId, 1], connection);
    return db.get('SELECT * FROM users WHERE id=?', [result.insertId], connection);
  });
  res.status(201).json({ token: signUser(user), user: publicUser(user) });
});

router.get('/admin/mitra', auth(['admin']), async (req, res) => {
  res.json(await db.all(`
    SELECT m.id, m.nama_showroom, m.alamat, m.telepon, m.email, m.pic_nama, m.pic_telepon,
           m.diskon_persen, m.created_at, u.aktif,
           (SELECT COUNT(*) FROM armada a WHERE a.mitra_id=m.id) AS total_armada,
           (SELECT COUNT(*) FROM spk s WHERE s.mitra_id=m.id) AS total_spk
    FROM mitra m
    LEFT JOIN users u ON u.mitra_id=m.id AND u.role='mitra'
    ORDER BY m.id DESC
  `));
});

router.get('/admin/billable-spk', auth(['admin']), async (req, res) => {
  res.json(await db.all(`
    SELECT m.id AS mitra_id, m.nama_showroom, COUNT(s.id) AS total_unit,
           SUM(s.harga) AS subtotal, SUM(s.diskon) AS diskon, SUM(s.total) AS total,
           MIN(DATE(COALESCE(s.waktu_selesai, s.created_at))) AS periode_mulai,
           MAX(DATE(COALESCE(s.waktu_selesai, s.created_at))) AS periode_selesai
    FROM spk s
    JOIN mitra m ON m.id=s.mitra_id
    LEFT JOIN invoice_mitra_spk ims ON ims.spk_id=s.id
    WHERE s.status='Selesai' AND ims.spk_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoice_mitra legacy
        WHERE legacy.mitra_id=s.mitra_id
          AND DATE(COALESCE(s.waktu_selesai, s.created_at)) BETWEEN legacy.periode_mulai AND legacy.periode_selesai
          AND NOT EXISTS (
            SELECT 1 FROM invoice_mitra_spk legacy_link WHERE legacy_link.invoice_id=legacy.id
          )
      )
    GROUP BY m.id, m.nama_showroom
    ORDER BY m.nama_showroom
  `));
});

router.post('/admin/invoices', auth(['admin']), async (req, res) => {
  const mitraId = Number(req.body.mitra_id);
  const jatuhTempo = req.body.jatuh_tempo;
  if (!Number.isInteger(mitraId) || mitraId < 1) {
    return res.status(400).json({ error: 'Mitra tidak valid' });
  }
  const dueDateMatch = /^(\d{4})-\d{2}-\d{2}$/.exec(jatuhTempo || '');
  const dueDate = dueDateMatch && Number(dueDateMatch[1]) >= 1000
    ? new Date(`${jatuhTempo}T00:00:00Z`)
    : null;
  if (jatuhTempo !== undefined && jatuhTempo !== null && jatuhTempo !== '' &&
      (!dueDate || dueDate.toISOString().slice(0, 10) !== jatuhTempo)) {
    return res.status(400).json({ error: 'Format tanggal jatuh tempo tidak valid' });
  }

  const invoice = await db.transaction(async (connection) => {
    const mitra = await db.get('SELECT id FROM mitra WHERE id=? FOR UPDATE', [mitraId], connection);
    if (!mitra) {
      const error = new Error('Mitra tidak ditemukan');
      error.status = 404;
      throw error;
    }
    const rows = await db.all(`
      SELECT s.id, COALESCE(s.harga, 0) AS harga, COALESCE(s.diskon, 0) AS diskon,
             COALESCE(s.total, 0) AS total,
             DATE(COALESCE(s.waktu_selesai, s.created_at)) AS tanggal_selesai
      FROM spk s
      LEFT JOIN invoice_mitra_spk ims ON ims.spk_id=s.id
      WHERE s.mitra_id=? AND s.status='Selesai'
        AND ims.spk_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_mitra legacy
          WHERE legacy.mitra_id=s.mitra_id
            AND DATE(COALESCE(s.waktu_selesai, s.created_at)) BETWEEN legacy.periode_mulai AND legacy.periode_selesai
            AND NOT EXISTS (
              SELECT 1 FROM invoice_mitra_spk legacy_link WHERE legacy_link.invoice_id=legacy.id
            )
        )
      ORDER BY s.waktu_selesai, s.id
      FOR UPDATE
    `, [mitraId], connection);
    if (!rows.length) {
      const error = new Error('Tidak ada SPK selesai yang belum ditagihkan untuk mitra ini');
      error.status = 409;
      throw error;
    }
    const totals = rows.reduce((acc, row) => ({
      subtotal: acc.subtotal + Number(row.harga || 0),
      diskon: acc.diskon + Number(row.diskon || 0),
      total: acc.total + Number(row.total || 0)
    }), { subtotal: 0, diskon: 0, total: 0 });
    if (totals.total <= 0) {
      const error = new Error('Total invoice harus lebih besar dari nol');
      error.status = 400;
      throw error;
    }

    let invoiceId;
    let noInvoice;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      noInvoice = await generateNoInvoice(db, mitraId, connection);
      try {
        const result = await db.run(`
          INSERT INTO invoice_mitra
            (no_invoice, mitra_id, periode_mulai, periode_selesai, total_unit, subtotal, diskon, total, status, jatuh_tempo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Belum Dibayar', ?)
        `, [noInvoice, mitraId, rows[0].tanggal_selesai, rows[rows.length - 1].tanggal_selesai,
          rows.length, totals.subtotal, totals.diskon, totals.total, jatuhTempo || null], connection);
        invoiceId = Number(result.insertId);
        break;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
      }
    }

    for (const row of rows) {
      await db.run('INSERT INTO invoice_mitra_spk (invoice_id, spk_id) VALUES (?, ?)',
        [invoiceId, row.id], connection);
    }
    await db.run(`
      INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
      VALUES ('invoice_mitra', ?, 'invoice_created', ?, 'admin', ?)
    `, [invoiceId, req.user.id, JSON.stringify({ mitra_id: mitraId, no_invoice: noInvoice, total_unit: rows.length, ...totals })], connection);
    return db.get('SELECT * FROM invoice_mitra WHERE id=?', [invoiceId], connection);
  });
  res.status(201).json(invoice);
});

router.get('/admin/bookings', auth(['admin']), async (req, res) => {
  res.json(await db.all(`
    SELECT b.id, b.mitra_id, b.layanan_id, b.tanggal, b.waktu, b.catatan, b.status, b.created_at,
           m.nama_showroom, m.pic_nama, m.telepon AS mitra_telepon,
           l.nama AS layanan_nama, l.harga AS harga_layanan,
           (SELECT COUNT(*) FROM booking_armada_unit bu WHERE bu.booking_id=b.id) AS total_unit,
           (SELECT GROUP_CONCAT(CONCAT(a.plat_nomor, ' · ', COALESCE(a.merk_tipe, 'Kendaraan')) ORDER BY a.id SEPARATOR ', ')
            FROM booking_armada_unit bu JOIN armada a ON a.id=bu.armada_id WHERE bu.booking_id=b.id) AS unit
    FROM booking_armada b
    JOIN mitra m ON m.id=b.mitra_id
    JOIN layanan l ON l.id=b.layanan_id
    ORDER BY b.id DESC
  `));
});

router.patch('/admin/bookings/:id/status', auth(['admin']), async (req, res) => {
  const bookingId = Number(req.params.id);
  const newStatus = req.body.status;
  const validStatuses = ['Diproses', 'Dikonversi', 'Batal'];
  if (!Number.isInteger(bookingId) || bookingId < 1 || !validStatuses.includes(newStatus)) {
    return res.status(400).json({ error: 'Booking atau status tidak valid' });
  }

  const result = await db.transaction(async (connection) => {
    const booking = await db.get(`
      SELECT b.*, m.diskon_persen, l.harga
      FROM booking_armada b
      JOIN mitra m ON m.id=b.mitra_id
      JOIN layanan l ON l.id=b.layanan_id
      WHERE b.id=? FOR UPDATE
    `, [bookingId], connection);
    if (!booking) {
      const error = new Error('Booking armada tidak ditemukan');
      error.status = 404;
      throw error;
    }
    if (booking.status === newStatus) return { booking, spk: [] };
    const transitions = {
      Baru: ['Diproses', 'Dikonversi', 'Batal'],
      Diproses: ['Dikonversi', 'Batal'],
      Dikonversi: [],
      Batal: []
    };
    if (!transitions[booking.status]?.includes(newStatus)) {
      const error = new Error('Perubahan status booking tidak diizinkan');
      error.status = 400;
      throw error;
    }

    const createdSpk = [];
    if (newStatus === 'Dikonversi') {
      const units = await db.all(`
        SELECT a.id, a.plat_nomor, a.merk_tipe, a.tahun, a.warna
        FROM booking_armada_unit bu
        JOIN armada a ON a.id=bu.armada_id
        WHERE bu.booking_id=? AND a.mitra_id=? AND a.aktif=1
        ORDER BY a.id
      `, [bookingId, booking.mitra_id], connection);
      if (!units.length) {
        const error = new Error('Booking tidak memiliki armada aktif untuk dikonversi');
        error.status = 400;
        throw error;
      }

      for (const unit of units) {
        const discount = Math.min(Number(booking.harga), Math.round(Number(booking.harga) * Number(booking.diskon_persen) / 100));
        let spkId;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            const noSpk = await generateNoSPK(db, connection);
            const inserted = await db.run(`
              INSERT INTO spk (no_spk, mitra_id, plat_nomor, merk_tipe, tahun, warna, layanan_id,
                               harga, diskon, total, catatan, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Menunggu')
            `, [noSpk, booking.mitra_id, unit.plat_nomor, unit.merk_tipe, unit.tahun, unit.warna,
              booking.layanan_id, booking.harga, discount, Number(booking.harga) - discount,
              booking.catatan || `Dari booking armada #${bookingId}`], connection);
            spkId = Number(inserted.insertId);
            createdSpk.push(noSpk);
            break;
          } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
          }
        }
        for (const [index, item] of defaultChecklist().entries()) {
          await db.run('INSERT INTO spk_checklist (spk_id, item, urutan) VALUES (?,?,?)',
            [spkId, item, index], connection);
        }
        await db.run(`
          INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
          VALUES ('spk', ?, 'create_from_mitra_booking', ?, 'admin', ?)
        `, [spkId, req.user.id, JSON.stringify({ booking_id: bookingId, no_spk: createdSpk[createdSpk.length - 1], mitra_id: booking.mitra_id })], connection);
      }
    }

    await db.run('UPDATE booking_armada SET status=? WHERE id=?', [newStatus, bookingId], connection);
    return { booking: { ...booking, status: newStatus }, spk: createdSpk };
  });
  res.json(result);
});

router.get('/admin/payment-reports', auth(['admin']), async (req, res) => {
  res.json(await db.all(`
    SELECT i.id AS invoice_id, i.no_invoice, i.total, i.jatuh_tempo, m.nama_showroom,
           m.pic_nama, m.telepon, report.created_at AS dilaporkan_pada
    FROM invoice_mitra i
    JOIN mitra m ON m.id=i.mitra_id
    JOIN audit_log report ON report.entity_type='invoice_mitra' AND report.entity_id=i.id
      AND report.action='payment_reported'
    WHERE i.status='Belum Dibayar'
      AND report.id=(
        SELECT MAX(event.id) FROM audit_log event
        WHERE event.entity_type='invoice_mitra' AND event.entity_id=i.id
          AND event.action IN ('payment_reported','payment_verified','payment_rejected')
      )
    ORDER BY report.id DESC
  `));
});

router.patch('/admin/invoices/:id/payment-status', auth(['admin']), async (req, res) => {
  const invoiceId = Number(req.params.id);
  const decision = req.body.decision;
  if (!Number.isInteger(invoiceId) || invoiceId < 1 || !['verify', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Invoice atau keputusan tidak valid' });
  }
  const invoice = await db.transaction(async (connection) => {
    const current = await db.get('SELECT * FROM invoice_mitra WHERE id=? FOR UPDATE', [invoiceId], connection);
    if (!current) {
      const error = new Error('Invoice tidak ditemukan');
      error.status = 404;
      throw error;
    }
    if (current.status === 'Lunas') return current;
    const latestEvent = await db.get(`
      SELECT action FROM audit_log
      WHERE entity_type='invoice_mitra' AND entity_id=?
        AND action IN ('payment_reported','payment_verified','payment_rejected')
      ORDER BY id DESC LIMIT 1
    `, [invoiceId], connection);
    if (latestEvent?.action !== 'payment_reported') {
      const error = new Error('Tidak ada laporan pembayaran yang menunggu verifikasi');
      error.status = 409;
      throw error;
    }

    if (decision === 'verify') {
      await db.run("UPDATE invoice_mitra SET status='Lunas' WHERE id=? AND status='Belum Dibayar'", [invoiceId], connection);
      await db.run(
        "INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, mitra_id, tanggal) VALUES ('masuk', 'Invoice Mitra', ?, ?, ?, CURDATE())",
        [`Pembayaran ${current.no_invoice}`, current.total, current.mitra_id], connection
      );
    }
    await db.run(`
      INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
      VALUES ('invoice_mitra', ?, ?, ?, 'admin', ?)
    `, [invoiceId, decision === 'verify' ? 'payment_verified' : 'payment_rejected', req.user.id,
      JSON.stringify({ no_invoice: current.no_invoice })], connection);
    return db.get('SELECT * FROM invoice_mitra WHERE id=?', [invoiceId], connection);
  });
  res.json(invoice);
});

router.get('/me/dashboard', auth(['mitra']), async (req, res) => {
  const id = req.user.mitra_id;
  const start = toLocalDateString().slice(0, 8) + '01';
  const total = (await db.get("SELECT COUNT(*) c FROM spk WHERE mitra_id=? AND status<>'Batal' AND DATE(created_at)>=?", [id, start])).c;
  const unpaid = (await db.get("SELECT COALESCE(SUM(total),0) v FROM invoice_mitra WHERE mitra_id=? AND status='Belum Dibayar'", [id])).v;
  const completedRecently = (await db.get("SELECT COUNT(*) c FROM spk WHERE mitra_id=? AND status='Selesai' AND waktu_selesai>=DATE_SUB(NOW(), INTERVAL 30 DAY)", [id])).c;
  res.json({ total_cuci_bulan_ini: total, tagihan_belum_dibayar: unpaid, kendaraan_selesai_30_hari: completedRecently });
});

router.get('/me/profile', auth(['mitra']), async (req, res) => {
  const profile = await db.get(`
    SELECT m.nama_showroom, m.alamat, m.telepon, m.email, m.pic_nama, m.pic_telepon,
           m.diskon_persen, u.nama AS user_nama
    FROM mitra m JOIN users u ON u.mitra_id=m.id AND u.role='mitra'
    WHERE m.id=? AND u.id=?
  `, [req.user.mitra_id, req.user.id]);
  if (!profile) return res.status(404).json({ error: 'Profil mitra tidak ditemukan' });
  res.json(profile);
});

router.get('/me/jobs', auth(['mitra']), async (req, res) => {
  res.json(await db.all(`
    SELECT s.id, s.no_spk, s.plat_nomor, s.merk_tipe, s.status, s.created_at,
           s.waktu_mulai, s.waktu_selesai, l.nama AS layanan_nama
    FROM spk s LEFT JOIN layanan l ON l.id=s.layanan_id
    WHERE s.mitra_id=?
    ORDER BY s.id DESC LIMIT 100
  `, [req.user.mitra_id]));
});

router.get('/me/invoices', auth(['mitra']), async (req, res) => {
  res.json(await db.all(`
    SELECT i.id, i.no_invoice, i.periode_mulai, i.periode_selesai, i.total_unit, i.subtotal,
           i.diskon, i.total, i.status, i.jatuh_tempo, i.created_at,
           (SELECT action FROM audit_log e WHERE e.entity_type='invoice_mitra'
            AND e.entity_id=i.id AND e.action IN ('payment_reported','payment_verified','payment_rejected')
            ORDER BY e.id DESC LIMIT 1) AS payment_action
    FROM invoice_mitra i WHERE i.mitra_id=? ORDER BY i.id DESC
  `, [req.user.mitra_id]));
});

router.get('/me/invoices/:id/pdf', auth(['mitra']), async (req, res) => {
  const invoiceId = Number(req.params.id);
  if (!Number.isInteger(invoiceId) || invoiceId < 1) {
    return res.status(400).json({ error: 'Invoice tidak valid' });
  }
  const invoice = await db.get(`
    SELECT i.*, m.nama_showroom, m.alamat, m.email, m.telepon
    FROM invoice_mitra i
    JOIN mitra m ON m.id=i.mitra_id
    WHERE i.id=? AND i.mitra_id=?
  `, [invoiceId, req.user.mitra_id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  const items = await db.all(`
    SELECT s.no_spk, s.plat_nomor, s.merk_tipe, s.harga, s.diskon, s.total,
           s.created_at, s.waktu_selesai, l.nama AS layanan_nama
    FROM invoice_mitra_spk ims
    JOIN spk s ON s.id=ims.spk_id
    LEFT JOIN layanan l ON l.id=s.layanan_id
    WHERE ims.invoice_id=?
    ORDER BY s.waktu_selesai, s.id
  `, [invoiceId]);

  try {
    const pdf = Buffer.from(await generateMitraInvoicePdf(invoice, {
      nama_showroom: invoice.nama_showroom,
      alamat: invoice.alamat,
      email: invoice.email,
      telepon: invoice.telepon
    }, items));
    const filename = String(invoice.no_invoice).replace(/[^A-Za-z0-9_-]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${filename}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('Mitra invoice PDF generation failed:', error);
    res.status(500).json({ error: 'Gagal membuat PDF invoice' });
  }
});

router.get('/me/armada', auth(['mitra']), async (req, res) => {
  res.json(await db.all('SELECT id, plat_nomor, merk_tipe, tahun, warna, aktif, created_at, updated_at FROM armada WHERE mitra_id=? ORDER BY aktif DESC, id DESC', [req.user.mitra_id]));
});

router.post('/me/armada', auth(['mitra']), async (req, res) => {
  const { plat_nomor, merk_tipe, tahun, warna } = req.body;
  if (!plat_nomor || !String(plat_nomor).trim()) return res.status(400).json({ error: 'Plat nomor wajib diisi' });
  try {
    const result = await db.run('INSERT INTO armada (mitra_id, plat_nomor, merk_tipe, tahun, warna) VALUES (?,?,?,?,?)', [req.user.mitra_id, String(plat_nomor).trim().toUpperCase(), merk_tipe || null, tahun || null, warna || null]);
    res.status(201).json(await db.get('SELECT * FROM armada WHERE id=? AND mitra_id=?', [result.insertId, req.user.mitra_id]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Plat nomor sudah terdaftar di armada mitra' });
    throw error;
  }
});

router.put('/me/armada/:id', auth(['mitra']), async (req, res) => {
  const { plat_nomor, merk_tipe, tahun, warna, aktif } = req.body;
  if (!plat_nomor) return res.status(400).json({ error: 'Plat nomor wajib diisi' });
  if (aktif !== undefined && typeof aktif !== 'boolean') return res.status(400).json({ error: 'Field aktif harus boolean' });
  try {
    const result = await db.run('UPDATE armada SET plat_nomor=?, merk_tipe=?, tahun=?, warna=?, aktif=COALESCE(?, aktif) WHERE id=? AND mitra_id=?', [String(plat_nomor).trim().toUpperCase(), merk_tipe || null, tahun || null, warna || null, aktif === undefined ? null : (aktif ? 1 : 0), Number(req.params.id), req.user.mitra_id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Armada tidak ditemukan' });
    res.json(await db.get('SELECT * FROM armada WHERE id=? AND mitra_id=?', [Number(req.params.id), req.user.mitra_id]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Plat nomor sudah terdaftar di armada mitra' });
    throw error;
  }
});

router.get('/me/bookings', auth(['mitra']), async (req, res) => {
  res.json(await db.all(`
    SELECT b.id, b.tanggal, b.waktu, b.catatan, b.status, b.created_at, l.nama AS layanan_nama,
           COUNT(u.armada_id) AS total_unit
    FROM booking_armada b
    JOIN layanan l ON l.id=b.layanan_id
    LEFT JOIN booking_armada_unit u ON u.booking_id=b.id
    WHERE b.mitra_id=? GROUP BY b.id ORDER BY b.id DESC
  `, [req.user.mitra_id]));
});

router.patch('/me/bookings/:id/status', auth(['mitra']), async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isInteger(bookingId) || bookingId < 1 || req.body.status !== 'Batal') {
    return res.status(400).json({ error: 'Booking atau status pembatalan tidak valid' });
  }

  const booking = await db.transaction(async (connection) => {
    const current = await db.get(
      'SELECT * FROM booking_armada WHERE id=? AND mitra_id=? FOR UPDATE',
      [bookingId, req.user.mitra_id],
      connection
    );
    if (!current) {
      const error = new Error('Booking armada tidak ditemukan');
      error.status = 404;
      throw error;
    }
    if (!['Baru', 'Diproses'].includes(current.status)) {
      const error = new Error('Booking yang sudah dikonversi atau dibatalkan tidak dapat dibatalkan');
      error.status = 409;
      throw error;
    }
    await db.run("UPDATE booking_armada SET status='Batal' WHERE id=?", [bookingId], connection);
    return { ...current, status: 'Batal' };
  });
  res.json(booking);
});

router.post('/me/bookings', auth(['mitra']), async (req, res) => {
  const { layanan_id, armada_ids, tanggal, waktu, catatan } = req.body;
  const layananId = Number(layanan_id);
  const ids = Array.isArray(armada_ids) ? [...new Set(armada_ids.map(Number))] : [];
  if (!Number.isInteger(layananId) || layananId < 1 || !ids.length || ids.length > 10 || ids.some((id) => !Number.isInteger(id) || id < 1)) return res.status(400).json({ error: 'Layanan dan 1 sampai 10 armada wajib dipilih' });
  if (!validSchedule(tanggal, waktu)) return res.status(400).json({ error: 'Tanggal atau waktu booking tidak valid' });
  const layanan = await db.get('SELECT id FROM layanan WHERE id=? AND aktif=1', [layananId]);
  if (!layanan) return res.status(400).json({ error: 'Layanan tidak ditemukan' });

  const booking = await db.transaction(async (connection) => {
    const placeholders = ids.map(() => '?').join(',');
    const units = await db.all(`SELECT id FROM armada WHERE mitra_id=? AND aktif=1 AND id IN (${placeholders})`, [req.user.mitra_id, ...ids], connection);
    if (units.length !== ids.length) {
      const error = new Error('Satu atau lebih armada tidak dimiliki mitra atau tidak aktif');
      error.status = 400;
      throw error;
    }
    const result = await db.run('INSERT INTO booking_armada (mitra_id, layanan_id, tanggal, waktu, catatan) VALUES (?,?,?,?,?)', [req.user.mitra_id, layananId, tanggal, waktu, catatan || null], connection);
    for (const unit of units) await db.run('INSERT INTO booking_armada_unit (booking_id, armada_id) VALUES (?,?)', [result.insertId, unit.id], connection);
    return db.get('SELECT * FROM booking_armada WHERE id=?', [result.insertId], connection);
  });
  res.status(201).json(booking);
});

router.post('/me/invoices/:id/pay', auth(['mitra']), async (req, res) => {
  const invoice = await db.get('SELECT * FROM invoice_mitra WHERE id=? AND mitra_id=?', [Number(req.params.id), req.user.mitra_id]);
  if (!invoice) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  if (invoice.status === 'Lunas') return res.json({ ...invoice, payment_action: 'payment_verified' });
  const reported = await db.transaction(async (connection) => {
    const current = await db.get('SELECT * FROM invoice_mitra WHERE id=? AND mitra_id=? FOR UPDATE',
      [invoice.id, req.user.mitra_id], connection);
    if (!current) {
      const error = new Error('Invoice tidak ditemukan');
      error.status = 404;
      throw error;
    }
    if (current.status === 'Lunas') return { ...current, payment_action: 'payment_verified' };
    const latestEvent = await db.get(`
      SELECT action FROM audit_log
      WHERE entity_type='invoice_mitra' AND entity_id=?
        AND action IN ('payment_reported','payment_verified','payment_rejected')
      ORDER BY id DESC LIMIT 1 FOR UPDATE
    `, [invoice.id], connection);
    if (latestEvent?.action === 'payment_reported') {
      const error = new Error('Pembayaran sudah dilaporkan dan sedang menunggu verifikasi admin');
      error.status = 409;
      throw error;
    }
    await db.run(`
      INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
      VALUES ('invoice_mitra', ?, 'payment_reported', ?, 'mitra', ?)
    `, [current.id, req.user.id, JSON.stringify({ no_invoice: current.no_invoice })], connection);
    return { ...current, payment_action: 'payment_reported' };
  });
  res.json(reported);
});

router.put('/me/profile', auth(['mitra']), async (req, res) => {
  const { nama_showroom, alamat, telepon, pic_nama, pic_telepon } = req.body;
  if (!nama_showroom || !pic_nama || !telepon) return res.status(400).json({ error: 'Nama showroom, PIC, dan telepon wajib diisi' });
  await db.transaction(async (connection) => {
    await db.run('UPDATE mitra SET nama_showroom=?, alamat=?, telepon=?, pic_nama=?, pic_telepon=? WHERE id=?', [nama_showroom, alamat || null, telepon, pic_nama, pic_telepon || telepon, req.user.mitra_id], connection);
    await db.run('UPDATE users SET nama=?, telepon=? WHERE id=?', [pic_nama, pic_telepon || telepon, req.user.id], connection);
  });
  res.json({ message: 'Profil mitra berhasil diperbarui' });
});

router.put('/me/password', auth(['mitra']), async (req, res) => {
  const { password_lama, password_baru } = req.body;
  if (!password_lama || typeof password_baru !== 'string' || password_baru.length < 8) return res.status(400).json({ error: 'Password lama wajib diisi dan password baru minimal 8 karakter' });
  const user = await db.get('SELECT password FROM users WHERE id=?', [req.user.id]);
  if (!user || !bcrypt.compareSync(password_lama, user.password)) return res.status(400).json({ error: 'Password lama salah' });
  await db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(password_baru, 10), req.user.id]);
  res.json({ message: 'Password berhasil diperbarui' });
});

module.exports = router;

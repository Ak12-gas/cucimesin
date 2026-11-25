const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const storage = require('../services/storage');
const { writeAudit } = require('../utils/audit');
const router = express.Router();

const proofUpload = upload.single('bukti');

function proofObjectPath(value, { mode = 'compat' } = {}) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Legacy compat: bukti lama bisa berupa nama file polos atau path lama.
  const looksLikeUrl = /^https?:\/\//i.test(raw);
  const hasSlash = raw.includes('/') || raw.includes('\\');
  const hasDot = raw.includes('.');
  let candidate = raw;

  if (!looksLikeUrl && !hasSlash && hasDot) {
    candidate = `payment-proofs/${path.basename(raw)}`;
  } else if (!looksLikeUrl && /^\/?uploads\//i.test(raw)) {
    candidate = raw.replace(/^\/?uploads\//i, '');
  }

  const resolved = storage.toObjectPath('payment_proof', candidate, { mode });
  if (typeof resolved === 'string') return resolved;
  return resolved?.objectPath || null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function parseId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

async function removeProof(value) {
  const objectPath = proofObjectPath(value, { mode: 'compat' });
  if (!objectPath) return;
  try {
    await storage.remove('payment_proof', objectPath);
  } catch (error) {
    console.error('Gagal menghapus bukti pembayaran:', error.message);
  }
}

async function getAccountDetails(connection) {
  const rows = await db.all(
    'SELECT `key`, `value` FROM pengaturan WHERE `key` IN (?, ?, ?)',
    ['rekening_bank', 'rekening_nomor', 'rekening_pemilik'],
    connection
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function formatRekening(rekening) {
  return {
    bank: rekening.rekening_bank || '',
    nomor: rekening.rekening_nomor || '',
    pemilik: rekening.rekening_pemilik || ''
  };
}

async function hasEligibleCustomerPayment(userId, connection) {
  const row = await db.get(`
    SELECT s.id
    FROM spk s
    INNER JOIN pelanggan c ON c.id = s.pelanggan_id
    LEFT JOIN pembayaran p ON p.spk_id = s.id
    WHERE c.user_id = ?
      AND s.status = 'Selesai'
      AND s.mitra_id IS NULL
      AND s.total > 0
      AND (p.id IS NULL OR p.status = 'Ditolak')
    LIMIT 1
  `, [userId], connection);
  return Boolean(row);
}

async function hasEligibleMitraInvoice(mitraId, connection) {
  if (!mitraId) return false;
  const row = await db.get(`
    SELECT i.id
    FROM invoice_mitra i
    WHERE i.mitra_id = ?
      AND i.status = 'Belum Dibayar'
      AND NOT EXISTS (
        SELECT 1
        FROM audit_log e
        WHERE e.entity_type = 'invoice_mitra'
          AND e.entity_id = i.id
          AND e.action = 'payment_reported'
          AND e.id = (
            SELECT MAX(e2.id)
            FROM audit_log e2
            WHERE e2.entity_type = 'invoice_mitra'
              AND e2.entity_id = i.id
              AND e2.action IN ('payment_reported', 'payment_verified', 'payment_rejected')
          )
      )
    LIMIT 1
  `, [mitraId], connection);
  return Boolean(row);
}

async function canViewRekening(user, connection) {
  if (user.role === 'admin') return true;
  if (user.role === 'pelanggan') return hasEligibleCustomerPayment(user.id, connection);
  if (user.role === 'mitra') return hasEligibleMitraInvoice(user.mitra_id, connection);
  return false;
}

async function loadPayableOrder(req, res, next) {
  const spkId = parseId(req.params.spkId);
  if (!spkId) return res.status(400).json({ error: 'ID SPK tidak valid' });

  const order = await db.get(`
    SELECT s.id, s.no_spk, s.total, s.status, s.mitra_id
    FROM spk s
    INNER JOIN pelanggan p ON p.id = s.pelanggan_id
    WHERE s.id = ? AND p.user_id = ?
  `, [spkId, req.user.id]);
  if (!order) return res.status(404).json({ error: 'SPK tidak ditemukan' });
  if (order.status !== 'Selesai' || order.mitra_id) {
    return res.status(400).json({ error: 'Pembayaran online hanya tersedia untuk SPK pelanggan yang selesai' });
  }
  if (!Number.isSafeInteger(Number(order.total)) || Number(order.total) <= 0) {
    return res.status(400).json({ error: 'Total pembayaran SPK tidak valid' });
  }

  const payment = await db.get('SELECT status FROM pembayaran WHERE spk_id = ?', [spkId]);
  if (payment && payment.status !== 'Ditolak') {
    return res.status(409).json({ error: payment.status === 'Dikonfirmasi'
      ? 'Pembayaran untuk SPK ini sudah dikonfirmasi'
      : 'Bukti pembayaran sedang menunggu konfirmasi admin' });
  }

  const account = await getAccountDetails();
  if (!account.rekening_bank || !account.rekening_nomor || !account.rekening_pemilik) {
    return res.status(409).json({ error: 'Informasi rekening pembayaran belum diatur admin' });
  }

  req.paymentOrder = order;
  next();
}

router.get('/me', auth(['pelanggan']), async (req, res) => {
  const orders = await db.all(`
    SELECT s.id AS spk_id, s.no_spk, s.plat_nomor, s.merk_tipe, s.total,
           p.id AS pembayaran_id, p.nominal, p.metode, p.status AS status_pembayaran,
           p.catatan_admin, p.submitted_at, p.confirmed_at,
           (p.bukti_path IS NOT NULL) AS has_bukti
    FROM spk s
    INNER JOIN pelanggan c ON c.id = s.pelanggan_id
    LEFT JOIN pembayaran p ON p.spk_id = s.id
    WHERE c.user_id = ?
      AND s.status = 'Selesai' AND s.mitra_id IS NULL
    ORDER BY s.id DESC
  `, [req.user.id]);
  // Rekening hanya dimuat on-demand via GET /rekening saat tombol Bayar ditekan.
  res.json({ rekening: null, pembayaran: orders });
});

router.get('/rekening', auth(['admin', 'mitra', 'pelanggan']), async (req, res) => {
  const allowed = await canViewRekening(req.user);
  if (!allowed) return res.status(403).json({ error: 'Akses ditolak' });
  res.json(formatRekening(await getAccountDetails()));
});

router.put('/rekening', auth(['admin']), async (req, res) => {
  const rekening = {
    rekening_bank: String(req.body.bank || '').trim(),
    rekening_nomor: String(req.body.nomor || '').trim(),
    rekening_pemilik: String(req.body.pemilik || '').trim()
  };
  if (Object.values(rekening).some((value) => !value)) {
    return res.status(400).json({ error: 'Nama bank, nomor rekening, dan nama pemilik wajib diisi' });
  }
  if (rekening.rekening_bank.length > 100 || rekening.rekening_nomor.length > 50 || rekening.rekening_pemilik.length > 150) {
    return res.status(400).json({ error: 'Informasi rekening melebihi batas panjang yang diizinkan' });
  }

  await db.transaction(async (connection) => {
    for (const [key, value] of Object.entries(rekening)) {
      await db.run(
        'INSERT INTO pengaturan (`key`, `value`) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"',
        [key, value],
        connection
      );
    }
    await writeAudit('pengaturan', null, 'rekening_update', req.user, { keys: Object.keys(rekening) }, connection);
  });
  res.json({ message: 'Informasi rekening berhasil disimpan' });
});

router.post('/:spkId/bukti', auth(['pelanggan']), loadPayableOrder, (req, res, next) => {
  proofUpload(req, res, (error) => {
    if (error) return next(error);
    return next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file bukti pembayaran terlebih dahulu' });

  const validSignature = upload.hasValidImageSignature(req.file.buffer, req.file.mimetype);
  if (!validSignature) {
    return res.status(400).json({ error: 'Isi file tidak sesuai dengan format gambar yang dipilih' });
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  const spkId = req.paymentOrder.id;
  const objectPath = `payment-proofs/${spkId}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;
  let storedPath;
  try {
    const uploadResult = await storage.upload('payment_proof', objectPath, req.file.buffer, req.file.mimetype);
    storedPath = typeof uploadResult === 'string' ? uploadResult : uploadResult.objectPath;
  } catch (error) {
    console.error('[UPLOAD] gagal menyimpan bukti pembayaran:', error.message);
    return res.status(503).json({ error: 'Gagal menyimpan bukti. Coba lagi nanti.' });
  }

  let previousProof;
  try {
    const payment = await db.transaction(async (connection) => {
      const order = await db.get(`
        SELECT s.id, s.no_spk, s.total, s.status, s.mitra_id
        FROM spk s
        INNER JOIN pelanggan p ON p.id = s.pelanggan_id
        WHERE s.id = ? AND p.user_id = ?
        FOR UPDATE
      `, [req.paymentOrder.id, req.user.id], connection);
      if (!order || order.status !== 'Selesai' || order.mitra_id) {
        throw httpError(409, 'SPK tidak lagi tersedia untuk pembayaran online');
      }

      const existing = await db.get(
        'SELECT id, status, bukti_path FROM pembayaran WHERE spk_id = ? FOR UPDATE',
        [order.id],
        connection
      );
      if (existing && existing.status !== 'Ditolak') {
        throw httpError(409, existing.status === 'Dikonfirmasi'
          ? 'Pembayaran untuk SPK ini sudah dikonfirmasi'
          : 'Bukti pembayaran sedang menunggu konfirmasi admin');
      }

      if (existing) {
        previousProof = existing.bukti_path;
        await db.run(`
          UPDATE pembayaran
          SET nominal = ?, metode = 'Transfer Bank', bukti_path = ?, updated_at = CURRENT_TIMESTAMP,
              status = 'Menunggu Konfirmasi', catatan_admin = NULL,
              submitted_at = CURRENT_TIMESTAMP, confirmed_at = NULL, confirmed_by = NULL
          WHERE id = ?
        `, [Number(order.total), storedPath, existing.id], connection);
        return db.get('SELECT * FROM pembayaran WHERE id = ?', [existing.id], connection);
      }

      const result = await db.run(`
        INSERT INTO pembayaran (spk_id, nominal, metode, bukti_path, status)
        VALUES (?, ?, 'Transfer Bank', ?, 'Menunggu Konfirmasi')
      `, [order.id, Number(order.total), storedPath], connection);
      return db.get('SELECT * FROM pembayaran WHERE id = ?', [result.insertId], connection);
    });

    if (previousProof) await removeProof(previousProof);
    res.status(201).json({
      id: payment.id,
      spk_id: payment.spk_id,
      nominal: payment.nominal,
      status: payment.status,
      submitted_at: payment.submitted_at
    });
  } catch (error) {
    await storage.remove('payment_proof', objectPath).catch(() => {});
    throw error;
  }
});

router.get('/admin', auth(['admin']), async (_req, res) => {
  const rows = await db.all(`
    SELECT p.id, p.spk_id, s.no_spk, s.plat_nomor, s.merk_tipe,
           COALESCE(u.nama, c.nama) AS pelanggan, p.nominal, p.metode,
           p.status, (p.bukti_path IS NOT NULL) AS has_bukti,
           p.catatan_admin, p.submitted_at, p.confirmed_at
    FROM pembayaran p
    INNER JOIN spk s ON s.id = p.spk_id
    LEFT JOIN pelanggan c ON c.id = s.pelanggan_id
    LEFT JOIN users u ON u.id = c.user_id
    ORDER BY CASE WHEN p.status = 'Menunggu Konfirmasi' THEN 0 ELSE 1 END,
             p.submitted_at DESC
    LIMIT 200
  `);
  res.json(rows);
});

router.get('/:id/bukti', auth(['admin', 'pelanggan']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID pembayaran tidak valid' });

  const payment = await db.get(`
    SELECT p.bukti_path, c.user_id
    FROM pembayaran p
    INNER JOIN spk s ON s.id = p.spk_id
    LEFT JOIN pelanggan c ON c.id = s.pelanggan_id
    WHERE p.id = ?
  `, [id]);
  if (!payment || !payment.bukti_path) return res.status(404).json({ error: 'Bukti pembayaran tidak ditemukan' });
  const isOwner = Number(payment.user_id) === Number(req.user.id);
  if (req.user.role !== 'admin' && !isOwner) {
    return res.status(403).json({ error: 'Anda tidak memiliki akses ke bukti pembayaran ini' });
  }

  const objectPath = proofObjectPath(payment.bukti_path, { mode: 'compat' });
  if (!objectPath) return res.status(404).json({ error: 'Bukti pembayaran tidak ditemukan' });

  let bytes;
  let contentType;
  try {
    const downloadResult = await storage.download('payment_proof', objectPath);
    bytes = Buffer.isBuffer(downloadResult) ? downloadResult : downloadResult?.bytes;
    contentType = (!Buffer.isBuffer(downloadResult) && downloadResult?.contentType)
      ? downloadResult.contentType
      : storage.contentTypeForPath(objectPath);
  } catch (error) {
    console.error('[DOWNLOAD] gagal membaca bukti pembayaran:', error.message);
    return res.status(404).json({ error: 'Bukti pembayaran tidak tersedia' });
  }

  if (!Buffer.isBuffer(bytes)) {
    return res.status(404).json({ error: 'Bukti pembayaran tidak tersedia' });
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.send(bytes);
});

router.patch('/:id/status', auth(['admin']), async (req, res) => {
  const paymentId = parseId(req.params.id);
  const status = req.body.status;
  const note = String(req.body.catatan_admin || '').trim();
  if (!paymentId) return res.status(400).json({ error: 'ID pembayaran tidak valid' });
  if (!['Dikonfirmasi', 'Ditolak'].includes(status)) {
    return res.status(400).json({ error: 'Status konfirmasi pembayaran tidak valid' });
  }
  if (note.length > 500) return res.status(400).json({ error: 'Catatan admin maksimal 500 karakter' });
  if (status === 'Ditolak' && !note) {
    return res.status(400).json({ error: 'Alasan penolakan wajib diisi' });
  }

  const updated = await db.transaction(async (connection) => {
    const reference = await db.get(
      'SELECT spk_id FROM pembayaran WHERE id = ?',
      [paymentId],
      connection
    );
    if (!reference) throw httpError(404, 'Pembayaran tidak ditemukan');
    await db.get('SELECT id FROM spk WHERE id = ? FOR UPDATE', [reference.spk_id], connection);

    const payment = await db.get(`
      SELECT p.*, s.no_spk, s.total AS total_spk
      FROM pembayaran p
      INNER JOIN spk s ON s.id = p.spk_id
      WHERE p.id = ?
      FOR UPDATE
    `, [paymentId], connection);
    if (!payment) throw httpError(404, 'Pembayaran tidak ditemukan');
    if (payment.status !== 'Menunggu Konfirmasi') {
      throw httpError(409, 'Pembayaran ini sudah diproses');
    }
    if (Number(payment.nominal) !== Number(payment.total_spk)) {
      throw httpError(409, 'Total SPK berubah setelah bukti dikirim. Tolak bukti ini dan minta pelanggan mengirim ulang.');
    }

    await db.run(`
      UPDATE pembayaran
      SET status = ?, catatan_admin = ?, confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'Menunggu Konfirmasi'
    `, [status, note || null, req.user.id, paymentId], connection);

    if (status === 'Dikonfirmasi') {
      await db.run(`
        INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, spk_id, tanggal)
        VALUES ('masuk', 'Pembayaran Online', ?, ?, ?, CURRENT_DATE)
      `, [`Pembayaran ${payment.no_spk}`, Number(payment.nominal), payment.spk_id], connection);
    }

    await writeAudit('pembayaran', paymentId, status === 'Dikonfirmasi' ? 'payment_confirmed' : 'payment_rejected', req.user, {
      spk_id: payment.spk_id, no_spk: payment.no_spk, nominal: payment.nominal, catatan_admin: note || null
    }, connection);

    return db.get('SELECT * FROM pembayaran WHERE id = ?', [paymentId], connection);
  });

  res.json(updated);
});

module.exports = router;

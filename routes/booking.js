const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { defaultChecklist } = require('../utils/helper');
const router = express.Router();

// Fungsi bantuan tetap dipertahankan
function isValidDateTime(dateValue, timeValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const [hour, minute] = timeValue.split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && date.getHours() === hour && date.getMinutes() === minute;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function lockBookingDate(connection, date) {
  await db.run('INSERT INTO booking_schedule_lock (tanggal) VALUES (?) ON CONFLICT (tanggal) DO NOTHING', [date], connection);
  await db.get('SELECT tanggal FROM booking_schedule_lock WHERE tanggal=? FOR UPDATE', [date], connection);
}

async function ensureScheduleAvailable(date, time, connection, excludeBookingId) {
  const params = [date, time];
  let sql = `
    SELECT id FROM booking
    WHERE tanggal=? AND waktu=? AND status <> 'Batal'
  `;
  if (excludeBookingId) {
    sql += ' AND id <> ?';
    params.push(excludeBookingId);
  }
  sql += ' LIMIT 1';

  const existing = await db.get(sql, params, connection);
  if (existing) {
    throw httpError(409, 'Jadwal tersebut sudah dipesan. Silakan pilih waktu lain.');
  }
}

router.get('/availability', async (req, res, next) => {
  const date = typeof req.query.date === 'string' ? req.query.date : '';
  if (!isValidDateTime(date, '00:00')) {
    return res.status(400).json({ error: 'Tanggal booking tidak valid' });
  }

  try {
    const rows = await db.all(`
      SELECT DISTINCT TO_CHAR(waktu, 'HH24:MI') AS waktu
      FROM booking
      WHERE tanggal=? AND waktu IS NOT NULL AND status <> 'Batal'
      ORDER BY waktu
    `, [date]);
    res.json({ tanggal: date, booked: rows.map((row) => row.waktu) });
  } catch (error) {
    next(error);
  }
});

async function createBooking(req, res, next) {
  try {
    const body = req.body || {};
    const requiredFields = ['nama', 'telepon', 'plat_nomor', 'tanggal', 'waktu'];
    if (requiredFields.some((field) => typeof body[field] !== 'string' || !body[field].trim()) ||
        body.layanan_id === undefined || body.layanan_id === null || body.layanan_id === '') {
      return res.status(400).json({ error: 'Nama, telepon, plat, layanan, tanggal, dan waktu wajib' });
    }

    const values = {
      nama: body.nama.trim(),
      telepon: body.telepon.trim(),
      email: typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null,
      plat_nomor: body.plat_nomor.trim(),
      merk_tipe: typeof body.merk_tipe === 'string' && body.merk_tipe.trim() ? body.merk_tipe.trim() : null,
      catatan: typeof body.catatan === 'string' && body.catatan.trim() ? body.catatan.trim() : null,
      tanggal: body.tanggal,
      waktu: body.waktu
    };

    if (values.nama.length > 150 || values.telepon.length > 40 ||
        (values.email && (values.email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))) ||
        values.plat_nomor.length > 30 || (values.merk_tipe && values.merk_tipe.length > 150)) {
      return res.status(400).json({ error: 'Data booking tidak valid atau melebihi batas panjang yang diizinkan' });
    }

    const layananId = Number(body.layanan_id);
    if (!Number.isInteger(layananId) || layananId < 1) {
      return res.status(400).json({ error: 'Layanan tidak valid' });
    }

    const layanan = await db.get('SELECT id FROM layanan WHERE id=? AND aktif=1', [layananId]);
    if (!layanan) return res.status(400).json({ error: 'Layanan tidak ditemukan' });

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.waktu) ||
        !isValidDateTime(values.tanggal, values.waktu)) {
      return res.status(400).json({ error: 'Tanggal atau waktu booking tidak valid' });
    }

    const scheduledAt = new Date(`${values.tanggal}T${values.waktu}:00`);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt < new Date()) {
      return res.status(400).json({ error: 'Tanggal booking harus valid dan belum lewat' });
    }

    const result = await db.transaction(async (connection) => {
      await lockBookingDate(connection, values.tanggal);
      await ensureScheduleAvailable(values.tanggal, values.waktu, connection);

      return db.run(`
        INSERT INTO booking (user_id, nama, telepon, email, plat_nomor, merk_tipe, layanan_id, tanggal, waktu, catatan)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `, [req.user.id, values.nama, values.telepon, values.email, values.plat_nomor,
        values.merk_tipe, layananId, values.tanggal, values.waktu, values.catatan], connection);
    });

    return res.status(201).json({
      message: req.path === '/me'
        ? 'Booking Anda berhasil dibuat dan disimpan di akun!'
        : 'Booking berhasil! Tim kami akan menghubungi Anda via WhatsApp.',
      booking_id: result.insertId
    });
  } catch (error) {
    return next(error);
  }
}

// 1. GET / - Melihat daftar booking (Ditambah try...catch dan Paginasi)
router.get('/', auth(['admin']), async (req, res, next) => {
  try {
    const status = req.query.status;
    
    // Pagination metadata is opt-in to preserve the existing array response for dashboard callers.
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const params = [];
    const where = status ? 'WHERE b.status=?' : '';
    
    if (status) params.push(status);
    params.push(limit, offset); // Masukkan parameter untuk LIMIT dan OFFSET

    const rows = await db.all(`
      SELECT b.*, l.nama AS layanan_nama
      FROM booking b
      LEFT JOIN layanan l ON l.id = b.layanan_id
      ${where}
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `, params);

    if (req.query.paginate === '1') {
      const countParams = status ? [status] : [];
      const count = await db.get(`SELECT COUNT(*) AS total FROM booking b ${where}`, countParams);
      const total = Number(count.total || 0);
      return res.json({
        items: rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      });
    }

    res.json(rows);
    
  } catch (error) {
    next(error); 
  }
});

// 2. PATCH /:id/status - Mengubah status & Auto-Convert ke SPK
router.patch('/:id/status', auth(['admin']), async (req, res, next) => {
  try {
    const validStatuses = ['Baru', 'Diproses', 'Dikonversi', 'Batal'];
    const newStatus = req.body.status;

    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ error: 'Status booking tidak valid' });
    }

    const bookingId = Number(req.params.id);
    const booking = await db.get('SELECT * FROM booking WHERE id=?', [bookingId]);

    if (!booking) {
      return res.status(404).json({ error: 'Booking tidak ditemukan' });
    }

    if (booking.status === 'Batal' && newStatus !== 'Batal' &&
        (!booking.tanggal || !booking.waktu)) {
      return res.status(409).json({ error: 'Booking ini tidak memiliki jadwal valid untuk diaktifkan kembali' });
    }

    if (booking.status === 'Batal' && newStatus !== 'Batal' &&
        !(newStatus === 'Dikonversi' && !booking.spk_id)) {
      const updatedBooking = await db.transaction(async (connection) => {
        await lockBookingDate(connection, booking.tanggal);
        await ensureScheduleAvailable(booking.tanggal, booking.waktu, connection, bookingId);
        await db.run('UPDATE booking SET status=? WHERE id=?', [newStatus, bookingId], connection);
        return db.get('SELECT * FROM booking WHERE id=?', [bookingId], connection);
      });
      return res.json(updatedBooking);
    }

    // OTOMASI: Jika Admin memilih 'Dikonversi' dan SPK belum pernah dibuat
    if (newStatus === 'Dikonversi' && !booking.spk_id) {
      
      // 1. Generate Nomor SPK Otomatis
      const dateStr = new Date().toISOString().slice(0, 7).replace('-', ''); 
      const countQuery = await db.get('SELECT COUNT(*) as total FROM spk WHERE no_spk LIKE ?', [`SPK-${dateStr}-%`]);
      const noSpk = `SPK-${dateStr}-${String(countQuery.total + 1).padStart(3, '0')}`;

      // 2. CARI ATAU BUAT PELANGGAN BARU AGAR DATA SINKRON DI ADMIN
      let pelangganId = null;
      if (booking.telepon) {
        const p = await db.get('SELECT id, user_id FROM pelanggan WHERE telepon=?', [booking.telepon]);
        if (p) {
          pelangganId = p.id;
          // PERBAIKAN: Tautkan user_id jika sebelumnya kosong agar SPK tidak "gaib" di layar pelanggan
          if (!p.user_id && booking.user_id) {
            await db.run('UPDATE pelanggan SET user_id=? WHERE id=?', [booking.user_id, p.id]);
          }
        } else {
          // PERBAIKAN: Otomatis daftarkan pelanggan baru beserta user_id-nya
          const resP = await db.run('INSERT INTO pelanggan (user_id, nama, telepon, email, kategori) VALUES (?, ?, ?, ?, ?)', 
                                   [booking.user_id || null, booking.nama, booking.telepon, booking.email || null, 'Normal']);
          pelangganId = resP.insertId;
        }
      }

      // 3. Ambil Harga Layanan
      const layanan = await db.get('SELECT harga FROM layanan WHERE id=?', [booking.layanan_id]);
      const harga = layanan ? layanan.harga : 0;

      // 4. Buat SPK Baru secara otomatis
      const rSpk = await db.transaction(async (connection) => {
        if (booking.status === 'Batal') {
          await lockBookingDate(connection, booking.tanggal);
          await ensureScheduleAvailable(booking.tanggal, booking.waktu, connection, bookingId);
        }

        const result = await db.run(`
          INSERT INTO spk (no_spk, pelanggan_id, plat_nomor, merk_tipe, layanan_id, harga, total, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Menunggu')
        `, [noSpk, pelangganId, booking.plat_nomor, booking.merk_tipe, booking.layanan_id, harga, harga], connection);

        for (const [urutan, item] of defaultChecklist().entries()) {
          await db.run('INSERT INTO spk_checklist (spk_id, item, urutan) VALUES (?, ?, ?)', [result.insertId, item, urutan], connection);
        }

        await db.run('UPDATE booking SET status=?, spk_id=? WHERE id=?', [newStatus, result.insertId, bookingId], connection);
        return result;
      });
      
    } else {
      // Jika statusnya hanya Baru/Diproses/Batal
      await db.run('UPDATE booking SET status=? WHERE id=?', [newStatus, bookingId]);
    }
    
    const updatedBooking = await db.get('SELECT * FROM booking WHERE id=?', [bookingId]);
    res.json(updatedBooking);
  } catch (error) {
    next(error);
  }
});


router.post('/', auth(['pelanggan']), createBooking);
router.post('/me', auth(['pelanggan']), createBooking);

module.exports = router;
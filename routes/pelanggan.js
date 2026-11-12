const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const router = express.Router();

router.get('/', auth(['admin']), async (req, res) => {
  res.json(await db.all('SELECT * FROM pelanggan ORDER BY id DESC'));
});

router.post('/', auth(['admin']), async (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const telepon = String(req.body.telepon || '').trim();
  const email = String(req.body.email || '').trim() || null;
  const alamat = String(req.body.alamat || '').trim() || null;
  const kategori = req.body.kategori === 'B2B' ? 'B2B' : 'Normal';

  if (!nama || !telepon) {
    return res.status(400).json({ error: 'Nama dan nomor WhatsApp wajib diisi' });
  }
  if (nama.length > 150 || telepon.length > 40 || (email && email.length > 191)) {
    return res.status(400).json({ error: 'Data pelanggan melebihi batas panjang yang diizinkan' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Format email tidak valid' });
  }

  const existing = await db.get('SELECT id FROM pelanggan WHERE telepon=? LIMIT 1', [telepon]);
  if (existing) return res.status(409).json({ error: 'Nomor WhatsApp sudah terdaftar sebagai pelanggan' });

  const user = await db.get("SELECT id FROM users WHERE telepon=? AND role='pelanggan'", [telepon]);
  const result = await db.run(
    'INSERT INTO pelanggan (user_id, nama, telepon, email, alamat, kategori) VALUES (?, ?, ?, ?, ?, ?)',
    [user?.id || null, nama, telepon, email, alamat, kategori]
  );
  const pelanggan = await db.get('SELECT * FROM pelanggan WHERE id=?', [result.insertId]);
  res.status(201).json(pelanggan);
});

router.get('/me/spk', auth(['pelanggan']), async (req, res) => {
  const rows = await db.all(`
    SELECT spk.id, spk.no_spk, spk.plat_nomor, spk.merk_tipe, spk.status, spk.total,
           spk.created_at, l.nama AS layanan
    FROM spk
    LEFT JOIN layanan l ON l.id = spk.layanan_id
    LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
    WHERE p.user_id = ?
       OR (
         p.user_id IS NULL
         AND p.telepon = (SELECT telepon FROM users WHERE id = ?)
       )
    ORDER BY spk.id DESC
  `, [req.user.id, req.user.id]);
  res.json(rows);
});

router.get('/me/profile', auth(['pelanggan']), async (req, res) => {
  const profile = await db.get(`
    SELECT u.id, u.nama, u.email, u.telepon, p.alamat, p.kategori
    FROM users u
    LEFT JOIN pelanggan p ON p.user_id = u.id
    WHERE u.id=?
  `, [req.user.id]);

  if (!profile) return res.status(404).json({ error: 'Profil pelanggan tidak ditemukan' });
  res.json(profile);
});

router.put('/me/profile', auth(['pelanggan']), async (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const telepon = String(req.body.telepon || '').trim();
  const email = String(req.body.email || '').trim() || null;
  const alamat = String(req.body.alamat || '').trim() || null;

  if (!nama || !telepon) return res.status(400).json({ error: 'Nama dan nomor WhatsApp wajib diisi' });

  try {
    const profile = await db.transaction(async (connection) => {
      await db.run('UPDATE users SET nama=?, telepon=?, email=? WHERE id=?', [nama, telepon, email, req.user.id], connection);
      await db.run('UPDATE pelanggan SET nama=?, telepon=?, email=?, alamat=? WHERE user_id=?', [nama, telepon, email, alamat, req.user.id], connection);
      return db.get(`
        SELECT u.id, u.nama, u.email, u.telepon, p.alamat, p.kategori
        FROM users u LEFT JOIN pelanggan p ON p.user_id=u.id WHERE u.id=?
      `, [req.user.id], connection);
    });
    res.json(profile);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email atau nomor WhatsApp sudah digunakan' });
    throw error;
  }
});

router.get('/list', auth(['admin']), async (req, res) => {
  const rows = await db.all(`
    -- 1. Ambil data pelanggan yang sudah punya riwayat / profil lengkap
    SELECT 
      p.id, 
      COALESCE(u.nama, p.nama) AS nama, 
      COALESCE(u.telepon, p.telepon) AS telepon, 
      COALESCE(u.email, p.email) AS email, 
      p.alamat, 
      p.kategori, 
      p.created_at,
      (SELECT COUNT(*) FROM spk WHERE spk.pelanggan_id = p.id) AS total_cuci
    FROM pelanggan p
    LEFT JOIN users u ON p.user_id = u.id
    
    UNION
    
    -- 2. Ambil data user akun pelanggan yang baru mendaftar tapi belum pernah order
    SELECT 
      u.id, 
      u.nama, 
      u.telepon, 
      u.email, 
      NULL AS alamat, 
      'Normal' AS kategori, 
      u.created_at,
      0 AS total_cuci
    FROM users u
    LEFT JOIN pelanggan p ON p.user_id = u.id
    WHERE u.role = 'pelanggan' AND p.id IS NULL
    
    ORDER BY created_at DESC
  `);
  res.json(rows);
});

router.get('/me/riwayat', auth(['pelanggan']), async (req, res) => {
  const user = await db.get('SELECT id, telepon FROM users WHERE id=?', [req.user.id]);
  const telepon = user?.telepon || '';

  const spkRows = await db.all(`
    SELECT spk.id, spk.no_spk, spk.plat_nomor, spk.merk_tipe, spk.status, spk.total,
           spk.created_at, NULL AS tanggal, NULL AS waktu, l.nama AS layanan, 'spk' AS jenis
    FROM spk
    LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
    LEFT JOIN layanan l ON l.id = spk.layanan_id
    WHERE p.user_id = ?
       OR (p.user_id IS NULL AND p.telepon = ?)
  `, [req.user.id, telepon]);

  const bookingRows = await db.all(`
    SELECT b.id, CONCAT('BKG-', LPAD(b.id, 4, '0')) AS no_spk, b.plat_nomor, b.merk_tipe, b.status,
           NULL AS total, b.created_at, b.tanggal, b.waktu, l.nama AS layanan, 'booking' AS jenis
    FROM booking b
    LEFT JOIN layanan l ON l.id = b.layanan_id
    WHERE (b.user_id = ? OR (b.user_id IS NULL AND b.telepon = ?))
      AND b.spk_id IS NULL
  `, [req.user.id, telepon]);

  const merged = [...spkRows, ...bookingRows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(merged);
});
module.exports = router;
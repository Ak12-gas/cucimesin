const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { defaultChecklist } = require('../utils/helper');
const router = express.Router();

// 1. Endpoint untuk Teknisi melihat tugasnya sendiri
router.get('/me/tugas', auth(['teknisi']), async (req, res) => {
  await db.transaction(async (connection) => {
    const missingChecklist = await db.all(`
      SELECT s.id
      FROM spk s
      WHERE s.teknisi_id=?
        AND s.status IN ('Menunggu','Dikerjakan','Selesai')
        AND NOT EXISTS (SELECT 1 FROM spk_checklist c WHERE c.spk_id=s.id)
      FOR UPDATE
    `, [req.user.id], connection);

    for (const task of missingChecklist) {
      for (const [urutan, item] of defaultChecklist().entries()) {
        await db.run('INSERT INTO spk_checklist (spk_id, item, urutan) VALUES (?, ?, ?)', [task.id, item, urutan], connection);
      }
    }
  });

  const rows = await db.all(`
    SELECT spk.*, COALESCE(p.nama, m.nama_showroom) AS pelanggan,
           l.nama AS layanan_nama
    FROM spk
    LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
    LEFT JOIN mitra m ON m.id = spk.mitra_id
    LEFT JOIN layanan l ON l.id = spk.layanan_id
    WHERE spk.teknisi_id = ?
    ORDER BY CASE spk.status WHEN 'Dikerjakan' THEN 1 WHEN 'Menunggu' THEN 2 ELSE 3 END
  `, [req.user.id]);
  res.json(rows);
});

// 2. Endpoint untuk Admin memuat daftar teknisi (INI YANG SEBELUMNYA HILANG)
router.get('/list', auth(['admin']), async (req, res) => {
  const rows = await db.all(`
    SELECT id, nama, email, telepon, role, aktif, created_at
    FROM users
    WHERE role = 'teknisi'
    ORDER BY id DESC
  `);
  res.json(rows);
});

// 3. Endpoint untuk menambahkan Teknisi Baru (Admin)
router.post('/', auth(['admin']), async (req, res) => {
  const { nama, email, telepon, password, aktif } = req.body;
  if (!nama || !telepon || !password) return res.status(400).json({ error: 'Nama, telepon, dan password wajib diisi' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = await db.run(
      'INSERT INTO users (nama, email, telepon, password, role, aktif) VALUES (?, ?, ?, ?, ?, ?)', 
      [nama, email || null, telepon, hash, 'teknisi', aktif]
    );
    res.status(201).json({ id: result.insertId, message: 'Teknisi berhasil ditambahkan' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email atau telepon sudah terdaftar' });
    res.status(500).json({ error: 'Terjadi kesalahan saat menambah teknisi' });
  }
});

// 4. Endpoint untuk mengedit Teknisi (Admin)
router.put('/:id', auth(['admin']), async (req, res) => {
  const { nama, email, telepon, password, aktif } = req.body;

  if (!nama || !telepon) {
    return res.status(400).json({ error: 'Nama dan telepon wajib diisi' });
  }

  // Kolom aktif NOT NULL, jadi jangan kirim NULL
  const safeAktif = aktif === undefined || aktif === null ? 1 : (aktif ? 1 : 0);
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;

  try {
    let query = 'UPDATE users SET nama=?, email=?, telepon=?, aktif=? WHERE id=? AND role="teknisi"';
    let params = [nama, cleanEmail, telepon, safeAktif, req.params.id];

    if (password) {
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password minimal 8 karakter' });
      }
      const hash = bcrypt.hashSync(password, 10);
      query = 'UPDATE users SET nama=?, email=?, telepon=?, aktif=?, password=? WHERE id=? AND role="teknisi"';
      params = [nama, cleanEmail, telepon, safeAktif, hash, req.params.id];
    }

    const result = await db.run(query, params);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Data teknisi tidak ditemukan' });
    }
    res.json({ message: 'Data teknisi berhasil diperbarui' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email atau telepon sudah terdaftar' });
    }
    res.status(500).json({ error: 'Terjadi kesalahan saat memperbarui teknisi' });
  }
});

// 5. Endpoint untuk menghapus teknisi (Admin)
router.delete('/:id', auth(['admin']), async (req, res) => {
  const teknisiId = Number(req.params.id);
  if (!Number.isInteger(teknisiId) || teknisiId < 1) {
    return res.status(400).json({ error: 'ID teknisi tidak valid' });
  }

  const result = await db.run('DELETE FROM users WHERE id=? AND role=?', [teknisiId, 'teknisi']);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Teknisi tidak ditemukan' });
  }

  res.json({ message: 'Teknisi berhasil dihapus' });
});

module.exports = router;
const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const router = express.Router();

router.get('/', async (req, res) => {
  res.json(await db.all('SELECT * FROM layanan WHERE aktif=1 ORDER BY harga ASC'));
});

router.post('/', auth(['admin']), async (req, res) => {
  const { nama, harga, durasi_menit = 45, deskripsi } = req.body;
  const safeHarga = Number(harga);
  const safeDurasi = Number(durasi_menit);
  if (!nama || !Number.isInteger(safeHarga) || safeHarga <= 0 || !Number.isInteger(safeDurasi) || safeDurasi <= 0) {
    return res.status(400).json({ error: 'Nama, harga, dan durasi harus valid' });
  }
  const r = await db.run('INSERT INTO layanan (nama, harga, durasi_menit, deskripsi) VALUES (?,?,?,?)', [nama.trim(), safeHarga, safeDurasi, deskripsi || null]);
  res.status(201).json(await db.get('SELECT * FROM layanan WHERE id=?', [r.insertId]));
});

module.exports = router;
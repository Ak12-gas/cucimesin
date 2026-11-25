const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rate-limit');
const { writeAudit } = require('../utils/audit');
const router = express.Router();
const publicLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

router.get('/', publicLimit, async (req, res) => {
  res.json(await db.all(
    'SELECT id, nama, harga, durasi_menit, deskripsi, aktif FROM layanan WHERE aktif=1 ORDER BY harga ASC'
  ));
});

router.post('/', auth(['admin']), async (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const deskripsi = req.body.deskripsi == null ? null : String(req.body.deskripsi).trim();
  const safeHarga = Number(req.body.harga);
  const safeDurasi = Number(req.body.durasi_menit ?? 45);
  if (!nama || nama.length > 150 || !Number.isInteger(safeHarga) || safeHarga <= 0 || safeHarga > 100000000 ||
      !Number.isInteger(safeDurasi) || safeDurasi <= 0 || safeDurasi > 1440 ||
      (deskripsi && deskripsi.length > 500)) {
    return res.status(400).json({ error: 'Nama, harga, durasi, dan deskripsi tidak valid' });
  }
  const r = await db.run(
    'INSERT INTO layanan (nama, harga, durasi_menit, deskripsi) VALUES (?,?,?,?)',
    [nama, safeHarga, safeDurasi, deskripsi || null]
  );
  await writeAudit('layanan', r.insertId, 'create', req.user, { id: r.insertId, nama });
  res.status(201).json(await db.get(
    'SELECT id, nama, harga, durasi_menit, deskripsi, aktif FROM layanan WHERE id=?',
    [r.insertId]
  ));
});

module.exports = router;
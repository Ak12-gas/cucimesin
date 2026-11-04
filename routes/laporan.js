const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { toLocalDateString } = require('../utils/helper');
const router = express.Router();

router.use(auth(['admin']));

router.get('/ringkasan', async (req, res) => {
  const today = toLocalDateString();
  const dari = req.query.dari || today.slice(0, 8) + '01';
  const sampai = req.query.sampai || today;
  const isValidDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };

  if (!isValidDate(dari) || !isValidDate(sampai)) {
    return res.status(400).json({ error: 'Format periode harus YYYY-MM-DD' });
  }
  if (dari > sampai) {
    return res.status(400).json({ error: 'Tanggal awal tidak boleh melewati tanggal akhir' });
  }
  const rangeDays = (Date.parse(`${sampai}T00:00:00Z`) - Date.parse(`${dari}T00:00:00Z`)) / 86400000;
  if (rangeDays > 365) {
    return res.status(400).json({ error: 'Periode laporan maksimal satu tahun' });
  }

  const summary = await db.get(`
    SELECT COUNT(*) AS total_spk,
           SUM(status='Selesai') AS selesai,
           SUM(status='Dikerjakan') AS dikerjakan,
           SUM(status='Menunggu') AS menunggu,
           SUM(status='Batal') AS batal
    FROM spk
    WHERE DATE(created_at) BETWEEN ? AND ?
  `, [dari, sampai]);
  const dailyRows = await db.all(`
    SELECT DATE(created_at) AS tanggal, COUNT(*) AS jumlah
    FROM spk
    WHERE DATE(created_at) BETWEEN ? AND ?
    GROUP BY DATE(created_at)
    ORDER BY tanggal ASC
  `, [dari, sampai]);
  const categorySummary = await db.get(`
    SELECT SUM(CASE WHEN p.kategori='B2B' OR s.mitra_id IS NOT NULL THEN 1 ELSE 0 END) AS b2b,
           SUM(CASE WHEN p.kategori='B2B' OR s.mitra_id IS NOT NULL THEN 0 ELSE 1 END) AS normal
    FROM spk s
    LEFT JOIN pelanggan p ON p.id=s.pelanggan_id
    WHERE DATE(s.created_at) BETWEEN ? AND ?
  `, [dari, sampai]);

  const dailyByDate = new Map(dailyRows.map((row) => [String(row.tanggal).slice(0, 10), Number(row.jumlah)]));
  const harian = [];
  const cursor = new Date(`${dari}T12:00:00`);
  const lastDay = new Date(`${sampai}T12:00:00`);
  while (cursor <= lastDay) {
    const tanggal = toLocalDateString(cursor);
    harian.push({ tanggal, jumlah: dailyByDate.get(tanggal) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  res.json({
    periode: { dari, sampai },
    total_spk: Number(summary.total_spk || 0),
    selesai: Number(summary.selesai || 0),
    dikerjakan: Number(summary.dikerjakan || 0),
    menunggu: Number(summary.menunggu || 0),
    batal: Number(summary.batal || 0),
    kategori: {
      b2b: Number(categorySummary.b2b || 0),
      normal: Number(categorySummary.normal || 0)
    },
    harian
  });
});

module.exports = router;
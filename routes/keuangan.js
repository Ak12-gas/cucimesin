const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { toLocalDateString } = require('../utils/helper');
const router = express.Router();

router.use(auth(['admin']));

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getPeriod(req) {
  const today = toLocalDateString();
  const dari = req.query.dari || today.slice(0, 8) + '01';
  const sampai = req.query.sampai || today;

  if (!isValidDate(dari) || !isValidDate(sampai)) {
    return { error: 'Format periode harus YYYY-MM-DD' };
  }
  if (dari > sampai) {
    return { error: 'Tanggal awal tidak boleh melewati tanggal akhir' };
  }
  const rangeDays = (Date.parse(`${sampai}T00:00:00Z`) - Date.parse(`${dari}T00:00:00Z`)) / 86400000;
  if (rangeDays > 365) {
    return { error: 'Periode keuangan maksimal satu tahun' };
  }

  return { dari, sampai };
}

router.get('/ringkasan', async (req, res) => {
  const period = getPeriod(req);
  if (period.error) return res.status(400).json({ error: period.error });

  const masuk = Number((await db.get("SELECT COALESCE(SUM(nominal),0) v FROM transaksi WHERE tipe='masuk' AND tanggal BETWEEN ? AND ?", [period.dari, period.sampai])).v || 0);
  const keluar = Number((await db.get("SELECT COALESCE(SUM(nominal),0) v FROM transaksi WHERE tipe='keluar' AND tanggal BETWEEN ? AND ?", [period.dari, period.sampai])).v || 0);

  res.json({
    periode: { dari: period.dari, sampai: period.sampai },
    total_masuk: masuk,
    total_keluar: keluar,
    saldo: masuk - keluar
  });
});

router.get('/analisis', async (req, res) => {
  const period = getPeriod(req);
  if (period.error) return res.status(400).json({ error: period.error });

  const [daily, categories] = await Promise.all([
    db.all(`
      SELECT tanggal, tipe, SUM(nominal) AS total
      FROM transaksi
      WHERE tanggal BETWEEN ? AND ?
      GROUP BY tanggal, tipe
      ORDER BY tanggal
    `, [period.dari, period.sampai]),
    db.all(`
      SELECT tipe, COALESCE(NULLIF(TRIM(kategori), ''), 'Lainnya') AS kategori,
             SUM(nominal) AS total, COUNT(*) AS jumlah
      FROM transaksi
      WHERE tanggal BETWEEN ? AND ?
      GROUP BY tipe, COALESCE(NULLIF(TRIM(kategori), ''), 'Lainnya')
      ORDER BY tipe, total DESC
    `, [period.dari, period.sampai])
  ]);

  res.json({ periode: { dari: period.dari, sampai: period.sampai }, harian: daily, kategori: categories });
});

router.get('/transaksi', async (req, res) => {
  const period = getPeriod(req);
  if (period.error) return res.status(400).json({ error: period.error });

  res.json(await db.all(
    'SELECT * FROM transaksi WHERE tanggal BETWEEN ? AND ? ORDER BY tanggal DESC, id DESC LIMIT 100',
    [period.dari, period.sampai]
  ));
});

router.post('/transaksi', async (req, res) => {
  const kategori = String(req.body.kategori || '').trim();
  const deskripsi = String(req.body.deskripsi || '').trim();
  const nominal = Number(req.body.nominal);
  const tanggal = req.body.tanggal || toLocalDateString();

  if (!kategori || kategori.length > 100 || !deskripsi || !Number.isInteger(nominal) || nominal <= 0) {
    return res.status(400).json({ error: 'Kategori, deskripsi, dan nominal positif wajib diisi' });
  }
  if (!isValidDate(tanggal) || tanggal > toLocalDateString()) {
    return res.status(400).json({ error: 'Tanggal transaksi tidak valid' });
  }

  const result = await db.run(
    "INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, tanggal) VALUES ('keluar', ?, ?, ?, ?)",
    [kategori, deskripsi, nominal, tanggal]
  );
  const transaction = await db.get('SELECT * FROM transaksi WHERE id=?', [result.insertId]);
  res.status(201).json(transaction);
});

module.exports = router;
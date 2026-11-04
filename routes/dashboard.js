const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const { toLocalDateString } = require('../utils/helper');
const router = express.Router();

router.use(auth(['admin']));

// 1. STATISTIK: Gabungkan total SPK dan Booking yang belum dikonversi
router.get('/stats', async (req, res) => {
  const today = toLocalDateString();
  const yesterday = toLocalDateString(new Date(Date.now() - 86400000));

  const totalHariIni = (await db.get(`
    SELECT 
      (SELECT COUNT(*) FROM spk WHERE DATE(created_at)=?) + 
      (SELECT COUNT(*) FROM booking WHERE DATE(created_at)=? AND spk_id IS NULL) AS c
  `, [today, today])).c;
  
  const totalKemarin = (await db.get(`
    SELECT 
      (SELECT COUNT(*) FROM spk WHERE DATE(created_at)=?) + 
      (SELECT COUNT(*) FROM booking WHERE DATE(created_at)=? AND spk_id IS NULL) AS c
  `, [yesterday, yesterday])).c;
  
  const dikerjakan = (await db.get("SELECT COUNT(*) c FROM spk WHERE status='Dikerjakan'")).c;
  const selesaiHariIni = (await db.get("SELECT COUNT(*) c FROM spk WHERE status='Selesai' AND DATE(waktu_selesai)=?", [today])).c;
  const teknisiAktif = (await db.get("SELECT COUNT(*) c FROM users WHERE role='teknisi' AND aktif=1")).c;
  const revenueHariIni = (await db.get("SELECT COALESCE(SUM(nominal),0) v FROM transaksi WHERE tipe='masuk' AND tanggal=?", [today])).v;
  const delta = totalKemarin > 0 ? Math.round(((totalHariIni - totalKemarin) / totalKemarin) * 100) : 0;

  res.json({
    total_order: totalHariIni,
    total_order_delta_persen: delta,
    dalam_pengerjaan: dikerjakan,
    teknisi_standby: teknisiAktif,
    selesai_hari_ini: selesaiHariIni,
    revenue_hari_ini: revenueHariIni
  });
});

// 2. ANTRIAN: Gabungkan Antrean SPK dan Booking Baru
router.get('/antrian', async (req, res) => {
  const rows = await db.all(`
    SELECT * FROM (
      -- Data Kendaraan dari SPK (Sudah masuk antrean resmi bengkel)
      SELECT spk.id, spk.no_spk, spk.plat_nomor, spk.status, spk.created_at, spk.waktu_mulai,
             COALESCE(p.nama, m.nama_showroom) AS pelanggan,
             p.kategori AS kategori,
             l.nama AS layanan,
             u.nama AS teknisi
      FROM spk
      LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
      LEFT JOIN mitra m ON m.id = spk.mitra_id
      LEFT JOIN layanan l ON l.id = spk.layanan_id
      LEFT JOIN users u ON u.id = spk.teknisi_id
      WHERE spk.status IN ('Menunggu','Dikerjakan')

      UNION ALL

      -- Data Kendaraan dari Booking Online (Belum datang / Belum dikonversi)
      SELECT b.id, CONCAT('BKG-', LPAD(b.id, 4, '0')) AS no_spk, b.plat_nomor, b.status, b.created_at, NULL AS waktu_mulai,
             b.nama AS pelanggan,
             'Normal' AS kategori,
             l.nama AS layanan,
             '-' AS teknisi
      FROM booking b
      LEFT JOIN layanan l ON l.id = b.layanan_id
      WHERE b.status IN ('Baru', 'Diproses')
    ) AS gabungan
    ORDER BY 
      CASE status 
        WHEN 'Dikerjakan' THEN 1 
        WHEN 'Menunggu' THEN 2 
        WHEN 'Diproses' THEN 3 
        WHEN 'Baru' THEN 4 
        ELSE 5 
      END, 
      created_at ASC
  `);
  res.json(rows);
});

// 3. TREN GRAFIK: Gabungkan grafik pemesanan SPK dan Booking 7 hari terakhir
router.get('/tren', async (req, res) => {
  const rows = await db.all(`
    SELECT tgl, SUM(jumlah) AS jumlah FROM (
      SELECT DATE(created_at) AS tgl, COUNT(*) AS jumlah
      FROM spk
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(created_at)
      
      UNION ALL
      
      SELECT DATE(created_at) AS tgl, COUNT(*) AS jumlah
      FROM booking
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND spk_id IS NULL
      GROUP BY DATE(created_at)
    ) AS gabungan_tren
    GROUP BY tgl
    ORDER BY tgl ASC
  `);

  const result = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = toLocalDateString(d);
    const found = rows.find(r => String(r.tgl).slice(0, 10) === key);
    result.push({ tanggal: key, jumlah: found ? Number(found.jumlah) : 0 });
  }

  const total = result.reduce((a, b) => a + b.jumlah, 0);
  const avg = Math.round(total / 7);
  const max = result.reduce((a, b) => (b.jumlah > a.jumlah ? b : a), result[0]);

  res.json({ harian: result, rata_rata_harian: avg, hari_tersibuk: max });
});

module.exports = router;
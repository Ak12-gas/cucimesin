const db = require('../db/database');

async function loadSpk(req, res, next) {
  const spk = await db.get(`
    SELECT spk.*, 
           COALESCE(p.nama, m.nama_showroom) AS pelanggan,
           p.kategori, p.telepon AS pelanggan_telepon, p.email AS pelanggan_email,
           l.nama AS layanan_nama, l.durasi_menit,
           u.nama AS teknisi_nama
    FROM spk
    LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
    LEFT JOIN mitra m ON m.id = spk.mitra_id
    LEFT JOIN layanan l ON l.id = spk.layanan_id
    LEFT JOIN users u ON u.id = spk.teknisi_id
    WHERE spk.id = ?
  `, [req.params.id]);

  if (!spk) {
    return res.status(404).json({ error: 'SPK tidak ditemukan' });
  }

  req.spk = spk;
  next();
}

async function authorizeSpk(req, res, next) {
  const { spk, user } = req;

  if (!user) {
    return res.status(401).json({ error: 'Token diperlukan' });
  }

  if (user.role === 'admin') {
    return next();
  }

  if (user.role === 'teknisi') {
    if (spk.teknisi_id !== user.id) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke SPK ini' });
    }
    return next();
  }

  if (user.role === 'pelanggan') {
    const pelanggan = await db.get(`
      SELECT p.id
      FROM pelanggan p
      WHERE p.id = ?
        AND (
          p.user_id = ?
          OR (
            p.user_id IS NULL
            AND p.telepon = (SELECT telepon FROM users WHERE id = ?)
          )
        )
    `, [spk.pelanggan_id, user.id, user.id]);

    if (!pelanggan || pelanggan.id !== spk.pelanggan_id) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke SPK ini' });
    }

    return next();
  }

  if (user.role === 'mitra') {
    if (spk.mitra_id !== user.mitra_id) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke SPK ini' });
    }

    return next();
  }

  return res.status(403).json({ error: 'Akses ditolak' });
}

module.exports = { loadSpk, authorizeSpk };

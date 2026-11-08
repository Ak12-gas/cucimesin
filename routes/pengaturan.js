const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const router = express.Router();

// Key yang aman ditampilkan ke publik (website tanpa login).
// Sengaja dibatasi (whitelist) supaya key sensitif di tabel pengaturan
// (mis. harga dasar, persentase diskon internal) tidak ikut bocor.
const PUBLIC_KEYS = ['nama_bisnis','tagline','kontak','email','alamat','website','brand_blue','brand_red','font_family','garansi_text'];

router.get('/publik', async (req, res) => {
  const rows = await db.all(
    `SELECT \`key\`, \`value\` FROM pengaturan WHERE \`key\` IN (${PUBLIC_KEYS.map(() => '?').join(',')})`,
    PUBLIC_KEYS
  );
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  res.json(obj);
});

router.get('/', auth(['admin']), async (req, res) => {
  const rows = await db.all('SELECT `key`, `value` FROM pengaturan');
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  res.json(obj);
});

router.put('/', auth(['admin']), async (req, res) => {
  await db.transaction(async (connection) => {
    for (const [k, v] of Object.entries(req.body)) {
      await db.run('INSERT INTO pengaturan (`key`, `value`) VALUES (?,?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', [k, String(v)], connection);
    }
  });
  res.json({ message: 'Tersimpan' });
});

module.exports = router;
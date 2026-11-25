const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rate-limit');
const { writeAudit } = require('../utils/audit');
const router = express.Router();
const publicLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

// Key yang aman ditampilkan ke publik (website tanpa login).
// Sengaja dibatasi (whitelist) supaya key sensitif di tabel pengaturan
// (mis. harga dasar, persentase diskon internal) tidak ikut bocor.
const PUBLIC_KEYS = ['nama_bisnis','tagline','kontak','email','alamat','website','brand_blue','brand_red','font_family','garansi_text'];
const ADMIN_WRITABLE_KEYS = new Set([
  ...PUBLIC_KEYS,
  'positioning',
  'harga_reguler',
  'diskon_b2b_persen',
  'garansi_text',
  'logo_url',
  'jam_operasional',
  'whatsapp',
  'instagram',
  'facebook',
  'maps_url'
]);
const MAX_VALUE_LENGTH = 2000;

function normalizePengaturanBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Payload pengaturan tidak valid' };
  }
  const entries = Object.entries(body);
  if (entries.length === 0) return { error: 'Tidak ada pengaturan yang dikirim' };
  if (entries.length > ADMIN_WRITABLE_KEYS.size) return { error: 'Terlalu banyak key pengaturan' };

  const normalized = [];
  for (const [key, rawValue] of entries) {
    if (!ADMIN_WRITABLE_KEYS.has(key)) {
      return { error: `Key pengaturan tidak diizinkan: ${key}` };
    }
    if (rawValue !== null && rawValue !== undefined && typeof rawValue === 'object') {
      return { error: `Nilai pengaturan tidak valid: ${key}` };
    }
    const value = String(rawValue ?? '').trim();
    if (value.length > MAX_VALUE_LENGTH) {
      return { error: `Nilai pengaturan terlalu panjang: ${key}` };
    }
    normalized.push([key, value]);
  }
  return { entries: normalized };
}

router.get('/publik', publicLimit, async (req, res) => {
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
  const { entries, error } = normalizePengaturanBody(req.body);
  if (error) return res.status(400).json({ error });

  await db.transaction(async (connection) => {
    for (const [k, v] of entries) {
      await db.run(
        'INSERT INTO pengaturan (`key`, `value`) VALUES (?,?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"',
        [k, v],
        connection
      );
    }
    await writeAudit('pengaturan', null, 'update', req.user, { keys: entries.map(([k]) => k) }, connection);
  });
  res.json({ message: 'Tersimpan' });
});

module.exports = router;
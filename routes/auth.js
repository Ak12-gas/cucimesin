const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rate-limit');
const { signUser } = require('../utils/security');
const router = express.Router();

const publicAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Normalisasi identifier: email → lowercase, telepon → 0xxx
function normalizeIdentifier(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw.toLowerCase();

  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  if (digits.startsWith('62')) return '0' + digits.slice(2);
  if (digits.startsWith('8')) return '0' + digits.slice(1);
  return digits;
}

function publicUser(u) {
  return { id: u.id, nama: u.nama, email: u.email, telepon: u.telepon, role: u.role, mitra_id: u.mitra_id || null };
}

router.post('/login', publicAuthLimit, async (req, res, next) => {
  const identifier = normalizeIdentifier(req.body.identifier);
  const { password, role } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Identifier & password wajib' });

  let user;
  if (role) {
    user = await db.get(
      'SELECT * FROM users WHERE (email=? OR telepon=?) AND role=?',
      [identifier, identifier, role]
    );
  } else {
    user = await db.get(
      'SELECT * FROM users WHERE email=? OR telepon=?',
      [identifier, identifier]
    );
  }

  if (!user) return res.status(401).json({ error: 'Akun tidak ditemukan' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Password salah' });
  if (!user.aktif) return res.status(403).json({ error: 'Akun dinonaktifkan' });

  res.json({ token: signUser(user), user: publicUser(user) });
});

router.post('/register', publicAuthLimit, async (req, res) => {
  const { nama, email, password } = req.body;
  const telepon = normalizeIdentifier(req.body.telepon);
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;

  if (!nama || !telepon || !password) return res.status(400).json({ error: 'Data tidak lengkap' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Format email tidak valid' });
  }

  const dup = await db.get(
    'SELECT id FROM users WHERE telepon=? OR (email IS NOT NULL AND email=?)',
    [telepon, cleanEmail || '']
  );
  if (dup) return res.status(409).json({ error: 'Nomor/email sudah terdaftar' });

  const hash = bcrypt.hashSync(password, 10);
  const user = await db.transaction(async (connection) => {
    const result = await db.run(
      'INSERT INTO users (nama, telepon, email, password, role) VALUES (?,?,?,?,?)',
      [nama, telepon, cleanEmail, hash, 'pelanggan'], connection
    );
    await db.run(
      'INSERT INTO pelanggan (user_id, nama, telepon, email, kategori) VALUES (?,?,?,?,?)',
      [result.insertId, nama, telepon, cleanEmail, 'Normal'], connection
    );
    return db.get('SELECT * FROM users WHERE id=?', [result.insertId], connection);
  });

  res.status(201).json({ token: signUser(user), user: publicUser(user) });
});

router.get('/me', auth(), async (req, res) => {
  const user = await db.get(
    'SELECT id, nama, email, telepon, role, mitra_id FROM users WHERE id=?',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json(user);
});

router.put('/password', auth(['pelanggan','teknisi','mitra','admin']), async (req, res) => {
  const { password_lama, password_baru } = req.body;
  if (!password_lama || typeof password_baru !== 'string' || password_baru.length < 8) {
    return res.status(400).json({ error: 'Password lama wajib diisi, password baru minimal 8 karakter' });
  }
  const user = await db.get('SELECT password FROM users WHERE id=?', [req.user.id]);
  if (!user || !bcrypt.compareSync(password_lama, user.password)) {
    return res.status(400).json({ error: 'Password lama salah' });
  }
  await db.run('UPDATE users SET password=? WHERE id=?',
    [bcrypt.hashSync(password_baru, 10), req.user.id]);
  res.json({ message: 'Password berhasil diperbarui' });
});

module.exports = router;
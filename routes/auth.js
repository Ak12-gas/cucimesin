const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rate-limit');
const { signUser } = require('../utils/security');
const { toAppDateTime, parseAppDateTime } = require('../utils/timezone');
const router = express.Router();

const publicAuthLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const passwordResetLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

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

// Token reset disimpan sebagai hash, dikirim lewat kanal transport yang
// dikonfigurasi (dev mengembalikan dev_token untuk uji alur).
router.post('/forgot-password', passwordResetLimit, async (req, res) => {
  const identifier = normalizeIdentifier(req.body.identifier);
  if (!identifier) return res.status(400).json({ error: 'Nomor WhatsApp atau email wajib diisi' });

  const user = await db.get('SELECT id, aktif FROM users WHERE email=? OR telepon=?', [identifier, identifier]);
  let devToken = null;
  if (user && Number(user.aktif) !== 0) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = toAppDateTime(new Date(Date.now() + RESET_TOKEN_TTL_MS));
    await db.run(
      'INSERT INTO password_reset (user_id, token_hash, expires_at) VALUES (?,?,?)',
      [user.id, hashResetToken(token), expiresAt]
    );

    if (process.env.RESET_WEBHOOK_URL) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.RESET_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${process.env.RESET_WEBHOOK_TOKEN}`;
        const response = await fetch(process.env.RESET_WEBHOOK_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({ identifier, token, expires_at: expiresAt }),
          signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
          console.error(`[AUTH] webhook reset menolak permintaan: ${response.status}`);
        }
      } catch (error) {
        console.error('[AUTH] gagal mengirim token reset:', error.message);
      }
    }
    if (process.env.NODE_ENV !== 'production') devToken = token;
  }

  // Pesan generik agar tidak membocorkan keberadaan akun.
  const response = { message: 'Jika akun ditemukan, instruksi reset telah dikirim.' };
  if (devToken) response.dev_token = devToken;
  res.json(response);
});

router.post('/reset-password', passwordResetLimit, async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = req.body.password;
  if (!token || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Token dan password baru (minimal 8 karakter) wajib diisi' });
  }

  const tokenHash = hashResetToken(token);
  await db.transaction(async (connection) => {
    const record = await db.get(
      'SELECT id, user_id, expires_at, used_at FROM password_reset WHERE token_hash=?',
      [tokenHash], connection
    );
    const expiresAt = record ? parseAppDateTime(record.expires_at) : null;
    if (!record || record.used_at !== null || !expiresAt || expiresAt.getTime() <= Date.now()) {
      throw httpError(400, 'Token reset tidak valid atau sudah kedaluarsa');
    }

    // Klaim token secara atomik supaya tidak bisa dipakai dua kali.
    const claimed = await db.get(
      'UPDATE password_reset SET used_at=CURRENT_TIMESTAMP WHERE token_hash=? AND used_at IS NULL RETURNING user_id',
      [tokenHash], connection
    );
    if (!claimed) throw httpError(400, 'Token reset sudah dipakai');

    await db.run('UPDATE users SET password=? WHERE id=?',
      [bcrypt.hashSync(password, 10), claimed.user_id], connection);
    await db.run('UPDATE password_reset SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL',
      [claimed.user_id], connection);
  });

  res.json({ message: 'Password berhasil direset. Silakan masuk dengan kata sandi baru.' });
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
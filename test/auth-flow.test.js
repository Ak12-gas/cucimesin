process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
require('express-async-errors');
const express = require('express');
const bcrypt = require('bcryptjs');

const users = [];
const pelanggan = [];
const resets = [];
let nextUserId = 1;
let nextResetId = 1;

function findUser(identifier, role) {
  return users.find((user) =>
    (user.email === identifier || user.telepon === identifier) && (!role || user.role === role)
  ) || null;
}

const fakeDb = {
  async get(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (query.includes('FROM users WHERE (email=? OR telepon=?) AND role=?')) {
      return findUser(params[0], params[2]);
    }
    if (query.includes('FROM users WHERE email=? OR telepon=?')) {
      return findUser(params[0]);
    }
    if (query.includes('FROM users WHERE id=?') || query.includes('FROM users WHERE id=?')) {
      return users.find((user) => user.id === Number(params[0])) || null;
    }
    if (query.includes('FROM users WHERE telepon=? OR')) {
      return users.find((user) => user.telepon === params[0] || user.email === params[1]) || null;
    }
    if (query.includes('FROM password_reset WHERE token_hash=?')) {
      return resets.find((reset) => reset.token_hash === params[0]) || null;
    }
    if (query.startsWith('UPDATE password_reset SET used_at=CURRENT_TIMESTAMP WHERE token_hash=?')) {
      const reset = resets.find((item) => item.token_hash === params[0] && item.used_at === null);
      if (!reset) return null;
      reset.used_at = '2026-11-23 10:00:00';
      return { user_id: reset.user_id };
    }
    return null;
  },
  async all() {
    return [];
  },
  async run(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (query.startsWith('INSERT INTO users')) {
      const user = {
        id: nextUserId++,
        nama: params[0],
        telepon: params[1],
        email: params[2],
        password: params[3],
        role: params[4],
        aktif: 1
      };
      users.push(user);
      return { insertId: user.id, rowCount: 1 };
    }
    if (query.startsWith('INSERT INTO pelanggan')) {
      pelanggan.push({
        id: pelanggan.length + 1,
        user_id: params[0],
        nama: params[1],
        telepon: params[2],
        email: params[3],
        kategori: params[4]
      });
      return { insertId: pelanggan.length, rowCount: 1 };
    }
    if (query.startsWith('INSERT INTO password_reset')) {
      const reset = {
        id: nextResetId++,
        user_id: params[0],
        token_hash: params[1],
        expires_at: params[2],
        used_at: null
      };
      resets.push(reset);
      return { insertId: reset.id, rowCount: 1 };
    }
    if (query.startsWith('UPDATE users SET password=? WHERE id=?')) {
      const user = users.find((item) => item.id === Number(params[1]));
      if (user) user.password = params[0];
      return { rowCount: user ? 1 : 0 };
    }
    if (query.startsWith('UPDATE password_reset SET used_at=CURRENT_TIMESTAMP WHERE user_id=?')) {
      for (const reset of resets) {
        if (reset.user_id === Number(params[0]) && reset.used_at === null) {
          reset.used_at = '2026-11-23 10:00:00';
        }
      }
      return { rowCount: 1 };
    }
    return { insertId: 0, rowCount: 0 };
  },
  async transaction(callback) {
    const usedAt = resets.map((reset) => reset.used_at);
    const passwords = users.map((user) => user.password);
    try {
      return await callback({});
    } catch (error) {
      resets.forEach((reset, index) => { reset.used_at = usedAt[index]; });
      users.forEach((user, index) => { user.password = passwords[index]; });
      throw error;
    }
  }
};

const dbPath = require.resolve('../db/database');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb
};

const app = express();
app.use(express.json());
app.use('/api/auth', require('../routes/auth'));
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
});

let server;
test.before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function call(path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('register membuat user pelanggan dan token', async () => {
  const result = await call('/api/auth/register', {
    nama: 'Pelanggan Uji',
    telepon: '081234567890',
    email: 'uji@example.com',
    password: 'rahasia123'
  });

  assert.equal(result.status, 201);
  assert.ok(result.body.token);
  assert.equal(result.body.user.role, 'pelanggan');
  assert.equal(pelanggan.length, 1);
  assert.equal(pelanggan[0].user_id, users[0].id);
});

test('login menerima nomor dengan prefix 62', async () => {
  const result = await call('/api/auth/login', {
    identifier: '6281234567890',
    password: 'rahasia123'
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.token);
});

test('alur lupa password → reset → login dengan sandi baru', async () => {
  const forgot = await call('/api/auth/forgot-password', { identifier: 'uji@example.com' });
  assert.equal(forgot.status, 200);
  assert.match(forgot.body.message, /Jika akun ditemukan/);
  assert.ok(forgot.body.dev_token, 'mode test harus mengembalikan dev_token');
  assert.equal(resets.length, 1);
  assert.notEqual(resets[0].token_hash, forgot.body.dev_token);

  const reset = await call('/api/auth/reset-password', {
    token: forgot.body.dev_token,
    password: 'sangatbaru123'
  });
  assert.equal(reset.status, 200);
  assert.ok(resets[0].used_at);
  assert.equal(bcrypt.compareSync('sangatbaru123', users[0].password), true);

  const login = await call('/api/auth/login', {
    identifier: '081234567890',
    password: 'sangatbaru123'
  });
  assert.equal(login.status, 200);

  const reuse = await call('/api/auth/reset-password', {
    token: forgot.body.dev_token,
    password: 'lain123456'
  });
  assert.equal(reuse.status, 400);
  assert.match(reuse.body.error, /tidak valid|sudah kedaluarsa|sudah dipakai/);
});

test('forgot-password tidak membocorkan akun yang tidak ada', async () => {
  const result = await call('/api/auth/forgot-password', { identifier: 'tidakada@example.com' });
  assert.equal(result.status, 200);
  assert.equal(result.body.dev_token, undefined);
  assert.equal(resets.length, 1);
});

test('login gagal tidak membedakan akun tidak ditemukan dan password salah', async () => {
  const missing = await call('/api/auth/login', { identifier: 'tidakada@example.com', password: 'salah123' });
  const wrong = await call('/api/auth/login', { identifier: 'uji@example.com', password: 'salah123' });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(missing.body, wrong.body);
});

process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';

const test = require('node:test');
const assert = require('node:assert/strict');
require('express-async-errors');
const express = require('express');
const { toAppDate } = require('../utils/timezone');

const inserts = [];

const fakeDb = {
  async get() {
    return { v: 0 };
  },
  async all() {
    return [];
  },
  async run(sql, params = []) {
    inserts.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { insertId: 99, rowCount: 1 };
  }
};

const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: () => (req, _res, next) => {
    req.user = { id: 1, role: 'admin' };
    next();
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
app.use('/api/keuangan', require('../routes/keuangan'));
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

async function call(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  return { status: response.status, body: await response.json() };
}

function jsonPost(path, body) {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('periode keuangan menolak tanggal dan rentang tidak valid', async () => {
  const invalidDate = await call('/api/keuangan/ringkasan?dari=2026-02-30&sampai=2026-03-31');
  assert.equal(invalidDate.status, 400);
  assert.match(invalidDate.body.error, /YYYY-MM-DD/);

  const inverted = await call('/api/keuangan/ringkasan?dari=2026-11-30&sampai=2026-11-01');
  assert.equal(inverted.status, 400);
  assert.match(inverted.body.error, /tidak boleh melewati/);

  const tooLong = await call('/api/keuangan/ringkasan?dari=2025-01-01&sampai=2026-11-23');
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /maksimal satu tahun/);
});

test('transaksi baru memakai tanggal WIB hari ini sebagai default', async () => {
  const result = await jsonPost('/api/keuangan/transaksi', {
    kategori: 'Uji',
    deskripsi: 'Transaksi uji',
    nominal: 25000
  });

  assert.equal(result.status, 201);
  const last = inserts.at(-1);
  assert.match(last.sql, /INSERT INTO transaksi/);
  assert.equal(last.params[3], toAppDate());
});

test('transaksi dengan tanggal masa depan ditolak', async () => {
  const result = await jsonPost('/api/keuangan/transaksi', {
    kategori: 'Uji',
    deskripsi: 'Transaksi uji',
    nominal: 25000,
    tanggal: '2099-01-01'
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /Tanggal transaksi tidak valid/);
});

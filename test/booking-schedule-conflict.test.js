process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');

const TANGGAL = '2027-01-15';
const WAKTU = '10:00';

const users = {
  3: { id: 3, nama: 'Pelanggan', email: 'p@test', telepon: '081100000003', role: 'pelanggan', mitra_id: null, aktif: 1 },
  4: { id: 4, nama: 'Mitra', email: 'm@test', telepon: '081100000004', role: 'mitra', mitra_id: 1, aktif: 1 }
};
const layanan = { id: 1, aktif: 1 };
const armada = { id: 1, mitra_id: 1, aktif: 1 };

let customerBookings = [];
let mitraBookings = [];

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeDb = {
  async get(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.includes('FROM users WHERE id=?')) return users[Number(params[0])] || null;
    if (q.includes('FROM layanan WHERE id=?')) return layanan;
    if (q.includes('FROM booking_schedule_lock')) return { tanggal: params[0] };
    if (q.includes('FROM booking_armada')) return mitraBookings[0] || null;
    if (q.includes('FROM booking')) return customerBookings[0] || null;
    return { v: 0 };
  },
  async all(sql) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.includes('FROM armada')) return [armada];
    return [];
  },
  async run(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO booking_armada (')) {
      const row = { id: mitraBookings.length + 1, mitra_id: params[0], tanggal: params[2], waktu: params[3], status: 'Baru' };
      mitraBookings.push(row);
      return { insertId: row.id, rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO booking (')) {
      const row = { id: customerBookings.length + 1, tanggal: params[7], waktu: params[8], status: 'Baru' };
      customerBookings.push(row);
      return { insertId: row.id, rowCount: 1 };
    }
    return { insertId: 1, rowCount: 1 };
  },
  async transaction(callback) {
    return callback({});
  }
};

stub('../db/database', fakeDb);
stub('../services/pdfservice', { generateMitraInvoicePdf: async () => Buffer.from('%PDF-1.4') });

const app = express();
app.use(express.json());
app.use('/api/booking', require('../routes/booking'));
app.use('/api/mitra', require('../routes/mitra'));
app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
});

function token(user) {
  return jwt.sign({ id: user.id, role: user.role, mitra_id: user.mitra_id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function call(path, user, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

let server;
test.before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  customerBookings = [];
  mitraBookings = [];
});

test('booking mitra menolak slot yang sudah dipesan pelanggan', async () => {
  customerBookings = [{ id: 1, tanggal: TANGGAL, waktu: WAKTU, status: 'Baru' }];

  const result = await call('/api/mitra/me/bookings', users[4], {
    layanan_id: 1, armada_ids: [1], tanggal: TANGGAL, waktu: WAKTU
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /sudah dipesan/i);
  assert.equal(mitraBookings.length, 0);
});

test('booking pelanggan menolak slot yang sudah dipesan mitra', async () => {
  mitraBookings = [{ id: 1, mitra_id: 1, tanggal: TANGGAL, waktu: WAKTU, status: 'Baru' }];

  const result = await call('/api/booking', users[3], {
    nama: 'Pelanggan', telepon: '081100000003', plat_nomor: 'B 1234 ABC',
    layanan_id: 1, tanggal: TANGGAL, waktu: WAKTU
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /sudah dipesan/i);
  assert.equal(customerBookings.length, 0);
});

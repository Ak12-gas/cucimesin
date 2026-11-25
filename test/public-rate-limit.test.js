process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
require('express-async-errors');

const hits = new Map();
const MAX = 2;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Limiter palsu: hanya membuktikan wiring, bukan algoritma rate-limit.
stub('../middleware/rate-limit', function fakeRateLimit() {
  return async (req, res, next) => {
    const key = `${req.baseUrl}${req.path}`;
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (count > MAX) return res.status(429).json({ error: 'rate limited' });
    return next();
  };
});
stub('../middleware/auth', () => (req, res, next) => next());
stub('../db/database', {
  all: async () => [],
  get: async () => null,
  run: async () => ({ insertId: 1, rowCount: 1 }),
  transaction: async (callback) => callback({})
});

const app = express();
app.use(express.json());
app.use('/api/booking', require('../routes/booking'));
app.use('/api/layanan', require('../routes/layanan'));
app.use('/api/pengaturan', require('../routes/pengaturan'));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return response.status;
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

const endpoints = [
  ['slot booking', 'GET', '/api/booking/availability?date=2027-01-15', undefined, 200],
  ['daftar layanan', 'GET', '/api/layanan', undefined, 200],
  ['pengaturan publik', 'GET', '/api/pengaturan/publik', undefined, 200],
  ['buat booking', 'POST', '/api/booking', {}, 400]
];

for (const [label, method, path, body, expected] of endpoints) {
  test(`${label} terkena rate limit`, async () => {
    hits.clear();
    const statuses = [];
    for (let i = 0; i <= MAX; i += 1) statuses.push(await call(method, path, body));
    assert.deepEqual(statuses, [expected, expected, 429]);
  });
}

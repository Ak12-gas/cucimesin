process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('express-async-errors');
const express = require('express');

const users = [
  { id: 1, email: 'webhook@example.com', telepon: '081100000001', aktif: 1 },
  { id: 2, email: 'webhook2@example.com', telepon: '081100000002', aktif: 1 }
];
const resets = [];

const fakeDb = {
  async get(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (query.includes('FROM users WHERE email=? OR telepon=?')) {
      return users.find((user) => user.email === params[0] || user.telepon === params[1]) || null;
    }
    if (query.includes('FROM password_reset WHERE token_hash=?')) {
      return resets.find((reset) => reset.token_hash === params[0]) || null;
    }
    return null;
  },
  async all() {
    return [];
  },
  async run(sql, params = []) {
    if (sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO password_reset')) {
      const reset = {
        id: resets.length + 1,
        user_id: params[0],
        token_hash: params[1],
        expires_at: params[2],
        used_at: null
      };
      resets.push(reset);
      return { insertId: reset.id, rowCount: 1 };
    }
    return { insertId: 0, rowCount: 0 };
  },
  async transaction(callback) {
    return callback({});
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
let webhook;
let webhookCalls = [];
let webhookStatus = 200;
let webhookUrl;

test.before(async () => {
  webhook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      webhookCalls.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      });
      res.writeHead(webhookStatus, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => webhook.listen(0, '127.0.0.1', resolve));
  webhookUrl = `http://127.0.0.1:${webhook.address().port}/reset`;

  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (webhook) await new Promise((resolve) => webhook.close(resolve));
});

async function forgot(identifier) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier })
  });
  return { status: response.status, body: await response.json() };
}

test('webhook reset menerima token, identifier, dan header otorisasi', async () => {
  webhookCalls = [];
  webhookStatus = 200;
  process.env.RESET_WEBHOOK_URL = webhookUrl;
  process.env.RESET_WEBHOOK_TOKEN = 'webhook-secret';

  const result = await forgot('webhook@example.com');

  assert.equal(result.status, 200);
  assert.ok(result.body.dev_token);
  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].authorization, 'Bearer webhook-secret');
  assert.deepEqual(Object.keys(webhookCalls[0].body).sort(), ['expires_at', 'identifier', 'token']);
  assert.equal(webhookCalls[0].body.identifier, 'webhook@example.com');
  assert.equal(webhookCalls[0].body.token, result.body.dev_token);
  assert.match(webhookCalls[0].body.expires_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('webhook yang menolak tidak menggagal respons forgot-password', async () => {
  webhookCalls = [];
  webhookStatus = 500;
  const originalError = console.error;
  console.error = () => {};

  try {
    const result = await forgot('webhook2@example.com');
    assert.equal(result.status, 200);
    assert.match(result.body.message, /Jika akun ditemukan/);
    assert.equal(webhookCalls.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('tanpa webhook, alur tetap generik dan menyimpan token', async () => {
  webhookCalls = [];
  delete process.env.RESET_WEBHOOK_URL;
  delete process.env.RESET_WEBHOOK_TOKEN;

  const result = await forgot('webhook@example.com');

  assert.equal(result.status, 200);
  assert.ok(result.body.dev_token);
  assert.equal(webhookCalls.length, 0);
  assert.equal(resets.length, 3);
});

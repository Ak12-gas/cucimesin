process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let dbHealthy = true;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../db/database', {
  async get(sql) {
    if (!sql.includes('SELECT 1')) return null;
    if (!dbHealthy) throw new Error('rahasia-db-down');
    return { ok: 1 };
  },
  async all() { return []; },
  async run() { return { insertId: 1, rowCount: 1 }; },
  async transaction(callback) { return callback({}); }
});
stub('../services/storage', { isRemoteConfigured: () => false, upload: async () => '', download: async () => Buffer.alloc(0) });
stub('../services/pdfservice', { generateSPKPdf: async () => Buffer.alloc(0), generateMitraInvoicePdf: async () => Buffer.alloc(0) });

function fakeUpload() {
  return (req, _res, next) => next();
}
fakeUpload.single = fakeUpload;
fakeUpload.array = fakeUpload;
fakeUpload.fields = fakeUpload;
fakeUpload.any = fakeUpload;
fakeUpload.uploadDir = path.join(__dirname, '..', 'uploads');
stub('../middleware/upload', fakeUpload);

const { createApp } = require('../server');
const app = createApp();

async function health() {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
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

test('health mengembalikan 200 saat SELECT 1 berhasil', async () => {
  dbHealthy = true;
  const result = await health();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ok');
  assert.equal(result.body.db, 'ok');
});

test('health mengembalikan 503 tanpa membocorkan error saat DB gagal', async () => {
  dbHealthy = false;
  try {
    const result = await health();
    assert.equal(result.status, 503);
    assert.equal(result.body.status, 'error');
    assert.ok(!JSON.stringify(result.body).includes('rahasia-db-down'));
  } finally {
    dbHealthy = true;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(resolvedPath, exports) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
  return () => {
    if (previous) require.cache[resolvedPath] = previous;
    else delete require.cache[resolvedPath];
  };
}

async function withApp(db, run) {
  const dbPath = require.resolve('../db/database');
  const authPath = require.resolve('../middleware/auth');
  const uploadPath = require.resolve('../middleware/upload');
  const storagePath = require.resolve('../services/storage');
  const routePath = require.resolve('../routes/pembayaran');
  delete require.cache[routePath];

  const restores = [
    stubModule(dbPath, db),
    stubModule(storagePath, { upload: async () => {}, download: async () => Buffer.from(''), remove: async () => {}, toObjectPath: (v) => v, contentTypeForPath: () => 'image/png' }),
    stubModule(uploadPath, Object.assign(((_req, _res, next) => next()), { single: () => (_req, _res, next) => next(), hasValidImageSignature: () => true })),
    stubModule(authPath, (roles = []) => (req, res, next) => {
      const role = String(req.headers['x-test-role'] || '');
      if (!role) return res.status(401).json({ error: 'Token diperlukan' });
      req.user = { id: Number(req.headers['x-test-id'] || 1), role, mitra_id: role === 'mitra' ? Number(req.headers['x-test-mitra'] || 10) : null };
      if (roles.length && !roles.includes(role)) return res.status(403).json({ error: 'Akses ditolak' });
      next();
    })
  ];

  try {
    const app = express();
    app.use(express.json());
    app.use('/api/pembayaran', require('../routes/pembayaran'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    await run(app);
  } finally {
    restores.reverse().forEach((restore) => restore());
    delete require.cache[routePath];
  }
}

function rekeningRows() {
  return [
    { key: 'rekening_bank', value: 'BCA' },
    { key: 'rekening_nomor', value: '1234567890' },
    { key: 'rekening_pemilik', value: 'CuciMesin' }
  ];
}

test('rekening: admin boleh lihat dan ubah; unauth 401; role tak diizinkan 403', async () => {
  const db = {
    all: async (sql) => sql.includes('FROM pengaturan') ? rekeningRows() : [],
    get: async () => null,
    run: async () => ({ insertId: 1, affectedRows: 1 }),
    transaction: async (cb) => cb({})
  };
  await withApp(db, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`)).status, 401);
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'teknisi' } })).status, 403);

      const admin = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'admin' } });
      assert.equal(admin.status, 200);
      assert.deepEqual(await admin.json(), { bank: 'BCA', nomor: '1234567890', pemilik: 'CuciMesin' });

      const put = await fetch(`${base}/api/pembayaran/rekening`, {
        method: 'PUT',
        headers: { 'x-test-role': 'admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank: 'BCA', nomor: '123', pemilik: 'CuciMesin' })
      });
      assert.equal(put.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('rekening: pelanggan hanya mendapat rekening saat memiliki SPK eligible miliknya', async () => {
  const db = {
    all: async (sql) => sql.includes('FROM pengaturan') ? rekeningRows() : [],
    get: async (sql, params) => {
      if (sql.includes('FROM spk s') && sql.includes('c.user_id = ?')) {
        assert.equal(params[0], 7);
        return { id: 99 };
      }
      return null;
    },
    run: async () => ({ insertId: 1, affectedRows: 1 }),
    transaction: async (cb) => cb({})
  };
  await withApp(db, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'pelanggan', 'x-test-id': '7' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { bank: 'BCA', nomor: '1234567890', pemilik: 'CuciMesin' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('rekening: pelanggan tanpa SPK eligible ditolak dan /me tidak bocor rekening', async () => {
  const db = {
    all: async (sql, params) => {
      if (sql.includes('FROM pengaturan')) return rekeningRows();
      if (sql.includes('FROM spk s') && sql.includes('c.user_id = ?')) {
        assert.equal(params[0], 7);
        return [{ spk_id: 1, no_spk: 'SPK-1', total: 100000, status_pembayaran: 'Dikonfirmasi' }];
      }
      return [];
    },
    get: async () => null,
    run: async () => ({ insertId: 1, affectedRows: 1 }),
    transaction: async (cb) => cb({})
  };
  await withApp(db, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const rekeningRes = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'pelanggan', 'x-test-id': '7' } });
      assert.equal(rekeningRes.status, 403);

      const meRes = await fetch(`${base}/api/pembayaran/me`, { headers: { 'x-test-role': 'pelanggan', 'x-test-id': '7' } });
      assert.equal(meRes.status, 200);
      const body = await meRes.json();
      assert.equal(body.rekening, null);
      assert.equal(body.pembayaran.length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('rekening: /me tidak pernah mengirim detail rekening walau pelanggan eligible', async () => {
  const db = {
    all: async (sql, params) => {
      if (sql.includes('FROM pengaturan')) return rekeningRows();
      if (sql.includes('FROM spk s') && sql.includes('c.user_id = ?')) {
        assert.equal(params[0], 7);
        return [{ spk_id: 1, no_spk: 'SPK-1', total: 100000, status_pembayaran: 'Ditolak' }];
      }
      return [];
    },
    get: async (sql, params) => {
      if (sql.includes('FROM spk s') && sql.includes('c.user_id = ?')) {
        assert.equal(params[0], 7);
        return { id: 1 };
      }
      return null;
    },
    run: async () => ({ insertId: 1, affectedRows: 1 }),
    transaction: async (cb) => cb({})
  };
  await withApp(db, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const meRes = await fetch(`${base}/api/pembayaran/me`, { headers: { 'x-test-role': 'pelanggan', 'x-test-id': '7' } });
      assert.equal(meRes.status, 200);
      const body = await meRes.json();
      assert.equal(body.rekening, null);
      assert.equal(body.pembayaran.length, 1);

      const rekeningRes = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'pelanggan', 'x-test-id': '7' } });
      assert.equal(rekeningRes.status, 200);
      assert.deepEqual(await rekeningRes.json(), { bank: 'BCA', nomor: '1234567890', pemilik: 'CuciMesin' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('rekening: mitra hanya eligible saat ada invoice belum dibayar tanpa payment_reported terbaru', async () => {
  const eligibleDb = {
    all: async (sql) => sql.includes('FROM pengaturan') ? rekeningRows() : [],
    get: async (sql, params) => {
      if (sql.includes('FROM invoice_mitra i')) {
        assert.equal(params[0], 10);
        return { id: 55 };
      }
      return null;
    }
  };
  await withApp(eligibleDb, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'mitra', 'x-test-id': '3', 'x-test-mitra': '10' } });
      assert.equal(res.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const ineligibleDb = {
    all: async (sql) => sql.includes('FROM pengaturan') ? rekeningRows() : [],
    get: async () => null
  };
  await withApp(ineligibleDb, async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'mitra', 'x-test-id': '3', 'x-test-mitra': '10' } });
      assert.equal(res.status, 403);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
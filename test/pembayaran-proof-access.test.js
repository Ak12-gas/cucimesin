process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

function stubModule(resolvedPath, exports) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
  return () => {
    if (previous) require.cache[resolvedPath] = previous;
    else delete require.cache[resolvedPath];
  };
}

function token(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function makeUploadStub(fileFactory) {
  const inject = (req, _res, next) => {
    if (fileFactory) req.file = fileFactory(req);
    else req.file = req.__testFile || null;
    next();
  };
  const mw = (req, res, next) => inject(req, res, next);
  mw.single = () => (req, res, next) => inject(req, res, next);
  mw.isAllowedImage = () => true;
  mw.hasValidImageSignature = () => true;
  return mw;
}

function defaultStorage(overrides = {}) {
  return {
    contentTypeForPath: (p) => {
      const lower = String(p || '').toLowerCase();
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.webp')) return 'image/webp';
      return 'image/jpeg';
    },
    toObjectPath: (valueOrAssetType, maybeValue) => {
      const value = maybeValue === undefined ? valueOrAssetType : maybeValue;
      const raw = String(value || '');
      if (!raw) return null;
      if (/^https?:\/\//i.test(raw)) return null;
      return raw.replace(/^\/+/, '').replace(/^uploads\//, '') || null;
    },
    upload: async (...args) => {
      if (args.length === 4) {
        const [assetType, objectPath, buffer, contentType] = args;
        return { assetType, bucket: assetType === 'payment_proof' ? 'cucimesin-payment-proofs' : 'cucimesin-spk', objectPath, size: buffer.length, contentType };
      }
      const [objectPath] = args;
      return String(objectPath);
    },
    download: async (...args) => {
      if (args.length === 2) {
        const [assetType, objectPath] = args;
        return { bytes: Buffer.from('proof'), contentType: 'image/png', assetType, bucket: 'cucimesin-payment-proofs', objectPath };
      }
      return Buffer.from('proof');
    },
    remove: async () => ({ removed: true }),
    ...overrides
  };
}

async function withPembayaranApp({ db, storage, users, upload }) {
  const dbPath = require.resolve('../db/database');
  const authPath = require.resolve('../middleware/auth');
  const uploadPath = require.resolve('../middleware/upload');
  const storagePath = require.resolve('../services/storage');
  const routePath = require.resolve('../routes/pembayaran');
  delete require.cache[routePath];
  const restores = [
    stubModule(dbPath, db),
    stubModule(storagePath, defaultStorage(storage)),
    stubModule(uploadPath, upload || makeUploadStub()),
    stubModule(authPath, (roles = []) => (req, res, next) => {
      const h = req.headers.authorization || '';
      const tkn = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!tkn) return res.status(401).json({ error: 'Token diperlukan' });
      try {
        const decoded = jwt.verify(tkn, process.env.JWT_SECRET);
        const user = users[decoded.id];
        if (!user) return res.status(401).json({ error: 'Token tidak valid' });
        if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Akses ditolak' });
        req.user = user;
        next();
      } catch {
        return res.status(401).json({ error: 'Token tidak valid' });
      }
    }),
  ];
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/pembayaran', require('../routes/pembayaran'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((r) => server.close(r));
      restores.reverse().forEach((fn) => fn());
      delete require.cache[routePath];
    }
  };
}

function multipartBody(fields, file) {
  const boundary = '----cucimesinTestBoundary' + Date.now();
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
  }
  if (file) {
    const filename = file.originalname || 'bukti.png';
    const contentType = file.mimetype || 'image/png';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bukti"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    chunks.push(Buffer.from(file.buffer));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

test('Payment proof access contract (Tahap 4.5)', async (t) => {
  const admin = { id: 1, role: 'admin' };
  const owner = { id: 10, role: 'pelanggan' };
  const other = { id: 11, role: 'pelanggan' };
  const users = { 1: admin, 10: owner, 11: other };

  await t.test('admin and owning pelanggan can download payment proof', async () => {
    const downloads = [];
    const db = {
      async get(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        if (q.includes('from pembayaran p') && q.includes('join spk s') && q.includes('where p.id = ?')) {
          if (Number(params[0]) !== 99) return null;
          return { bukti_path: 'payment-proofs/7/bukti.png', user_id: 10 };
        }
        return null;
      },
      async all() { return []; },
      async run() { return { rowCount: 1, insertId: 1 }; }
    };
    const storage = defaultStorage({
      download: async (...args) => {
        const objectPath = args.length === 2 ? args[1] : args[0];
        const assetType = args.length === 2 ? args[0] : 'payment_proof';
        downloads.push({ assetType, objectPath });
        // Compat: current route expects Buffer; future contract may expect {bytes,...}
        if (args.length === 2) return { bytes: Buffer.from('proof'), contentType: 'image/png', assetType, bucket: 'cucimesin-payment-proofs', objectPath };
        return Buffer.from('proof');
      },
    });
    const app = await withPembayaranApp({ db, storage, users });
    t.after(() => app.close());

    for (const user of [admin, owner]) {
      const res = await fetch(`${app.base}/api/pembayaran/99/bukti`, { headers: { Authorization: `Bearer ${token(user)}` } });
      assert.equal(res.status, 200, `user ${user.role}/${user.id} harus boleh`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-type') || '', /image\/png/i);
      const body = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(body, Buffer.from('proof'));
      const cacheControl = String(res.headers.get('cache-control') || '').toLowerCase();
      assert.match(cacheControl, /private/i, 'Cache-Control harus private');
      assert.match(cacheControl, /no-store/i, 'Cache-Control harus no-store');
      assert.equal(res.headers.get('pragma'), 'no-cache');
    }
    assert.ok(downloads.length >= 2);
    for (const d of downloads) {
      assert.ok(String(d.objectPath).includes('payment-proofs/7/bukti.png'));
    }
  });

  await t.test('non-owner pelanggan gets 403 and no bytes are returned', async () => {
    let downloadCalled = false;
    const db = {
      async get(sql) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        if (q.includes('from pembayaran p') && q.includes('where p.id = ?')) {
          return { bukti_path: 'payment-proofs/7/bukti.png', user_id: 10 };
        }
        return null;
      },
      async all() { return []; },
      async run() { return { rowCount: 1 }; }
    };
    const storage = defaultStorage({
      download: async (...args) => {
        downloadCalled = true;
        const objectPath = args.length === 2 ? args[1] : args[0];
        return { bytes: Buffer.from('x'), contentType: 'image/png', objectPath };
      }
    });
    const app = await withPembayaranApp({ db, storage, users });
    t.after(() => app.close());

    const res = await fetch(`${app.base}/api/pembayaran/99/bukti`, { headers: { Authorization: `Bearer ${token(other)}` } });
    assert.equal(res.status, 403);
    assert.equal(downloadCalled, false);
  });

  await t.test('missing proof/object returns 404', async () => {
    const db = {
      async get(sql) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        if (q.includes('from pembayaran p') && q.includes('where p.id = ?')) {
          return { bukti_path: 'payment-proofs/7/missing.png', user_id: 10 };
        }
        return null;
      },
      async all() { return []; },
      async run() { return { rowCount: 1 }; }
    };
    const storage = defaultStorage({
      download: async () => {
        const err = new Error('not found');
        err.status = 404;
        err.code = 'OBJECT_NOT_FOUND';
        throw err;
      }
    });
    const app = await withPembayaranApp({ db, storage, users });
    t.after(() => app.close());

    const res = await fetch(`${app.base}/api/pembayaran/99/bukti`, { headers: { Authorization: `Bearer ${token(owner)}` } });
    assert.equal(res.status, 404);
  });

  await t.test('invalid/external path does not cause external access and returns 404', async () => {
    let downloadCalled = false;
    const db = {
      async get(sql) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        if (q.includes('from pembayaran p') && q.includes('where p.id = ?')) {
          return { bukti_path: 'https://evil.example/pwn.png', user_id: 10 };
        }
        return null;
      },
      async all() { return []; },
      async run() { return { rowCount: 1 }; }
    };
    const storage = defaultStorage({
      download: async (...args) => {
        downloadCalled = true;
        const objectPath = args.length === 2 ? args[1] : args[0];
        return { bytes: Buffer.from('x'), contentType: 'image/png', objectPath };
      }
    });
    const app = await withPembayaranApp({ db, storage, users });
    t.after(() => app.close());

    const res = await fetch(`${app.base}/api/pembayaran/99/bukti`, { headers: { Authorization: `Bearer ${token(owner)}` } });
    assert.equal(res.status, 404);
    assert.equal(downloadCalled, false, 'storage.download tidak boleh dipanggil untuk URL eksternal/invalid');
  });

  await t.test('upload stores canonical payment_proof object path and no public URL', async () => {
    const inserted = [];
    const uploads = [];
    const file = {
      originalname: 'bukti.png',
      mimetype: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      size: 8
    };
    const uploadMw = makeUploadStub(() => file);

    const db = {
      async get(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        // loadPayableOrder: SELECT s.id, s.no_spk, s.total, s.status, s.mitra_id FROM spk s INNER JOIN pelanggan p ... WHERE s.id = ? AND p.user_id = ?
        if (q.includes('from spk s') && q.includes('inner join pelanggan p') && q.includes('p.user_id = ?') && q.includes('where s.id = ?')) {
          const spkId = Number(params[0]);
          const userId = Number(params[1]);
          if (spkId === 7 && userId === 10) {
            return { id: 7, no_spk: 'SPK-7', total: 100000, status: 'Selesai', mitra_id: null };
          }
          return null;
        }
        // Route re-check inside transaction: same shape, may include FOR UPDATE
        if (q.includes('from spk s') && q.includes('inner join pelanggan p') && q.includes('where s.id = ?') && q.includes('p.user_id = ?')) {
          const spkId = Number(params[0]);
          const userId = Number(params[1]);
          if (spkId === 7 && userId === 10) {
            return { id: 7, no_spk: 'SPK-7', total: 100000, status: 'Selesai', mitra_id: null };
          }
          return null;
        }
        // Existing payment check: SELECT status FROM pembayaran WHERE spk_id = ?
        if (q.includes('select status from pembayaran where spk_id = ?')) {
          if (Number(params[0]) === 7) return null;
          return null;
        }
        // Transaction: SELECT id, status, bukti_path FROM pembayaran WHERE spk_id = ? FOR UPDATE
        if (q.includes('from pembayaran where spk_id = ?') && q.includes('bukti_path')) {
          if (Number(params[0]) === 7) return null;
          return null;
        }
        // After insert: SELECT * FROM pembayaran WHERE id = ?
        if (q.includes('from pembayaran where id = ?')) {
          if (Number(params[0]) === 77) {
            return { id: 77, spk_id: 7, nominal: 100000, status: 'Menunggu Konfirmasi', submitted_at: '2026-01-01 00:00:00', bukti_path: 'payment-proofs/7/test.png' };
          }
          return null;
        }
        return null;
      },
      async all(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').toLowerCase();
        // getAccountDetails: SELECT key,value FROM pengaturan WHERE key IN (?, ?, ?)
        if (q.includes('from pengaturan')) {
          const keys = params.map(String);
          if (keys.includes('rekening_bank') || q.includes('rekening')) {
            return [
              { key: 'rekening_bank', value: 'BCA' },
              { key: 'rekening_nomor', value: '123' },
              { key: 'rekening_pemilik', value: 'CuciMesin' }
            ];
          }
        }
        return [];
      },
      async run(sql, params = []) {
        inserted.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rowCount: 1, insertId: 77 };
      },
      async transaction(fn) {
        return fn({ get: this.get.bind(this), all: this.all.bind(this), run: this.run.bind(this) });
      }
    };
    const storage = defaultStorage({
      upload: async (...args) => {
        if (args.length === 4) {
          const [assetType, objectPath, buffer, contentType] = args;
          uploads.push({ assetType, objectPath, buffer, contentType });
          return { assetType, bucket: 'cucimesin-payment-proofs', objectPath, size: buffer.length, contentType };
        }
        const [objectPath, buffer, contentType] = args;
        uploads.push({ assetType: 'payment_proof', objectPath, buffer, contentType });
        return objectPath;
      }
    });

    const app = await withPembayaranApp({ db, storage, users, upload: uploadMw });
    t.after(() => app.close());

    // Kontrak route saat ini: POST /api/pembayaran/:spkId/bukti (multipart field "bukti")
    const { body: mpBody, boundary } = multipartBody({}, file);
    const res = await fetch(`${app.base}/api/pembayaran/7/bukti`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token(owner)}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: mpBody
    });

    const bodyText = await res.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }

    if (![200, 201].includes(res.status)) {
      assert.fail(`Upload contract test tidak dapat memvalidasi jalur sukses saat ini (status ${res.status}). Body: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)}. Perbaiki mock/setup test agar mengikuti kontrak route saat ini tanpa melemahkan assertion keamanan.`);
    }

    assert.ok(uploads.length >= 1, 'storage.upload harus dipanggil');
    const uploadCall = uploads[0];
    assert.equal(uploadCall.assetType, 'payment_proof');
    const objectPath = String(uploadCall.objectPath || '');
    assert.ok(!/^https?:\/\//i.test(objectPath), 'objectPath tidak boleh URL publik');
    assert.ok(!objectPath.includes('/storage/v1/object/public/'));

    const proofInsert = inserted.find((i) => /insert into pembayaran/i.test(i.sql));
    assert.ok(proofInsert, 'harus ada insert pembayaran');
    const stored = proofInsert.params.find((p) => typeof p === 'string' && /payment-proofs\//.test(p));
    assert.ok(stored, 'DB harus menyimpan object path payment proof');
    assert.ok(!String(stored).includes('/storage/v1/object/public/'));
    assert.ok(!/^https?:\/\//i.test(String(stored)));

    // Kontrak target Tahap 4.5: payment-proofs/{spk_id}/{filename}
    // Implementasi route saat ini masih payment-proofs/{timestamp-random}.ext (tanpa spk_id).
    if (!/^payment-proofs\/7\/.+\.(png|jpg|jpeg|webp)$/i.test(objectPath) || !/^payment-proofs\/7\/.+\.(png|jpg|jpeg|webp)$/i.test(String(stored))) {
      throw new Error(`EXPECTED RED / BLOCKED BY IMPLEMENTATION: canonical payment proof path harus payment-proofs/{spk_id}/{filename}. Actual upload="${objectPath}", db="${stored}"`);
    }
  });
});

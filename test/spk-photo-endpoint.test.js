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

function makeToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email, mitra_id: user.mitra_id || null }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function withApp({ db, storage, usersById }, run) {
  const dbPath = require.resolve('../db/database');
  const authPath = require.resolve('../middleware/auth');
  const storagePath = require.resolve('../services/storage');
  const spkAccessPath = require.resolve('../middleware/spk-access');
  const routePath = require.resolve('../routes/spk');
  [routePath, spkAccessPath].forEach((p) => delete require.cache[p]);

  const restores = [
    stubModule(dbPath, db),
    stubModule(storagePath, storage),
    stubModule(authPath, (roles = []) => (req, res, next) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Token diperlukan' });
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = usersById[decoded.id];
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
  app.use('/api/spk', require('../routes/spk'));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restores.reverse().forEach((r) => r());
    delete require.cache[routePath];
    delete require.cache[spkAccessPath];
  }
}

function makeDb({ spk, foto, pelangganOwnerId = 10 }) {
  return {
    async get(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.includes('from spk') && q.includes('where spk.id = ?')) {
        return Number(params[0]) === Number(spk.id) ? { ...spk } : null;
      }
      if (q.includes('from pelanggan p') && q.includes('p.user_id = ?')) {
        const [pelangganId, userId] = params;
        if (Number(pelangganId) === Number(spk.pelanggan_id) && Number(userId) === Number(pelangganOwnerId)) {
          return { id: spk.pelanggan_id };
        }
        return null;
      }
      if (q.includes('from spk_foto') && q.includes('where') && q.includes('id = ?') && q.includes('spk_id = ?')) {
        const [fotoId, spkId] = params;
        const row = foto.find((f) => Number(f.id) === Number(fotoId) && Number(f.spk_id) === Number(spkId));
        return row ? { ...row } : null;
      }
      return null;
    },
    async all() { return []; },
    async run() { return { insertId: 1, rowCount: 1 }; }
  };
}

test('SPK photo endpoint contract (Tahap 4.5/5.3)', async (t) => {
  const admin = { id: 1, role: 'admin', email: 'a@a.test' };
  const teknisi = { id: 2, role: 'teknisi', email: 't@a.test' };
  const pelanggan = { id: 10, role: 'pelanggan', email: 'p@a.test' };
  const otherPelanggan = { id: 11, role: 'pelanggan', email: 'o@a.test' };
  const mitra = { id: 4, role: 'mitra', email: 'm@a.test', mitra_id: 5 };
  const otherMitra = { id: 6, role: 'mitra', email: 'm2@a.test', mitra_id: 99 };
  const usersById = { 1: admin, 2: teknisi, 10: pelanggan, 11: otherPelanggan, 4: mitra, 6: otherMitra };
  const spk = { id: 7, pelanggan_id: 3, teknisi_id: 2, mitra_id: 5, status: 'Dikerjakan' };
  const foto = [{ id: 55, spk_id: 7, path: 'spk/7/foto.jpg', tipe: 'sebelum' }];

  await t.test('returns 401 when unauthenticated', async () => {
    const db = makeDb({ spk, foto });
    const storage = { download: async () => { throw new Error('should not be called'); }, toObjectPath: (a,v)=>({assetType:a,objectPath:v,canonical:true}) };
    await withApp({ db, storage, usersById }, async (base) => {
      const res = await fetch(`${base}/api/spk/7/foto/55`);
      assert.equal(res.status, 401);
    });
  });

  await t.test('returns 403 when authorizeSpk denies role/ownership', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    const storage = { download: async () => { throw new Error('should not be called'); }, toObjectPath: (a,v)=>({assetType:a,objectPath:v,canonical:true}) };
    await withApp({ db, storage, usersById }, async (base) => {
      const res = await fetch(`${base}/api/spk/7/foto/55`, { headers: { Authorization: `Bearer ${makeToken(otherPelanggan)}` } });
      assert.equal(res.status, 403);
    });
  });

  await t.test('returns 403 for teknisi not assigned and mitra not owner', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    let downloadCalled = false;
    const storage = { toObjectPath: (a,v)=>({assetType:a,objectPath:v,canonical:true}), download: async () => { downloadCalled = true; return { bytes: Buffer.from('x'), contentType: 'image/jpeg' }; }, createSignedUrl: async () => { throw new Error('should not be called'); }, contentTypeForPath: ()=>'image/jpeg' };
    const teknisiLain = { id: 22, role: 'teknisi', email: 't2@a.test' };
    const users = { ...usersById, 22: teknisiLain };
    await withApp({ db, storage, usersById: users }, async (base) => {
      for (const user of [teknisiLain, otherMitra]) {
        const res = await fetch(`${base}/api/spk/7/foto/55`, { headers: { Authorization: `Bearer ${makeToken(user)}` } });
        assert.equal(res.status, 403);
      }
    });
    assert.equal(downloadCalled, false);
  });

  await t.test('returns 404 when fotoId does not belong to spkId', async () => {
    const db = makeDb({ spk, foto });
    let downloadCalled = false;
    const storage = { download: async () => { downloadCalled = true; return { bytes: Buffer.from('x'), contentType: 'image/jpeg' }; }, toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucumesin-spk', objectPath: value, canonical: true }) };
    await withApp({ db, storage, usersById }, async (base) => {
      const res = await fetch(`${base}/api/spk/7/foto/999`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
      assert.equal(res.status, 404);
      assert.equal(downloadCalled, false);
    });
  });

  await t.test('authorized roles can fetch photo bytes via backend proxy', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    const downloads = [];
    const storage = {
      download: async (assetType, objectPath) => { downloads.push({ assetType, objectPath }); return { bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg', assetType, bucket: 'cucumesin-spk', objectPath }; },
      toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucumesin-spk', objectPath: value, canonical: true }),
      contentTypeForPath: () => 'image/jpeg'
    };
    await withApp({ db, storage, usersById }, async (base) => {
      for (const user of [admin, teknisi, pelanggan, mitra]) {
        const res = await fetch(`${base}/api/spk/7/foto/55`, { headers: { Authorization: `Bearer ${makeToken(user)}` } });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') || '', /image\/jpeg/i);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        const cc = String(res.headers.get('cache-control') || '').toLowerCase();
        assert.match(cc, /no-store/);
        assert.match(cc, /private/);
        assert.equal(res.headers.get('pragma'), 'no-cache');
        const body = Buffer.from(await res.arrayBuffer());
        assert.deepEqual(body, Buffer.from([1, 2, 3]));
      }
    });
    assert.ok(downloads.length >= 4);
    for (const call of downloads) { assert.equal(call.assetType, 'spk_photo'); assert.equal(call.objectPath, 'spk/7/foto.jpg'); }
  });

  await t.test('legacy stored path is resolved in compat mode without redirecting to public URL', async () => {
    const legacyFoto = [{ id: 55, spk_id: 7, path: '/uploads/legacy.jpg', tipe: 'sebelum' }];
    const db = makeDb({ spk, foto: legacyFoto, pelangganOwnerId: 10 });
    const calls = [];
    const storage = {
      toObjectPath: (assetType, value, options) => { calls.push({ assetType, value, options }); return { assetType, bucket: 'cucumesin-spk', objectPath: 'spk/7/legacy.jpg', canonical: false }; },
      download: async (assetType, objectPath) => ({ bytes: Buffer.from('legacy'), contentType: 'image/jpeg', assetType, objectPath }),
      contentTypeForPath: () => 'image/jpeg'
    };
    await withApp({ db, storage, usersById }, async (base) => {
      const res = await fetch(`${base}/api/spk/7/foto/55`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('location'), null);
      assert.ok(calls.some((c) => c.assetType === 'spk_photo' && c.options?.mode === 'compat'));
    });
  });

  await t.test('invalid/external path is rejected and does not fetch external URL', async () => {
    const badFoto = [{ id: 55, spk_id: 7, path: 'https://evil.example/x.jpg', tipe: 'sebelum' }];
    const db = makeDb({ spk, foto: badFoto, pelangganOwnerId: 10 });
    let downloadCalled = false; let signCalled = false;
    const storage = {
      toObjectPath: (assetType, value) => { if (/^https?:\/\//i.test(String(value))) return null; return { assetType, objectPath: value, canonical: true }; },
      download: async () => { downloadCalled = true; return { bytes: Buffer.from('x'), contentType: 'image/jpeg' }; },
      createSignedUrl: async () => { signCalled = true; return { url: 'https://signed', expiresInSeconds: 60 }; },
      contentTypeForPath: () => 'image/jpeg'
    };
    await withApp({ db, storage, usersById }, async (base) => {
      const res = await fetch(`${base}/api/spk/7/foto/55`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
      assert.equal(res.status, 400);
      const res2 = await fetch(`${base}/api/spk/7/foto/55/url`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
      assert.equal(res2.status, 400);
    });
    assert.equal(downloadCalled, false);
    assert.equal(signCalled, false);
  });

  await t.test('signed URL fallback endpoint has exact 60s TTL and does not leak token in error/log', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    const signCalls = []; const logs = []; const originalError = console.error; console.error = (...args) => logs.push(args.join(' '));
    const storage = {
      toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucumesin-spk', objectPath: value, canonical: true }),
      createSignedUrl: async (assetType, objectPath, expiresInSeconds) => { signCalls.push({ assetType, objectPath, expiresInSeconds }); return { url: 'https://project.supabase.co/storage/v1/object/sign/cucumesin-spk/spk/7/foto.jpg?token=SECRET', expiresInSeconds: 60 }; },
      download: async () => ({ bytes: Buffer.from('x'), contentType: 'image/jpeg' }),
      contentTypeForPath: () => 'image/jpeg'
    };
    try {
      await withApp({ db, storage, usersById }, async (base) => {
        const res = await fetch(`${base}/api/spk/7/foto/55/url?expiresIn=3600&ttl=3600`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.expiresInSeconds, 60);
        assert.equal(body.delivery, 'signed');
        assert.ok(body.url);
      });
      assert.ok(signCalls.length >= 1);
      for (const c of signCalls) { assert.equal(c.assetType, 'spk_photo'); assert.equal(c.expiresInSeconds, 60); }
      assert.ok(!logs.join('\n').includes('token=SECRET'));
    } finally { console.error = originalError; }
  });

  await t.test('signed mode via ?delivery=signed returns JSON and unauthorized users cannot get signed URL', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    let signCalls = 0;
    const storage = {
      toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucumesin-spk', objectPath: value, canonical: true }),
      createSignedUrl: async () => { signCalls++; return { url: 'https://signed.example/spk7', expiresInSeconds: 60 }; },
      download: async () => ({ bytes: Buffer.from('proxy'), contentType: 'image/jpeg' }),
      contentTypeForPath: () => 'image/jpeg'
    };
    await withApp({ db, storage, usersById }, async (base) => {
      const ok = await fetch(`${base}/api/spk/7/foto/55?delivery=signed`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.delivery, 'signed');
      assert.equal(body.expiresInSeconds, 60);
      const denied = await fetch(`${base}/api/spk/7/foto/55?delivery=signed`, { headers: { Authorization: `Bearer ${makeToken(otherPelanggan)}` } });
      assert.equal(denied.status, 403);
    });
    assert.equal(signCalls, 1);
  });

  await t.test('signed URL failure is safe and does not leak token/internal details', async () => {
    const db = makeDb({ spk, foto, pelangganOwnerId: 10 });
    const logs = []; const originalError = console.error; console.error = (...args) => logs.push(args.join(' '));
    const storage = {
      toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucumesin-spk', objectPath: value, canonical: true }),
      createSignedUrl: async () => { const err = new Error('upstream token=SECRET service_role=KEY'); err.status = 502; throw err; },
      download: async () => ({ bytes: Buffer.from('x'), contentType: 'image/jpeg' }),
      contentTypeForPath: () => 'image/jpeg'
    };
    try {
      await withApp({ db, storage, usersById }, async (base) => {
        const res = await fetch(`${base}/api/spk/7/foto/55/url`, { headers: { Authorization: `Bearer ${makeToken(admin)}` } });
        assert.ok([400,404,500,502,503].includes(res.status));
        const body = await res.json().catch(() => ({}));
        const text = JSON.stringify(body);
        assert.ok(!text.includes('SECRET'));
        assert.ok(!text.includes('service_role'));
      });
      assert.ok(!logs.join('\n').includes('token=SECRET'));
    } finally { console.error = originalError; }
  });
});

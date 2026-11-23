const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const realDb = require('../db/database');

const dbPath = require.resolve('../db/database');
let dbCalls = [];
let dbRow = null;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    get: async (sql, params) => {
      dbCalls.push({ sql, params });
      return dbRow;
    }
  }
};

const { authorizeSpk } = require('../middleware/spk-access');

function fakeRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

async function runAuthorize({ row, user = { id: 9, role: 'pelanggan' }, spk } = {}) {
  dbCalls = [];
  dbRow = row;
  const res = fakeRes();
  let nextCalled = false;
  await authorizeSpk(
    {
      spk: spk || { id: 5, pelanggan_id: 3, teknisi_id: null, mitra_id: null },
      user
    },
    res,
    () => { nextCalled = true; }
  );
  return { nextCalled, res, calls: dbCalls };
}

test('backfill menautkan pelanggan dan booking yang belum punya user_id', async () => {
  const statements = [];
  await realDb.backfillCustomerLinks(async (sql) => { statements.push(sql); });

  assert.equal(statements.length, 2);
  assert.match(statements[0], /UPDATE pelanggan p/);
  assert.match(statements[0], /SET user_id = u\.id/);
  assert.match(statements[0], /NOT EXISTS/);
  assert.match(statements[1], /UPDATE booking b/);
});

test('akses SPK pelanggan hanya memakai user_id, bukan nomor telepon', async () => {
  const allowed = await runAuthorize({ row: { id: 3 } });
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.calls.length, 1);
  assert.doesNotMatch(allowed.calls[0].sql, /telepon/);
  assert.deepEqual(allowed.calls[0].params, [3, 9]);

  const denied = await runAuthorize({ row: null });
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 403);
});

test('matriks akses SPK per role', async () => {
  const cases = [
    ['admin', { id: 9, role: 'admin' }, {}, true],
    ['teknisi pemilik', { id: 4, role: 'teknisi' }, {}, true],
    ['teknisi lain', { id: 5, role: 'teknisi' }, {}, false],
    ['mitra pemilik', { id: 9, role: 'mitra', mitra_id: 2 }, { mitra_id: 2 }, true],
    ['mitra lain', { id: 9, role: 'mitra', mitra_id: 3 }, { mitra_id: 2 }, false],
    ['role tidak dikenal', { id: 9, role: 'unknown' }, {}, false]
  ];

  for (const [name, user, spkOverride, expected] of cases) {
    const result = await runAuthorize({
      user,
      spk: { id: 5, pelanggan_id: 3, teknisi_id: 4, mitra_id: 2, ...spkOverride }
    });
    assert.equal(result.nextCalled, expected, name);
    if (!expected) assert.equal(result.res.statusCode, 403, name);
  }

  const withoutUser = await runAuthorize({ user: null });
  assert.equal(withoutUser.nextCalled, false);
  assert.equal(withoutUser.res.statusCode, 401);
});

test('route pembayaran/pelanggan tidak punya fallback telepon lagi', () => {
  const files = ['routes/pembayaran.js', 'routes/pelanggan.js', 'middleware/spk-access.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /user_id IS NULL[\s\S]{0,120}telepon/);
  }
});

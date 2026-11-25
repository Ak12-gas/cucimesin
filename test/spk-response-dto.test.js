process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';

require('express-async-errors');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const spkRow = {
  id: 7,
  no_spk: 'SPK-2026-0007',
  pelanggan_id: 3,
  mitra_id: 5,
  teknisi_id: 2,
  layanan_id: 1,
  pelanggan: 'Pelanggan Uji',
  kategori: 'B2B',
  pelanggan_telepon: '081100000003',
  pelanggan_email: 'pelanggan@test',
  plat_nomor: 'B 1234 ABC',
  merk_tipe: 'Mobil Uji',
  tahun: '2020',
  warna: 'Hitam',
  layanan_nama: 'Cuci Mobil',
  durasi_menit: 60,
  teknisi_nama: 'Teknisi Uji',
  harga: 150000,
  diskon: 10000,
  total: 140000,
  catatan: 'Catatan internal',
  status: 'Dikerjakan',
  waktu_mulai: '2026-11-25 08:00:00',
  waktu_selesai: null,
  created_at: '2026-11-25 07:00:00'
};

const checklistRows = [{ id: 1, spk_id: 7, item: 'Cek kendaraan', selesai: 0, urutan: 0 }];
const fotoRows = [{ id: 9, spk_id: 7, tipe: 'sebelum', path: 'spk/7/rahasat.jpg', created_at: '2026-11-25 08:05:00' }];
const laporanRow = {
  id: 3, spk_id: 7, teknisi_id: 2, laporan: 'Pengerjaan selesai', teknisi_nama: 'Teknisi Uji',
  created_at: '2026-11-25 09:00:00', updated_at: '2026-11-25 09:10:00'
};

let currentUser = { id: 1, role: 'admin' };
let runResult = { affectedRows: 1 };
let latestStatus = spkRow.status;
const auditCalls = [];
const updateCalls = [];

stub('../db/database', {
  async get(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.includes('from spk_checklist')) return { ...checklistRows[0], id: Number(params[0]) || 1 };
    if (q.includes('from spk_foto')) return { ...fotoRows[0], id: Number(params[0]) || 9 };
    if (q.includes('from spk_laporan')) return { ...laporanRow };
    if (q.includes('from spk')) {
      return {
        ...spkRow,
        id: Number(params[0]) || 7,
        status: latestStatus,
        waktu_selesai: latestStatus === 'Selesai' ? '2026-11-25 09:00:00' : spkRow.waktu_selesai
      };
    }
    return null;
  },
  async all(sql) {
    const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.includes('from spk_checklist')) return checklistRows.map((row) => ({ ...row }));
    if (q.includes('from spk_foto')) return fotoRows.map((row) => ({ ...row }));
    if (q.includes('from spk_laporan')) return { ...laporanRow };
    return [];
  },
  async run(sql, params = []) {
    updateCalls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    latestStatus = params[0];
    return { ...runResult, insertId: 7 };
  },
  async transaction(callback) {
    return callback({ fake: true });
  }
});

stub('../middleware/auth', () => (req, _res, next) => {
  req.user = currentUser;
  next();
});

stub('../middleware/spk-access', {
  loadSpk(req, _res, next) {
    req.spk = { ...spkRow };
    next();
  },
  authorizeSpk(_req, _res, next) {
    next();
  }
});

stub('../middleware/upload', {
  single: () => (_req, _res, next) => next(),
  hasValidImageSignature: () => true
});

stub('../services/storage', {
  toObjectPath: (assetType, objectPath) => ({ assetType, objectPath, canonical: true }),
  download: async () => ({ bytes: Buffer.from('x'), contentType: 'image/jpeg' }),
  createSignedUrl: async () => ({ url: 'https://signed', expiresInSeconds: 60 }),
  contentTypeForPath: () => 'image/jpeg'
});

stub('../services/pdfservice', {
  generateSPKPdf: async () => Buffer.from('%PDF-1.4')
});

stub('../utils/audit', {
  writeAudit: async (...args) => {
    auditCalls.push(args);
  }
});

const spkRoute = require('../routes/spk');

async function withApp(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/spk', spkRoute);
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
  }
}

async function getDetail(role) {
  currentUser = { id: 99, role };
  latestStatus = spkRow.status;
  let body;
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/spk/7`);
    assert.equal(res.status, 200);
    body = await res.json();
  });
  return body;
}

test('GET /api/spk/:id memberi admin detail lengkap tanpa metadata child', async () => {
  const body = await getDetail('admin');
  assert.equal(body.no_spk, spkRow.no_spk);
  assert.equal(body.pelanggan_telepon, spkRow.pelanggan_telepon);
  assert.equal(body.pelanggan_email, spkRow.pelanggan_email);
  assert.equal(body.catatan, spkRow.catatan);
  assert.equal(body.harga, spkRow.harga);
  assert.deepEqual(Object.keys(body.checklist[0]).sort(), ['id', 'item', 'selesai']);
  assert.deepEqual(Object.keys(body.foto[0]).sort(), ['id', 'tipe']);
  assert.deepEqual(Object.keys(body.laporan).sort(), ['created_at', 'laporan', 'teknisi_nama', 'updated_at']);
});

test('GET /api/spk/:id menyembunyikan kontak pelanggan dari teknisi tetapi mempertahankan timer', async () => {
  const body = await getDetail('teknisi');
  assert.equal(body.waktu_mulai, spkRow.waktu_mulai);
  assert.equal(Object.hasOwn(body, 'pelanggan_telepon'), false);
  assert.equal(Object.hasOwn(body, 'pelanggan_email'), false);
  assert.equal(Object.hasOwn(body, 'catatan'), false);
  assert.equal(Object.hasOwn(body, 'pelanggan_id'), false);
  assert.equal(Object.hasOwn(body, 'mitra_id'), false);
  assert.equal(Object.hasOwn(body, 'layanan_id'), false);
  assert.deepEqual(Object.keys(body.checklist[0]).sort(), ['id', 'item', 'selesai']);
  assert.deepEqual(Object.keys(body.foto[0]).sort(), ['id', 'tipe']);
  assert.deepEqual(Object.keys(body.laporan), ['laporan']);
});

test('GET /api/spk/:id mempertahankan kontak pelanggan untuk pelanggan dan mitra', async () => {
  for (const role of ['pelanggan', 'mitra']) {
    const body = await getDetail(role);
    assert.equal(body.pelanggan_telepon, spkRow.pelanggan_telepon);
    assert.equal(body.pelanggan_email, spkRow.pelanggan_email);
    assert.equal(body.no_spk, spkRow.no_spk);
    assert.equal(Object.hasOwn(body, 'checklist'), false);
    assert.equal(Object.hasOwn(body, 'foto'), false);
    assert.equal(Object.hasOwn(body, 'laporan'), false);
  }
});

test('PATCH /api/spk/:id/status mengembalikan DTO 5 field pada jalur sukses', async () => {
  currentUser = { id: 1, role: 'admin' };
  runResult = { affectedRows: 1 };
  latestStatus = spkRow.status;
  auditCalls.length = 0;
  updateCalls.length = 0;

  await withApp(async (base) => {
    const res = await fetch(`${base}/api/spk/7/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Selesai' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['id', 'no_spk', 'status', 'waktu_mulai', 'waktu_selesai']);
    assert.equal(body.id, 7);
    assert.equal(body.no_spk, spkRow.no_spk);
    assert.equal(body.status, 'Selesai');
  });

  assert.equal(auditCalls.length, 1);
  assert.ok(updateCalls.some((call) => call.sql.includes('waktu_selesai = ?')));
});

test('PATCH /api/spk/:id/status mempertahankan DTO pada jalur status sama dan fallback', async () => {
  for (const affectedRows of [null, 0]) {
    currentUser = { id: 2, role: 'teknisi' };
    runResult = { affectedRows };
    latestStatus = spkRow.status;
    await withApp(async (base) => {
      const status = affectedRows === null ? 'Dikerjakan' : 'Batal';
      const res = await fetch(`${base}/api/spk/7/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['id', 'no_spk', 'status', 'waktu_mulai', 'waktu_selesai']);
    });
  }
});

test('PATCH /api/spk/:id/status menolak transisi tidak valid', async () => {
  currentUser = { id: 1, role: 'admin' };
  latestStatus = spkRow.status;
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/spk/7/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Menunggu' })
    });
    assert.equal(res.status, 400);
  });
});

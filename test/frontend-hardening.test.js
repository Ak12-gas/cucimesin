const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

function readPublic(fileName) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
}

function extractFunctionBody(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  const start = asyncStart !== -1 ? asyncStart : syncStart;
  assert.notEqual(start, -1, `fungsi ${name} tidak ditemukan`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(braceStart + 1, index);
  }
  throw new Error(`fungsi ${name} tidak memiliki penutup`);
}

test('portal pelanggan: batas upload bukti 4 MB universal dan tanpa deteksi hostname', () => {
  const source = readPublic('pelanggan-portal.html');
  assert.match(source, /const PAYMENT_PROOF_MAX_MB = 4;/);
  assert.match(source, /const PAYMENT_PROOF_MAX_BYTES = PAYMENT_PROOF_MAX_MB \* 1024 \* 1024;/);
  assert.doesNotMatch(source, /vercel\.app/);
  assert.match(source, /maksimal \$\{PAYMENT_PROOF_MAX_MB\} MB/);
  assert.match(source, /Ukuran bukti pembayaran maksimal \$\{PAYMENT_PROOF_MAX_MB\} MB\./);
  assert.doesNotMatch(source, /maksimal 5 MB/);
});

test('portal reset: dev_token tidak ditampilkan sebagai nilai di pesan UI', () => {
  for (const fileName of ['pelanggan-portal.html', 'portal-mitra.html']) {
    const source = readPublic(fileName);
    const body = extractFunctionBody(source, 'requestPasswordReset');
    assert.match(body, /document\.getElementById\('resetToken'\)\.value = data\.dev_token/);
    assert.doesNotMatch(body, /Kode pengujian:\s*\$\{data\.dev_token\}/);
    assert.doesNotMatch(body, /alert\(.*dev_token/);
    assert.doesNotMatch(body, /console\.(log|info|warn|error)\(.*dev_token/);
  }
});

test('portal mitra: rekening diambil lewat API dan tidak hardcoded', () => {
  const source = readPublic('portal-mitra.html');
  assert.match(source, /id="paymentAccountInfo"/);
  assert.match(source, /async function loadPaymentAccount\(token/);
  assert.match(source, /fetch\('\/api\/pembayaran\/rekening'/);
  assert.doesNotMatch(source, /BCA 1234567890/);
  assert.doesNotMatch(source, /CuciMesin Tuban/);
});

test('portal mitra: loadDashboardData tidak memuat rekening otomatis', () => {
  const source = readPublic('portal-mitra.html');
  const matches = source.match(/async function loadDashboardData\(/g) || [];
  assert.equal(matches.length, 1);
  const body = extractFunctionBody(source, 'loadDashboardData');
  assert.doesNotMatch(body, /loadPaymentAccount\(/);
  assert.match(body, /loadInvoices\(authToken\)/);
  assert.match(body, /loadFleetData\(authToken\)/);
  assert.match(body, /loadProfile\(\)/);
  assert.match(body, /populateDashboard\(data\)/);
});

test('portal mitra: rekening dimuat hanya saat tombol bayar ditekan', () => {
  const source = readPublic('portal-mitra.html');
  const invoicesBody = extractFunctionBody(source, 'loadInvoices');
  const payBody = extractFunctionBody(source, 'payInvoice');
  assert.match(invoicesBody, /actionableInvoices\.length/);
  assert.doesNotMatch(invoicesBody, /loadPaymentAccount\(/);
  assert.match(invoicesBody, /Tidak ada invoice yang perlu dibayar\./);
  assert.match(invoicesBody, /Menunggu verifikasi admin/);
  assert.match(payBody, /loadPaymentAccount\(token, \{ force: true \}\)/);
  assert.match(payBody, /Rekening pembayaran belum tersedia|belum memiliki invoice yang perlu dibayar/);
});

test('portal pelanggan: rekening hanya dimuat saat tombol Bayar dan tidak saat load data', () => {
  const source = readPublic('pelanggan-portal.html');
  const loadBody = extractFunctionBody(source, 'loadPelangganData');
  const renderBody = extractFunctionBody(source, 'renderCustomerPaymentOptions');
  const payBody = extractFunctionBody(source, 'loadCustomerPaymentAccount');
  const submitBody = extractFunctionBody(source, 'submitCustomerPayment');

  assert.doesNotMatch(loadBody, /\/api\/pembayaran\/rekening/);
  assert.match(loadBody, /\/api\/pembayaran\/me/);
  assert.match(renderBody, /loadCustomerPaymentAccount\(/);
  assert.match(renderBody, /Rekening ditampilkan setelah Anda menekan tombol Bayar/);
  assert.doesNotMatch(renderBody, /customerPaymentData\.rekening \|\| \{\}/);
  assert.match(payBody, /\/api\/pembayaran\/rekening/);
  assert.match(submitBody, /customerPaymentRekening = null/);
  assert.match(submitBody, /loadPelangganData\(token\)/);
});

async function withRekeningApp(run, options = {}) {
  const dbPath = require.resolve('../db/database');
  const authPath = require.resolve('../middleware/auth');
  const routePath = require.resolve('../routes/pembayaran');
  const originalDb = require.cache[dbPath];
  const originalAuth = require.cache[authPath];
  const originalRoute = require.cache[routePath];
  delete require.cache[routePath];

  const state = {
    customerEligible: options.customerEligible === true,
    mitraEligible: options.mitraEligible === true
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      all: async () => [
        { key: 'rekening_bank', value: 'BCA' },
        { key: 'rekening_nomor', value: '1234567890' },
        { key: 'rekening_pemilik', value: 'CuciMesin' }
      ],
      get: async (sql) => {
        if (sql.includes('FROM spk s') && sql.includes('c.user_id = ?')) return state.customerEligible ? { id: 1 } : null;
        if (sql.includes('FROM invoice_mitra i')) return state.mitraEligible ? { id: 1 } : null;
        return null;
      }
    }
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: (roles = []) => (req, res, next) => {
      const role = String(req.headers['x-test-role'] || '');
      if (!role) return res.status(401).json({ error: 'Token diperlukan' });
      req.user = { id: 1, role, mitra_id: role === 'mitra' ? 1 : null };
      if (roles.length && !roles.includes(role)) return res.status(403).json({ error: 'Akses ditolak' });
      next();
    }
  };

  try {
    const app = express();
    app.use(express.json());
    app.use('/api/pembayaran', require('../routes/pembayaran'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    await run(app);
  } finally {
    if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];
    if (originalAuth) require.cache[authPath] = originalAuth; else delete require.cache[authPath];
    if (originalRoute) require.cache[routePath] = originalRoute; else delete require.cache[routePath];
  }
}

test('endpoint /api/pembayaran/rekening menerapkan auth dan eligibility', async () => {
  await withRekeningApp(async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`)).status, 401);
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'teknisi' } })).status, 403);
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'pelanggan' } })).status, 403);
      assert.equal((await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'mitra' } })).status, 403);

      const adminRes = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': 'admin' } });
      assert.equal(adminRes.status, 200);
      assert.deepEqual(await adminRes.json(), { bank: 'BCA', nomor: '1234567890', pemilik: 'CuciMesin' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { customerEligible: false, mitraEligible: false });

  await withRekeningApp(async (app) => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const role of ['pelanggan', 'mitra']) {
        const res = await fetch(`${base}/api/pembayaran/rekening`, { headers: { 'x-test-role': role } });
        assert.equal(res.status, 200, `role ${role} eligible harus diizinkan`);
        assert.deepEqual(await res.json(), { bank: 'BCA', nomor: '1234567890', pemilik: 'CuciMesin' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, { customerEligible: true, mitraEligible: true });
});

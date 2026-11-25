const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('frontend storage contract: SPK photos use authorized backend delivery (Tahap 4.5)', async (t) => {
  await t.test('admin dashboard does not render SPK foto directly from public foto.path', () => {
    const source = readPublic('admin-dashboard.html');
    // Kontrak target: tidak boleh merender foto SPK dari path publik/storage mentah.
    assert.doesNotMatch(source, /<img[^>]+src=["']\$\{[^}]*foto(Sebelum|Sesudah)\[0\]\.path[^}]*\}["']/i);
    assert.doesNotMatch(source, /src=["']\/uploads\/[^"']*spk/i);
    assert.match(source, /\/api\/spk\/|fetchWithAuth|Authorization/, 'admin harus memiliki jalur fetch foto terotorisasi');
  });

  await t.test('teknisi app does not render SPK foto directly from public foto.path', () => {
    const source = readPublic('teknisi-app.html');
    assert.doesNotMatch(source, /<img[^>]+src=["']\$\{[^}]*foto(Sebelum|Sesudah)\[0\]\.path[^}]*\}["']/i);
    assert.doesNotMatch(source, /src=["']\/uploads\/[^"']*spk/i);
    assert.match(source, /\/api\/spk\/|Authorization/, 'teknisi harus memiliki jalur fetch foto terotorisasi');
  });

  await t.test('frontend uses fetch+Authorization+Blob URL for private photos', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    for (const [name, source] of [['admin', admin], ['teknisi', teknisi]]) {
      assert.match(source, /Authorization/, `${name} harus mengirim Authorization`);
      assert.match(source, /(?:response|res)\.blob\(|\.blob\(\)|new Blob|URL\.createObjectURL/, `${name} harus memproses respons sebagai Blob/URL objek`);
    }
  });

  await t.test('frontend revokes Blob URLs when replaced/unmounted', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    assert.match(admin, /URL\.revokeObjectURL\(/, 'admin harus revoke Blob URL lama');
    assert.match(teknisi, /URL\.revokeObjectURL\(/, 'teknisi harus revoke Blob URL lama');
  });

  await t.test('frontend does not persist signed/photo URL/token in browser storage', () => {
    const files = ['admin-dashboard.html', 'teknisi-app.html', 'pelanggan-portal.html'];
    for (const file of files) {
      const source = readPublic(file);
      assert.doesNotMatch(source, /localStorage\.setItem\([^)]*(signed|tokenized|object\/sign)/i, `${file} tidak boleh simpan signed URL/token`);
      assert.doesNotMatch(source, /sessionStorage\.setItem\([^)]*(signed|tokenized|object\/sign)/i, `${file} tidak boleh simpan signed URL/token`);
    }
  });

  await t.test('frontend handles 401/403/404 on photo/proof fetch without rendering photo', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    // Kontrak target: frontend harus punya handling status akses/error foto privat.
    assert.match(admin, /(?:401|403|404).*(?:foto|photo|gambar|bukti)|(?:foto|photo|gambar|bukti).*(?:401|403|404)|status\s*===\s*401|status\s*===\s*403|status\s*===\s*404/i, 'admin harus menangani status akses/error foto');
    assert.match(teknisi, /(?:401|403|404).*(?:foto|photo|gambar|bukti)|(?:foto|photo|gambar|bukti).*(?:401|403|404)|status\s*===\s*401|status\s*===\s*403|status\s*===\s*404/i, 'teknisi harus menangani status akses/error foto');
  });

  await t.test('frontend handles 502 and does not leave stale foto as current data on error', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    for (const [name, source] of [['admin', admin], ['teknisi', teknisi]]) {
      assert.match(source, /502/, `${name} harus menangani 502`);
      assert.match(source, /removeAttribute\(['"]src['"]\)|img\.src\s*=\s*['"]['"]|style\.display\s*=\s*['"]none['"]/, `${name} harus mengosongkan/menyembunyikan src lama saat error`);
    }
  });

  await t.test('frontend mitigates race conditions and cleans blob URLs on refresh/unmount', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    for (const [name, source] of [['admin', admin], ['teknisi', teknisi]]) {
      assert.match(source, /AbortController|signal\s*:\s*controller\.signal|abort\(\)/, `${name} harus punya mekanisme abort/race control`);
      assert.match(source, /isConnected|dataset\.spkPhotoKey|spkPhotoKey/, `${name} harus memverifikasi elemen/key sebelum menerapkan hasil`);
      assert.match(source, /clearSpkPhotoBlobsForContainer|revokeSpkPhotoBlobUrl/, `${name} harus membersihkan Blob URL saat container diganti/ditutup`);
    }
    assert.match(admin, /clearSpkPhotoBlobsForContainer\(detailBody\)/, 'admin harus bersihkan blob saat render/close detail SPK');
    assert.match(teknisi, /clearSpkPhotoBlobsForContainer\(photoPreview\)/, 'teknisi harus bersihkan blob saat render ulang foto');
  });

  await t.test('SPK photo fetch uses proxy endpoint and does not put token in URL', () => {
    const admin = readPublic('admin-dashboard.html');
    const teknisi = readPublic('teknisi-app.html');
    for (const [name, source] of [['admin', admin], ['teknisi', teknisi]]) {
      assert.match(source, /\/api\/spk\/\$\{encodeURIComponent\(spkId\)\}\/foto\/\$\{encodeURIComponent\(fotoId\)\}/, `${name} harus pakai endpoint proxy SPK`);
      assert.doesNotMatch(source, /[?&]token=|Authorization=.*\$\{.*\}.*[?&]/, `${name} tidak boleh taruh token di URL`);
      assert.match(source, /response\.blob\(\)|await response\.blob\(\)/, `${name} harus memproses blob`);
      assert.match(source, /URL\.createObjectURL\(/, `${name} harus createObjectURL`);
    }
  });

  await t.test('Tahap 4.1 rekening hardening remains present (robust assertions)', () => {
    const pelanggan = readPublic('pelanggan-portal.html');
    const mitra = readPublic('portal-mitra.html');

    // Pelanggan: rekening dimuat on-demand saat aksi bayar, bukan saat load data.
    const loadPelangganDataBody = extractFunctionBody(pelanggan, 'loadPelangganData');
    assert.doesNotMatch(loadPelangganDataBody, /\/api\/pembayaran\/rekening|loadCustomerPaymentAccount\(/);
    assert.match(pelanggan, /async function loadCustomerPaymentAccount\(/);
    assert.match(pelanggan, /\/api\/pembayaran\/rekening/);

    const renderPayment = extractFunctionBody(pelanggan, 'renderCustomerPaymentOptions');
    assert.match(renderPayment, /loadCustomerPaymentAccount\(/);
    assert.match(renderPayment, /Bayar|Tampilkan Rekening/);

    // Mitra: loadInvoices tidak boleh memuat rekening otomatis.
    const loadInvoicesBody = extractFunctionBody(mitra, 'loadInvoices');
    assert.doesNotMatch(loadInvoicesBody, /loadRekening\(|loadPaymentAccount\(|\/api\/pembayaran\/rekening/);
    // payInvoice harus memicu fetch rekening on-demand (nama fungsi implementasi saat ini: loadPaymentAccount)
    const payInvoiceBody = extractFunctionBody(mitra, 'payInvoice');
    assert.match(payInvoiceBody, /(?:loadRekening|loadPaymentAccount)\(\s*(?:token\s*,\s*)?\{[^}]*force\s*:\s*true/);
    assert.match(payInvoiceBody, /\/api\/mitra\/me\/invoices\//);

    const dashBody = extractFunctionBody(mitra, 'loadDashboardData');
    assert.doesNotMatch(dashBody, /loadRekening\(|loadPaymentAccount\(/);
  });
});

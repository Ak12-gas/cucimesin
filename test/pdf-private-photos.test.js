const test = require('node:test');
const assert = require('node:assert/strict');

const PDF_MODULE = require.resolve('../services/pdfservice');
const STORAGE_MODULE = require.resolve('../services/storage');
const DB_MODULE = require.resolve('../db/database');

function stubModule(resolvedPath, exports) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
  return () => {
    if (previous) require.cache[resolvedPath] = previous;
    else delete require.cache[resolvedPath];
  };
}

function loadPdfService({ storage, db }) {
  delete require.cache[PDF_MODULE];
  const restores = [
    stubModule(STORAGE_MODULE, storage),
    stubModule(DB_MODULE, db),
  ];
  const pdf = require('../services/pdfservice');
  return {
    pdf,
    restore() {
      restores.reverse().forEach((r) => r());
      delete require.cache[PDF_MODULE];
    }
  };
}

function fakeDb({ payment = null, invoice = null } = {}) {
  return {
    async get(sql, params = []) {
      if (sql.includes('FROM pengaturan')) return { value: 'Uji' };
      if (sql.includes('FROM pembayaran')) return payment;
      if (sql.includes('FROM invoice_mitra')) return invoice;
      return null;
    }
  };
}

function baseSpk(overrides = {}) {
  return {
    id: 42,
    no_spk: 'SPK-202611-001',
    status: 'Selesai',
    created_at: '2026-11-23 10:00:00',
    pelanggan: 'Budi',
    pelanggan_telepon: '0812',
    pelanggan_email: 'budi@test.test',
    kategori: 'Pribadi',
    plat_nomor: 'L 1 AB',
    merk_tipe: 'Avanza',
    tahun: '2020',
    warna: 'Hitam',
    teknisi_nama: 'Teknisi',
    waktu_mulai: null,
    waktu_selesai: null,
    layanan_nama: 'Cuci',
    durasi_menit: 45,
    harga: 50000,
    diskon: 0,
    total: 50000,
    checklist: [],
    foto: [],
    catatan: '',
    laporan: null,
    ...overrides
  };
}

test('PDF private photos contract (Tahap 4.5)', async (t) => {
  await t.test('generateSPKPdf downloads spk_photo from storage service for private bucket', async () => {
    const downloads = [];
    const storage = {
      download: async (assetType, objectPath) => {
        downloads.push({ assetType, objectPath });
        return { bytes: Buffer.from('fake-image'), contentType: 'image/jpeg', assetType, bucket: 'cucimesin-spk', objectPath };
      },
      toObjectPath: (assetType, value, options) => ({ assetType, bucket: 'cucimesin-spk', objectPath: String(value).replace(/^\/+/, ''), canonical: !String(value).startsWith('/uploads/'), options }),
      contentTypeForPath: () => 'image/jpeg'
    };
    const db = fakeDb({ payment: { status: 'Dikonfirmasi' } });
    const { pdf, restore } = loadPdfService({ storage, db });
    t.after(restore);

    let html = '';
    await pdf.generateSPKPdf(baseSpk({ foto: [{ tipe: 'sebelum', path: 'spk/42/foto.jpg' }] }), {
      db,
      htmlToPdf: async (rendered) => { html = rendered; return Buffer.from('%PDF-test'); }
    });

    assert.ok(downloads.length >= 1);
    assert.deepEqual(downloads[0], { assetType: 'spk_photo', objectPath: 'spk/42/foto.jpg' });
    assert.match(html, /data:image\/jpeg;base64,/);
  });

  await t.test('generateSPKPdf does not fetch arbitrary external http/https URLs', async () => {
    const downloads = [];
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async (...args) => { fetchCalled = true; return originalFetch(...args); };
    t.after(() => { global.fetch = originalFetch; });

    const storage = {
      download: async (assetType, objectPath) => { downloads.push({ assetType, objectPath }); return { bytes: Buffer.from('img'), contentType: 'image/jpeg' }; },
      toObjectPath: (assetType, value) => {
        if (/^https?:\/\//i.test(String(value)) && !String(value).includes('project.supabase.co/storage/v1/object/public/cucimesin')) {
          return null; // external/unknown harus ditolak
        }
        return { assetType, bucket: 'cucimesin-spk', objectPath: 'spk/42/foto.jpg', canonical: false };
      },
      contentTypeForPath: () => 'image/jpeg'
    };
    const db = fakeDb({ payment: { status: 'Dikonfirmasi' } });
    const { pdf, restore } = loadPdfService({ storage, db });
    t.after(restore);

    let html = '';
    await pdf.generateSPKPdf(baseSpk({ foto: [{ tipe: 'sebelum', path: 'https://evil.example.com/foto.jpg' }] }), {
      db,
      htmlToPdf: async (rendered) => { html = rendered; return Buffer.from('%PDF'); }
    });

    assert.equal(fetchCalled, false, 'PDF tidak boleh fetch external URL arbitrary');
    assert.equal(downloads.length, 0, 'external URL tidak boleh didownload via storage');
    assert.match(html, /Belum ada foto|⚠|photo-placeholder/);
  });

  await t.test('missing/unreadable photo falls back to placeholder and PDF still generates', async () => {
    const storage = {
      download: async () => { const err = new Error('missing'); err.status = 404; err.code = 'OBJECT_NOT_FOUND'; throw err; },
      toObjectPath: (assetType, value) => ({ assetType, bucket: 'cucimesin-spk', objectPath: value, canonical: true }),
      contentTypeForPath: () => 'image/jpeg'
    };
    const db = fakeDb({ payment: { status: 'Dikonfirmasi' } });
    const { pdf, restore } = loadPdfService({ storage, db });
    t.after(restore);

    let html = '';
    const bytes = await pdf.generateSPKPdf(baseSpk({ foto: [{ tipe: 'sesudah', path: 'spk/42/missing.jpg' }] }), {
      db,
      htmlToPdf: async (rendered) => { html = rendered; return Buffer.from('%PDF-ok'); }
    });
    assert.ok(Buffer.isBuffer(bytes));
    assert.match(html, /Belum ada foto|⚠|photo-placeholder/);
  });

  await t.test('LUNAS/BELUM LUNAS rules remain unchanged', async () => {
    const storage = { download: async () => ({ bytes: Buffer.from('x') }), toObjectPath: () => null, contentTypeForPath: () => 'image/jpeg' };
    const { pdf, restore } = loadPdfService({ storage, db: fakeDb() });
    t.after(restore);
    const { buildPaymentStatus } = pdf;
    const LUNAS = 'LUNAS — Terima kasih';
    const BELUM = 'BELUM LUNAS';
    assert.match(buildPaymentStatus({ status: 'Dikerjakan' }, { status: 'Dikonfirmasi' }, null), new RegExp(BELUM));
    assert.match(buildPaymentStatus({ status: 'Selesai' }, { status: 'Menunggu Konfirmasi' }, null), new RegExp(BELUM));
    assert.match(buildPaymentStatus({ status: 'Selesai' }, { status: 'Dikonfirmasi' }, null), new RegExp(LUNAS));
    assert.match(buildPaymentStatus({ status: 'Selesai', mitra_id: 3 }, null, { status: 'Pending' }), new RegExp(BELUM));
    assert.match(buildPaymentStatus({ status: 'Selesai', mitra_id: 3 }, null, { status: 'Lunas' }), new RegExp(LUNAS));
  });
});

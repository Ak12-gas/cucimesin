const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPaymentStatus, generateSPKPdf } = require('../services/pdfservice');

const LUNAS = 'LUNAS — Terima kasih';
const BELUM = 'BELUM LUNAS';

function fakeDb({ payment = null, invoice = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM pengaturan')) {
        const values = {
          nama_bisnis: 'Uji Carwash',
          alamat: 'Jl. Uji',
          kontak: '0812',
          website: 'uji.local'
        };
        return Object.hasOwn(values, params[0]) ? { value: values[params[0]] } : null;
      }
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
    pelanggan: 'Pelanggan Uji',
    kategori: 'Normal',
    pelanggan_telepon: '081200000001',
    pelanggan_email: 'uji@example.com',
    plat_nomor: 'D 1234 ABC',
    merk_tipe: 'Toyota Avanza',
    tahun: '2024',
    warna: 'Hitam',
    teknisi_nama: 'Teknisi Uji',
    waktu_mulai: '2026-11-23 10:05:00',
    waktu_selesai: '2026-11-23 11:05:00',
    layanan_nama: 'Cuci Mesin Standard',
    durasi_menit: 60,
    harga: 95000,
    diskon: 0,
    total: 95000,
    catatan: '',
    checklist: [],
    foto: [],
    laporan: null,
    ...overrides
  };
}

async function render(spk, dbOptions = {}) {
  const db = fakeDb(dbOptions);
  const htmlToPdf = async (html) => Buffer.from(html, 'utf8');
  const output = await generateSPKPdf(spk, { db, htmlToPdf });
  return { html: output.toString('utf8'), db };
}

test('status PDF: LUNAS hanya jika selesai dan pembayaran/invoice dikonfirmasi', () => {
  const cases = [
    ['selesai tanpa pembayaran', baseSpk(), null, null, BELUM],
    ['selesai menunggu konfirmasi', baseSpk(), { status: 'Menunggu Konfirmasi' }, null, BELUM],
    ['selesai dibayar', baseSpk(), { status: 'Dikonfirmasi' }, null, LUNAS],
    ['dikerjakan walau ada pembayaran', baseSpk({ status: 'Dikerjakan' }), { status: 'Dikonfirmasi' }, null, BELUM],
    ['batal', baseSpk({ status: 'Batal' }), { status: 'Dikonfirmasi' }, null, BELUM],
    ['mitra invoice lunas', baseSpk({ mitra_id: 7 }), null, { status: 'Lunas' }, LUNAS],
    ['mitra invoice belum dibayar', baseSpk({ mitra_id: 7 }), null, { status: 'Belum Dibayar' }, BELUM]
  ];

  for (const [name, spk, payment, invoice, expected] of cases) {
    assert.match(buildPaymentStatus(spk, payment, invoice), new RegExp(expected), name);
  }
});

test('alur Selesai tapi belum bayar: PDF tetap BELUM LUNAS sampai admin mengonfirmasi', async () => {
  const spk = baseSpk();

  const selesai = await render(spk);
  assert.match(selesai.html, new RegExp(BELUM));
  assert.doesNotMatch(selesai.html, new RegExp(LUNAS));
  assert.ok(
    selesai.db.calls.some((call) => call.sql.includes('FROM pembayaran')),
    'generateSPKPdf harus mengecek tabel pembayaran'
  );

  const menunggu = await render(spk, { payment: { status: 'Menunggu Konfirmasi' } });
  assert.match(menunggu.html, new RegExp(BELUM));
  assert.doesNotMatch(menunggu.html, new RegExp(LUNAS));

  const dibayar = await render(spk, { payment: { status: 'Dikonfirmasi' } });
  assert.match(dibayar.html, new RegExp(LUNAS));
  assert.doesNotMatch(dibayar.html, new RegExp(BELUM));
});

test('SPK mitra memakai status invoice', async () => {
  const spk = baseSpk({ mitra_id: 7 });

  const belum = await render(spk, { invoice: { status: 'Belum Dibayar' } });
  assert.match(belum.html, new RegExp(BELUM));
  assert.ok(belum.db.calls.some((call) => call.sql.includes('FROM invoice_mitra')));

  const lunas = await render(spk, { invoice: { status: 'Lunas' } });
  assert.match(lunas.html, new RegExp(LUNAS));
});

test('SPK belum selesai tidak perlu query pembayaran', async () => {
  const { db, html } = await render(
    baseSpk({ status: 'Dikerjakan' }),
    { payment: { status: 'Dikonfirmasi' } }
  );
  assert.match(html, new RegExp(BELUM));
  assert.ok(!db.calls.some((call) => call.sql.includes('FROM pembayaran')));
});

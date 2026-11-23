process.env.JWT_SECRET = 'test-secret-0123456789-abcdefghijklmnop';
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const passwordHash = bcrypt.hashSync('rahasia123', 4);

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

const users = {
  1: { id: 1, nama: 'Admin', email: 'admin@test', telepon: '081100000001', role: 'admin', mitra_id: null, aktif: 1 },
  2: { id: 2, nama: 'Teknisi', email: 'teknisi@test', telepon: '081100000002', role: 'teknisi', mitra_id: null, aktif: 1 },
  3: { id: 3, nama: 'Pelanggan', email: 'pelanggan@test', telepon: '081100000003', role: 'pelanggan', mitra_id: null, aktif: 1 },
  4: { id: 4, nama: 'Mitra', email: 'mitra@test', telepon: '081100000004', role: 'mitra', mitra_id: 1, aktif: 1 }
};

const spkRow = {
  id: 1, no_spk: 'SPK-2026-0001', pelanggan_id: 3, mitra_id: 1, layanan_id: 1,
  teknisi_id: 2, status: 'Dikerjakan', tanggal: '2026-11-23', waktu: '10:00',
  total: 100000, catatan: 'Smoke test', pelanggan: 'Pelanggan', layanan_nama: 'Cuci Mobil'
};
const pelangganRow = { id: 3, user_id: 3, nama: 'Pelanggan', telepon: '081100000003', email: 'pelanggan@test', kategori: 'Reguler' };
const mitraRow = { id: 1, nama_showroom: 'Mitra Uji', telepon: '081100000004', email: 'mitra@test', diskon_persen: 10 };
const layananRow = { id: 1, nama: 'Cuci Mobil', harga: 100000, durasi_menit: 60, aktif: 1, deskripsi: 'Layanan uji' };
const bookingRow = { id: 1, user_id: 3, mitra_id: 1, layanan_id: 1, tanggal: '2026-11-24', waktu: '10:00', status: 'Baru', spk_id: null, catatan: '' };
const paymentRow = { id: 1, spk_id: 1, status: 'Dikonfirmasi', nominal: 100000, bukti: 'bukti.png', metode: 'Transfer', created_at: '2026-11-23 10:00:00' };
const invoiceRow = { id: 1, mitra_id: 1, no_invoice: 'INV-2026-001', status: 'Lunas', total: 100000, periode: '2026-11', created_at: '2026-11-23 10:00:00' };
const invoiceItemRow = { id: 1, invoice_id: 1, spk_id: 1, no_spk: 'SPK-2026-0001', nominal: 100000 };
const transaksiRow = { id: 1, kategori: 'Uji', deskripsi: 'Smoke test', nominal: 100000, tanggal: '2026-11-23' };
const armadaRow = { id: 1, mitra_id: 1, nomor: 'B 1234 ABC', kapasitas: 5, aktif: 1 };
const rekeningRow = { id: 1, bank: 'BCA', nomor: '1234567890', atas_nama: 'CuciMesin' };
const pengaturanRows = [
  { key: 'nama_aplikasi', value: 'CuciMesin' },
  { key: 'rekening_default', value: 'BCA 1234567890' }
];
const checklistRow = { id: 1, spk_id: 1, item: 'Cek kendaraan', selesai: 0 };
const fotoRow = { id: 1, spk_id: 1, path: '/uploads/foto.png', jenis: 'sebelum' };

const fakeDb = {
  async get(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (q.includes('SELECT password FROM users WHERE id=?')) return { password: passwordHash };
    if (q.includes('FROM users WHERE id=?')) return users[Number(params[0])] || null;
    if (q.includes('FROM users WHERE email=? OR telepon=?')) {
      return Object.values(users).find((user) => user.email === params[0] || user.telepon === params[1]) || null;
    }
    if (q.includes('FROM password_reset')) return null;
    if (q.includes('FROM spk_checklist')) return { ...checklistRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM spk_foto')) return { ...fotoRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM spk_laporan')) return { spk_id: 1, teknisi_id: 2, laporan: 'Smoke test laporan' };
    if (q.includes('FROM pembayaran')) return { ...paymentRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM invoice_mitra_spk')) return { ...invoiceItemRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM invoice_mitra')) return { ...invoiceRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM booking')) return { ...bookingRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM pelanggan')) return { ...pelangganRow, id: Number(params[0]) || 3 };
    if (q.includes('FROM mitra')) return { ...mitraRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM layanan')) return { ...layananRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM armada')) return { ...armadaRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM rekening')) return rekeningRow;
    if (q.includes('FROM transaksi')) return { ...transaksiRow, id: Number(params[0]) || 1 };
    if (q.includes('FROM pengaturan')) {
      return pengaturanRows.find((row) => row.key === params[0]) || pengaturanRows[0];
    }
    if (q.includes('FROM spk')) return { ...spkRow, id: Number(params[0]) || 1 };
    if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/.test(q)) {
      return { total: 1, count: 1, omzet: 100000, pengeluaran: 0, jumlah: 1, v: 100000 };
    }
    return { v: 0, total: 0, count: 0 };
  },

  async all(sql) {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (q.includes('FROM spk_checklist')) return [checklistRow];
    if (q.includes('FROM spk_foto')) return [fotoRow];
    if (q.includes('FROM spk_laporan')) return [{ spk_id: 1, teknisi_id: 2, laporan: 'Smoke test laporan' }];
    if (q.includes('FROM pembayaran')) return [paymentRow];
    if (q.includes('FROM invoice_mitra_spk')) return [invoiceItemRow];
    if (q.includes('FROM invoice_mitra')) return [invoiceRow];
    if (q.includes('FROM booking_armada')) return [];
    if (q.includes('FROM booking')) return [bookingRow];
    if (q.includes('FROM transaksi')) return [transaksiRow];
    if (q.includes('FROM armada')) return [armadaRow];
    if (q.includes('FROM rekening')) return [rekeningRow];
    if (q.includes('FROM pengaturan')) return pengaturanRows;
    if (q.includes('FROM layanan')) return [layananRow];
    if (q.includes('FROM pelanggan')) return [pelangganRow];
    if (q.includes('FROM mitra')) return [mitraRow];
    if (q.includes('FROM users')) return [users[2], users[1], users[3], users[4]];
    if (q.includes('FROM spk')) return [spkRow];
    return [];
  },

  async run() {
    return { insertId: 1, rowCount: 1 };
  },

  async transaction(callback) {
    return callback({});
  }
};

const storageStub = {
  isRemoteConfigured: () => false,
  publicUrl: (objectPath) => `/uploads/${objectPath}`,
  toObjectPath: (value) => (value ? String(value).replace(/^\/uploads\//, '') : null),
  contentTypeForPath: () => 'image/png',
  upload: async (objectPath) => `/uploads/${objectPath}`,
  download: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  remove: async () => {}
};

const pdfBuffer = Buffer.from('%PDF-1.4\n%%EOF\n');
const pdfStub = {
  generateSPKPdf: async () => pdfBuffer,
  generateMitraInvoicePdf: async () => pdfBuffer,
  htmlToPdf: async () => pdfBuffer,
  buildPaymentStatus: () => 'LUNAS',
  resolveFotoDataUrl: async () => '',
  closeBrowser: async () => {}
};

function fakeUpload() {
  return (req, _res, next) => {
    req.file = {
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      originalname: 'foto.png',
      mimetype: 'image/png',
      size: 8
    };
    next();
  };
}
fakeUpload.single = fakeUpload;
fakeUpload.array = fakeUpload;
fakeUpload.fields = fakeUpload;
fakeUpload.any = fakeUpload;
fakeUpload.uploadDir = path.join(__dirname, '..', 'uploads');
fakeUpload.maxUploadBytes = 5 * 1024 * 1024;
fakeUpload.isAllowedImage = () => true;
fakeUpload.hasValidImageSignature = () => true;

stub('../db/database', fakeDb);
stub('../services/storage', storageStub);
stub('../services/pdfservice', pdfStub);
stub('../middleware/upload', fakeUpload);

const { createApp } = require('../server');
const { signUser } = require('../utils/security');

const tokens = {
  admin: signUser(users[1]),
  teknisi: signUser(users[2]),
  pelanggan: signUser(users[3]),
  mitra: signUser(users[4])
};

const app = createApp();

let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function request(method, endpoint, role, body) {
  const headers = {};
  if (role) headers.Authorization = `Bearer ${tokens[role]}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, contentType, payload };
}

const cases = [
  ['health API', 'GET', '/api', null],
  ['auth me admin', 'GET', '/api/auth/me', 'admin'],
  ['auth me teknisi', 'GET', '/api/auth/me', 'teknisi'],
  ['auth me pelanggan', 'GET', '/api/auth/me', 'pelanggan'],
  ['auth me mitra', 'GET', '/api/auth/me', 'mitra'],

  ['dashboard stats', 'GET', '/api/dashboard/stats', 'admin'],
  ['dashboard antrian', 'GET', '/api/dashboard/antrian', 'admin'],
  ['dashboard tren', 'GET', '/api/dashboard/tren', 'admin'],

  ['daftar SPK', 'GET', '/api/spk', 'admin'],
  ['detail SPK', 'GET', '/api/spk/1', 'admin'],
  ['detail SPK teknisi', 'GET', '/api/spk/1', 'teknisi'],
  ['detail SPK pelanggan', 'GET', '/api/spk/1', 'pelanggan'],
  ['detail SPK mitra', 'GET', '/api/spk/1', 'mitra'],
  ['PDF SPK', 'GET', '/api/spk/1/pdf', 'admin'],
  ['buat SPK', 'POST', '/api/spk', 'admin', { pelanggan_id: 3, layanan_id: 1, teknisi_id: 2, mitra_id: 1, tanggal: '2026-11-23', waktu: '10:00' }],
  ['ubah status SPK', 'PATCH', '/api/spk/1/status', 'admin', { status: 'Selesai' }],
  ['laporan teknisi', 'PUT', '/api/spk/1/laporan', 'teknisi', { laporan: 'Pengerjaan selesai dengan baik.' }],
  ['ubah teknisi SPK', 'PATCH', '/api/spk/1/teknisi', 'admin', { teknisi_id: 2 }],
  ['checklist SPK', 'PATCH', '/api/spk/1/checklist/1', 'teknisi', { selesai: true }],
  ['foto SPK', 'POST', '/api/spk/1/foto', 'teknisi', {}],

  ['tugas teknisi', 'GET', '/api/teknisi/me/tugas', 'teknisi'],
  ['daftar teknisi', 'GET', '/api/teknisi/list', 'admin'],
  ['tambah teknisi', 'POST', '/api/teknisi', 'admin', { nama: 'Teknisi Baru', telepon: '081199999999', email: 'baru@test', password: 'rahasia123' }],
  ['ubah teknisi', 'PUT', '/api/teknisi/2', 'admin', { nama: 'Teknisi Uji' }],
  ['hapus teknisi', 'DELETE', '/api/teknisi/2', 'admin'],

  ['daftar pelanggan', 'GET', '/api/pelanggan', 'admin'],
  ['tambah pelanggan', 'POST', '/api/pelanggan', 'admin', { nama: 'Pelanggan Baru', telepon: '081188888888', email: 'baru@test' }],
  ['SPK pelanggan', 'GET', '/api/pelanggan/me/spk', 'pelanggan'],
  ['profil pelanggan', 'GET', '/api/pelanggan/me/profile', 'pelanggan'],
  ['ubah profil pelanggan', 'PUT', '/api/pelanggan/me/profile', 'pelanggan', { nama: 'Pelanggan Uji' }],
  ['list pelanggan', 'GET', '/api/pelanggan/list', 'admin'],
  ['riwayat pelanggan', 'GET', '/api/pelanggan/me/riwayat', 'pelanggan'],

  ['pembayaran pelanggan', 'GET', '/api/pembayaran/me', 'pelanggan'],
  ['rekening pembayaran', 'GET', '/api/pembayaran/rekening', 'admin'],
  ['ubah rekening', 'PUT', '/api/pembayaran/rekening', 'admin', { bank: 'BCA', nomor: '123', atas_nama: 'CuciMesin' }],
  ['unggah bukti', 'POST', '/api/pembayaran/1/bukti', 'pelanggan', {}],
  ['daftar pembayaran admin', 'GET', '/api/pembayaran/admin', 'admin'],
  ['lihat bukti', 'GET', '/api/pembayaran/1/bukti', 'pelanggan'],
  ['konfirmasi pembayaran', 'PATCH', '/api/pembayaran/1/status', 'admin', { status: 'Dikonfirmasi' }],

  ['slot booking', 'GET', '/api/booking/availability?date=2026-11-24', null],
  ['daftar booking', 'GET', '/api/booking', 'admin'],
  ['ubah status booking', 'PATCH', '/api/booking/1/status', 'admin', { status: 'Diproses' }],
  ['buat booking', 'POST', '/api/booking', 'pelanggan', { layanan_id: 1, tanggal: '2026-11-24', waktu: '10:00' }],

  ['layanan publik', 'GET', '/api/layanan', null],
  ['tambah layanan', 'POST', '/api/layanan', 'admin', { nama: 'Cuci Motor', harga: 50000, durasi_menit: 30 }],

  ['ringkasan keuangan', 'GET', '/api/keuangan/ringkasan', 'admin'],
  ['analisis keuangan', 'GET', '/api/keuangan/analisis', 'admin'],
  ['transaksi keuangan', 'GET', '/api/keuangan/transaksi', 'admin'],
  ['tambah transaksi', 'POST', '/api/keuangan/transaksi', 'admin', { kategori: 'Uji', deskripsi: 'Smoke', nominal: 1000, tanggal: '2026-11-23' }],

  ['laporan ringkasan', 'GET', '/api/laporan/ringkasan', 'admin'],

  ['pengaturan publik', 'GET', '/api/pengaturan/publik', null],
  ['pengaturan admin', 'GET', '/api/pengaturan', 'admin'],
  ['ubah pengaturan', 'PUT', '/api/pengaturan', 'admin', { nama_aplikasi: 'CuciMesin' }],

  ['register mitra', 'POST', '/api/mitra/register', null, { nama_showroom: 'Mitra Baru', email: 'mitrabaru@test', telepon: '081177777777', password: 'rahasia123' }],
  ['admin mitra', 'GET', '/api/mitra/admin/mitra', 'admin'],
  ['SPK billable mitra', 'GET', '/api/mitra/admin/billable-spk', 'admin'],
  ['buat invoice mitra', 'POST', '/api/mitra/admin/invoices', 'admin', { mitra_id: 1, periode: '2026-11' }],
  ['booking admin mitra', 'GET', '/api/mitra/admin/bookings', 'admin'],
  ['status booking admin mitra', 'PATCH', '/api/mitra/admin/bookings/1/status', 'admin', { status: 'Dikonversi' }],
  ['laporan pembayaran mitra', 'GET', '/api/mitra/admin/payment-reports', 'admin'],
  ['status pembayaran invoice', 'PATCH', '/api/mitra/admin/invoices/1/payment-status', 'admin', { status: 'Lunas' }],

  ['dashboard mitra', 'GET', '/api/mitra/me/dashboard', 'mitra'],
  ['profil mitra', 'GET', '/api/mitra/me/profile', 'mitra'],
  ['pekerjaan mitra', 'GET', '/api/mitra/me/jobs', 'mitra'],
  ['invoice mitra', 'GET', '/api/mitra/me/invoices', 'mitra'],
  ['PDF invoice mitra', 'GET', '/api/mitra/me/invoices/1/pdf', 'mitra'],
  ['armada mitra', 'GET', '/api/mitra/me/armada', 'mitra'],
  ['tambah armada', 'POST', '/api/mitra/me/armada', 'mitra', { nomor: 'B 5678 XYZ', kapasitas: 5 }],
  ['ubah armada', 'PUT', '/api/mitra/me/armada/1', 'mitra', { nomor: 'B 5678 XYZ', kapasitas: 5 }],
  ['booking mitra', 'GET', '/api/mitra/me/bookings', 'mitra'],
  ['status booking mitra', 'PATCH', '/api/mitra/me/bookings/1/status', 'mitra', { status: 'Diproses' }],
  ['buat booking mitra', 'POST', '/api/mitra/me/bookings', 'mitra', { layanan_id: 1, tanggal: '2026-11-24', waktu: '10:00' }],
  ['bayar invoice mitra', 'POST', '/api/mitra/me/invoices/1/pay', 'mitra', { bukti: 'bukti.png' }],
  ['ubah profil mitra', 'PUT', '/api/mitra/me/profile', 'mitra', { nama_showroom: 'Mitra Uji' }],
  ['ubah password mitra', 'PUT', '/api/mitra/me/password', 'mitra', { password_lama: 'rahasia123', password_baru: 'rahasia1234' }]
];

test('smoke setiap alur API tidak menghasilkan 500', async () => {
  const originalError = console.error;
  console.error = () => {};
  const failures = [];

  try {
    for (const [name, method, endpoint, role, body] of cases) {
      let result;
      try {
        result = await request(method, endpoint, role, body);
      } catch (error) {
        failures.push(`${name} (${method} ${endpoint}): request gagal - ${error.message}`);
        continue;
      }
      if (result.status >= 500) {
        failures.push(`${name} (${method} ${endpoint}): HTTP ${result.status}`);
      }
    }
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(failures, []);
});

test('endpoint terproteksi menolak request tanpa token', async () => {
  const protectedCases = cases.filter(([, , , role]) => role);
  const failures = [];

  for (const [name, method, endpoint, , body] of protectedCases) {
    const result = await request(method, endpoint, null, body);
    if (result.status !== 401) {
      failures.push(`${name} (${method} ${endpoint}): HTTP ${result.status}, diharapkan 401`);
    }
  }

  assert.deepEqual(failures, []);
});

test('endpoint publik dapat diakses tanpa token', async () => {
  const publicCases = cases.filter(([, , , role]) => !role);
  const failures = [];

  for (const [name, method, endpoint, , body] of publicCases) {
    const result = await request(method, endpoint, null, body);
    if (result.status >= 500) {
      failures.push(`${name} (${method} ${endpoint}): HTTP ${result.status}`);
    }
  }

  assert.deepEqual(failures, []);
});

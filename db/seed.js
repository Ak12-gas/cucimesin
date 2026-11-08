// Legacy SQLite seed. The application uses db/seed-supabase.js via npm run seed.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./database');

function seed() {
  console.log('🌱 Seeding database CuciMesin...');

  const hash = (p) => bcrypt.hashSync(p, 10);
  const formatDate = (date) => date.toISOString().slice(0, 10);
  const dateOffset = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return formatDate(d);
  };

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (nama, email, telepon, password, role, mitra_id) VALUES (?,?,?,?,?,?)'
  );

  insertUser.run('Super Admin',   'admin@cucimesinmobil.id', '081200000001', hash('admin123'),     'admin',     null);
  insertUser.run('Ahmad Subarjo', 'ahmad@cucimesinmobil.id', '081200000002', hash('teknisi123'),   'teknisi',   null);
  insertUser.run('Dedi Setiadi',  'dedi@cucimesinmobil.id',  '081200000003', hash('teknisi123'),   'teknisi',   null);
  insertUser.run('Rian Hidayat',  'rian@cucimesinmobil.id',  '081200000004', hash('teknisi123'),   'teknisi',   null);
  insertUser.run('Abdul Kholik',  'abdul@email.com',         '081200000005', hash('pelanggan123'), 'pelanggan', null);

  const mitraExist = db.prepare('SELECT id FROM mitra WHERE email=?').get('automaju@email.com');
  if (!mitraExist) {
    const mr = db.prepare(
      'INSERT INTO mitra (nama_showroom, alamat, telepon, email, pic_nama, pic_telepon, diskon_persen) VALUES (?,?,?,?,?,?,?)'
    ).run(
      'AutoMaju Motor Tuban',
      'Jl. Letda Sucipto No. 45, Tuban',
      '(0356) 123456',
      'automaju@email.com',
      'Hendra Wijaya',
      '0812-4455-6677',
      15
    );
    insertUser.run('Hendra Wijaya', 'automaju@email.com', '081200000006', hash('mitra123'), 'mitra', mr.lastInsertRowid);
  }

  const layananCount = db.prepare('SELECT COUNT(*) c FROM layanan').get().c;
  if (layananCount === 0) {
    const insertLayanan = db.prepare(
      'INSERT INTO layanan (nama, harga, durasi_menit, deskripsi) VALUES (?,?,?,?)'
    );
    insertLayanan.run('Reguler Wash',        250000, 30, 'Perawatan harian kendaraan pribadi.');
    insertLayanan.run('Cuci Mesin Standard',  95000, 35, 'Pembersihan permukaan mesin dari debu.');
    insertLayanan.run('Cuci Mesin Premium',  150000, 45, 'Pembersihan mendalam s/d celah sempit.');
    insertLayanan.run('Engine Detailing',    350000, 60, 'Pembersihan total + restorasi plastik.');
    insertLayanan.run('Spesialis Showroom',  450000, 55, 'Restorasi nilai jual untuk B2B.');
    insertLayanan.run('Ultimate Detail',     850000, 90, 'Paket sultan untuk Car Enthusiast.');
  }

  const insertPelanggan = db.prepare(
    'INSERT OR IGNORE INTO pelanggan (nama, telepon, email, kategori) VALUES (?,?,?,?)'
  );
  insertPelanggan.run('Abdul Kholik', '081200000005', 'abdul@email.com', 'Normal');
  insertPelanggan.run('Siska Amanda', '0812-9999-8888', 'siska@email.com', 'Normal');
  insertPelanggan.run('Budi Pratama', '0812-7777-6666', null, 'Normal');

  db.prepare(`
    UPDATE pelanggan
    SET user_id = (SELECT id FROM users WHERE users.telepon = pelanggan.telepon AND users.role = 'pelanggan')
    WHERE user_id IS NULL
      AND id = (
        SELECT MIN(candidate.id)
        FROM pelanggan candidate
        WHERE candidate.telepon = pelanggan.telepon
          AND candidate.user_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pelanggan linked
        WHERE linked.user_id = (
          SELECT id FROM users
          WHERE users.telepon = pelanggan.telepon AND users.role = 'pelanggan'
        )
      )
  `).run();

  const spkCount = db.prepare('SELECT COUNT(*) c FROM spk').get().c;
  if (spkCount === 0) {
    const pelangganId = db.prepare('SELECT id FROM pelanggan WHERE telepon=?').get('081200000005').id;
    const mitraId = db.prepare('SELECT id FROM mitra WHERE email=?').get('automaju@email.com').id;
    const teknisiId = db.prepare('SELECT id FROM users WHERE role=? AND aktif=1 LIMIT 1').get('teknisi').id;
    const layananId = db.prepare('SELECT id FROM layanan WHERE nama=?').get('Cuci Mesin Standard').id;

    const insertSpk = db.prepare(`
      INSERT INTO spk (no_spk, pelanggan_id, mitra_id, plat_nomor, merk_tipe, tahun, warna,
                       layanan_id, harga, diskon, total, teknisi_id, status, catatan, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    insertSpk.run(
      'SPK-202609-001', pelangganId, mitraId, 'D 1404 VAA', 'Honda Brio Satya', '2024', 'Merah',
      layananId, 95000, 0, 95000, teknisiId, 'Selesai', 'Pembersihan mesin ringan dan masking kabel dasar.',
      '2026-09-15 09:30:00'
    );

    insertSpk.run(
      'SPK-202609-002', pelangganId, mitraId, 'B 9988 KAA', 'Toyota Avanza', '2023', 'Hitam',
      db.prepare('SELECT id FROM layanan WHERE nama=?').get('Engine Detailing').id, 350000, 0, 350000, teknisiId,
      'Dikerjakan', 'Detailing ruang mesin dan polishing plastik panel.', '2026-09-14 14:00:00'
    );

    db.prepare(`
      INSERT INTO invoice_mitra (no_invoice, mitra_id, periode_mulai, periode_selesai, total_unit, subtotal, diskon, total, status, jatuh_tempo)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      'INV-202609-001', mitraId, '2026-09-01', '2026-09-15', 2, 445000, 0, 445000, 'Belum Dibayar', '2026-09-30'
    );
  }

  const transaksiCount = db.prepare('SELECT COUNT(*) c FROM transaksi').get().c;
  if (transaksiCount === 0) {
    const mitraId = db.prepare('SELECT id FROM mitra WHERE email=?').get('automaju@email.com').id;
    const spkRows = db.prepare('SELECT id, no_spk, total FROM spk ORDER BY id').all();
    const insertTransaksi = db.prepare(`
      INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, spk_id, mitra_id, tanggal)
      VALUES (?,?,?,?,?,?,?)
    `);

    if (spkRows[0]) {
      insertTransaksi.run(
        'masuk', 'SPK', `Pembayaran ${spkRows[0].no_spk}`, spkRows[0].total, spkRows[0].id, mitraId, dateOffset(-2)
      );
    }

    insertTransaksi.run(
      'keluar', 'Operasional', 'Pembelian cairan pembersih dan perlengkapan mesin', 150000, null, null, dateOffset(-5)
    );
    insertTransaksi.run(
      'keluar', 'Gaji', 'Pembayaran honor teknisi bulanan', 2500000, null, null, dateOffset(-4)
    );
    insertTransaksi.run(
      'masuk', 'Komisi', 'Komisi mitra AutoMaju bulan September', 180000, null, mitraId, dateOffset(-1)
    );

    if (spkRows[1]) {
      insertTransaksi.run(
        'masuk', 'DP SPK', `DP ${spkRows[1].no_spk}`, Math.round(spkRows[1].total * 0.5), spkRows[1].id, mitraId, dateOffset(-1)
      );
    }
  }

  const insertSetting = db.prepare(
    'INSERT OR REPLACE INTO pengaturan (key, value) VALUES (?,?)'
  );
  insertSetting.run('nama_bisnis',       'CuciMesin Carwash');
  insertSetting.run('tagline',           '#PastiBersih,PastiTerjangkau!');
  insertSetting.run('positioning',       'Jasa Cuci Mobil Spesialis Cuci Mesin Terbaik di Indonesia');
  insertSetting.run('kontak',            '0812-3456-7890');
  insertSetting.run('email',             'cs@cucimesinmobil.id');
  insertSetting.run('alamat',            'Jl. Letda Sucipto, Tuban, Jawa Timur');
  insertSetting.run('website',           'www.cucimesinmobil.id');
  insertSetting.run('brand_blue',        '#0056B3');
  insertSetting.run('brand_red',         '#b02a37');
  insertSetting.run('font_family',       'Montserrat');
  insertSetting.run('harga_reguler',     '250000');
  insertSetting.run('diskon_b2b_persen', '15');
  insertSetting.run('garansi_text',      'Garansi Total Aman Kelistrikan. Rusak Kami Ganti 100%.');

  console.log('✅ Seed selesai!\n');
  console.log('📋 Akun demo:');
  console.log('   ADMIN    : admin@cucimesinmobil.id   / admin123');
  console.log('   TEKNISI  : ahmad@cucimesinmobil.id   / teknisi123');
  console.log('   PELANGGAN: abdul@email.com           / pelanggan123');
  console.log('   MITRA    : automaju@email.com        / mitra123');
}

seed();
process.exit(0);
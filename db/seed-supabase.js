require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./database');
const hash = (value) => bcrypt.hashSync(value, 10);
const dateOffset = (days) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };

async function seed() {
  await db.initialize();
  await db.transaction(async (connection) => {
    const mitraResult = await db.run('INSERT INTO mitra (nama_showroom, alamat, telepon, email, pic_nama, pic_telepon, diskon_persen) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET nama_showroom=EXCLUDED.nama_showroom RETURNING id', ['AutoMaju Motor Tuban', 'Jl. Letda Sucipto No. 45, Tuban', '(0356) 123456', 'automaju@email.com', 'Hendra Wijaya', '0812-4455-6677', 15], connection);
    const mitraId = mitraResult.insertId;
    const users = [
      ['Super Admin', 'admin@cucimesinmobil.id', '081200000001', 'admin123', 'admin', null],
      ['Ahmad Subarjo', 'ahmad@cucimesinmobil.id', '081200000002', 'teknisi123', 'teknisi', null],
      ['Dedi Setiadi', 'dedi@cucimesinmobil.id', '081200000003', 'teknisi123', 'teknisi', null],
      ['Rian Hidayat', 'rian@cucimesinmobil.id', '081200000004', 'teknisi123', 'teknisi', null],
      ['Abdul Kholik', 'abdul@email.com', '081200000005', 'pelanggan123', 'pelanggan', null],
      ['Hendra Wijaya', 'automaju@email.com', '081200000006', 'mitra123', 'mitra', mitraId]
    ];
    for (const [nama, email, telepon, password, role, userMitraId] of users) await db.run('INSERT INTO users (nama, email, telepon, password, role, mitra_id, aktif) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (email) DO UPDATE SET nama=EXCLUDED.nama, telepon=EXCLUDED.telepon, password=EXCLUDED.password, role=EXCLUDED.role, mitra_id=EXCLUDED.mitra_id, aktif=1', [nama, email, telepon, hash(password), role, userMitraId], connection);

    const services = [['Reguler Wash', 250000, 30, 'Perawatan harian kendaraan pribadi.'], ['Cuci Mesin Standard', 95000, 35, 'Pembersihan permukaan mesin dari debu.'], ['Cuci Mesin Premium', 150000, 45, 'Pembersihan mendalam s/d celah sempit.'], ['Engine Detailing', 350000, 60, 'Pembersihan total + restorasi plastik.'], ['Spesialis Showroom', 450000, 55, 'Restorasi nilai jual untuk B2B.'], ['Ultimate Detail', 850000, 90, 'Paket sultan untuk Car Enthusiast.']];
    for (const service of services) await db.run("INSERT INTO layanan (nama, harga, durasi_menit, deskripsi) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM layanan WHERE nama=?)", [...service, service[0]], connection);
    const customers = [['Abdul Kholik', '081200000005', 'abdul@email.com'], ['Siska Amanda', '0812-9999-8888', 'siska@email.com'], ['Budi Pratama', '0812-7777-6666', null]];
    for (const [nama, telepon, email] of customers) await db.run("INSERT INTO pelanggan (nama, telepon, email, kategori) SELECT ?, ?, ?, 'Normal' WHERE NOT EXISTS (SELECT 1 FROM pelanggan WHERE telepon=?)", [nama, telepon, email, telepon], connection);
    await db.run("UPDATE pelanggan p SET user_id=u.id FROM users u WHERE u.telepon=p.telepon AND u.role='pelanggan' AND p.user_id IS NULL", [], connection);

    const pelanggan = await db.get('SELECT id FROM pelanggan WHERE telepon=?', ['081200000005'], connection);
    const teknisi = await db.get("SELECT id FROM users WHERE role='teknisi' AND aktif=1 ORDER BY id LIMIT 1", [], connection);
    const standard = await db.get('SELECT id FROM layanan WHERE nama=?', ['Cuci Mesin Standard'], connection);
    const detailing = await db.get('SELECT id FROM layanan WHERE nama=?', ['Engine Detailing'], connection);
    if (!await db.get('SELECT id FROM spk WHERE no_spk=?', ['SPK-202609-001'], connection)) {
      const first = await db.run('INSERT INTO spk (no_spk, pelanggan_id, mitra_id, plat_nomor, merk_tipe, tahun, warna, layanan_id, harga, diskon, total, teknisi_id, status, catatan, created_at, waktu_selesai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['SPK-202609-001', pelanggan.id, mitraId, 'D 1404 VAA', 'Honda Brio Satya', '2024', 'Merah', standard.id, 95000, 0, 95000, teknisi.id, 'Selesai', 'Pembersihan mesin ringan dan masking kabel dasar.', '2026-09-15 09:30:00', '2026-09-15 10:30:00'], connection);
      const second = await db.run('INSERT INTO spk (no_spk, pelanggan_id, mitra_id, plat_nomor, merk_tipe, tahun, warna, layanan_id, harga, diskon, total, teknisi_id, status, catatan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['SPK-202609-002', pelanggan.id, mitraId, 'B 9988 KAA', 'Toyota Avanza', '2023', 'Hitam', detailing.id, 350000, 0, 350000, teknisi.id, 'Dikerjakan', 'Detailing ruang mesin dan polishing plastik panel.', '2026-09-14 14:00:00'], connection);
      const checklist = ['Masking ECU & Kabel Elektrikal', 'Check Kondisi Aki & Alternator', 'Penyemprotan Chemical Khusus', 'Bilas & Pengeringan Detail'];
      for (const spk of [first, second]) for (const [urutan, item] of checklist.entries()) await db.run('INSERT INTO spk_checklist (spk_id, item, urutan) VALUES (?, ?, ?)', [spk.insertId, item, urutan], connection);
    }
    await db.run("UPDATE spk SET waktu_selesai=COALESCE(waktu_selesai, '2026-09-15 10:30:00') WHERE no_spk='SPK-202609-001' AND status='Selesai'", [], connection);
    await db.run('INSERT INTO invoice_mitra (no_invoice, mitra_id, periode_mulai, periode_selesai, total_unit, subtotal, diskon, total, status, jatuh_tempo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (no_invoice) DO UPDATE SET periode_mulai=EXCLUDED.periode_mulai, periode_selesai=EXCLUDED.periode_selesai, total_unit=EXCLUDED.total_unit, subtotal=EXCLUDED.subtotal, diskon=EXCLUDED.diskon, total=EXCLUDED.total', ['INV-202609-001', mitraId, '2026-09-15', '2026-09-15', 1, 95000, 0, 95000, 'Belum Dibayar', '2026-09-30'], connection);
    const seededInvoiceRow = await db.get('SELECT id FROM invoice_mitra WHERE no_invoice=?', ['INV-202609-001'], connection);
    const seededSpk = await db.get("SELECT id FROM spk WHERE no_spk=? AND status='Selesai' AND waktu_selesai IS NOT NULL", ['SPK-202609-001'], connection);
    if (seededInvoiceRow && seededSpk) {
      await db.run('INSERT INTO invoice_mitra_spk (invoice_id, spk_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [seededInvoiceRow.id, seededSpk.id], connection);
    }

    const transactionCount = await db.get('SELECT COUNT(*) AS total FROM transaksi', [], connection);
    if (Number(transactionCount.total) === 0) {
      const spkRows = await db.all('SELECT id, no_spk, total FROM spk ORDER BY id', [], connection);
      if (spkRows[0]) await db.run('INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, spk_id, mitra_id, tanggal) VALUES (?, ?, ?, ?, ?, ?, ?)', ['masuk', 'SPK', `Pembayaran ${spkRows[0].no_spk}`, spkRows[0].total, spkRows[0].id, mitraId, dateOffset(-2)], connection);
      await db.run('INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, tanggal) VALUES (?, ?, ?, ?, ?)', ['keluar', 'Operasional', 'Pembelian cairan pembersih dan perlengkapan mesin', 150000, dateOffset(-5)], connection);
      await db.run('INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, tanggal) VALUES (?, ?, ?, ?, ?)', ['keluar', 'Gaji', 'Pembayaran honor teknisi bulanan', 2500000, dateOffset(-4)], connection);
      await db.run('INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, mitra_id, tanggal) VALUES (?, ?, ?, ?, ?, ?)', ['masuk', 'Komisi', 'Komisi mitra AutoMaju bulan September', 180000, mitraId, dateOffset(-1)], connection);
      if (spkRows[1]) await db.run('INSERT INTO transaksi (tipe, kategori, deskripsi, nominal, spk_id, mitra_id, tanggal) VALUES (?, ?, ?, ?, ?, ?, ?)', ['masuk', 'DP SPK', `DP ${spkRows[1].no_spk}`, Math.round(spkRows[1].total * 0.5), spkRows[1].id, mitraId, dateOffset(-1)], connection);
    }
    const settings = [['nama_bisnis', 'CuciMesin Carwash'], ['tagline', '#PastiBersih,PastiTerjangkau!'], ['positioning', 'Jasa Cuci Mobil Spesialis Cuci Mesin Terbaik di Indonesia'], ['kontak', '0812-3456-7890'], ['email', 'cs@cucimesinmobil.id'], ['alamat', 'Jl. Letda Sucipto, Tuban, Jawa Timur'], ['website', 'www.cucimesinmobil.id'], ['brand_blue', '#0056B3'], ['brand_red', '#b02a37'], ['font_family', 'Montserrat'], ['harga_reguler', '250000'], ['diskon_b2b_persen', '15'], ['garansi_text', 'Garansi Total Aman Kelistrikan. Rusak Kami Ganti 100%.']];
    for (const [key, value] of settings) await db.run('INSERT INTO pengaturan (`key`, `value`) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', [key, value], connection);
  });
  console.log('Seed Supabase selesai.');
}
seed().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
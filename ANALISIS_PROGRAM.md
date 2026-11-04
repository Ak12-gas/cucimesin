# Analisis Program CuciMesin

Tanggal analisis: 2026-09-15

## 1. Ringkasan

CuciMesin adalah aplikasi operasional jasa cuci mesin kendaraan berbasis Node.js/Express dengan MySQL/MariaDB melalui `mysql2/promise`. Aplikasi melayani empat peran:

## Setup XAMPP MySQL

1. Start Apache dan MySQL dari XAMPP Control Panel.
2. Buat database `cucimesin` melalui phpMyAdmin atau `CREATE DATABASE cucimesin CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`.
3. Salin `.env.example` menjadi `.env`, lalu isi `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, dan `JWT_SECRET`.
4. Jalankan `npm install`, kemudian `npm run seed` dan `npm run dev`.

Database SQLite lama di `data/cucimesin.db` tidak dihapus dan tetap menjadi backup. Seeding aplikasi memakai `db/seed-mysql.js`; `db/seed.js` hanya legacy SQLite dan tidak dimuat server maupun script package.

- `admin`: dashboard, SPK, pelanggan, teknisi, keuangan, laporan, pengaturan.
- `teknisi`: tugas SPK, checklist, foto sebelum/sesudah, perubahan status.
- `pelanggan`: riwayat SPK dan detail SPK miliknya.
- `mitra`: dashboard showroom, invoice, profil, dan pembayaran invoice.

Frontend disajikan sebagai berkas HTML statis dari folder `public/`. Backend dan frontend berada dalam satu repository, tanpa pemisahan build atau test suite.

## 2. Arsitektur dan alur utama

### Entry point

- `server.js` memuat dotenv, membuat Express app, memasang CORS global, parser JSON/urlencoded, static files, seluruh route API, error handler, dan listener port.
- Database memakai `mysql2/promise`; `server.js` menjalankan `await db.initialize()` sebelum listen. Skema dibuat otomatis dengan `CREATE TABLE IF NOT EXISTS`.
- `db/seed-mysql.js` mengisi akun, mitra, layanan, pelanggan, contoh SPK, checklist, invoice, transaksi, dan pengaturan dalam transaction MySQL.

### Modul backend

- `middleware/auth.js`: verifikasi JWT dan pembatasan role.
- `middleware/spk-access.js`: memuat SPK dan mengecek akses admin/teknisi/pelanggan/mitra.
- `middleware/upload.js`: upload gambar ke `uploads/` dengan batas 5 MB.
- `routes/auth.js`: login, register pelanggan, profil token.
- `routes/spk.js`: daftar/detail/SPK baru, PDF, status, checklist, foto.
- `routes/dashboard.js`: statistik, antrian, tren admin.
- `routes/keuangan.js`: ringkasan dan 100 transaksi terakhir.
- `routes/laporan.js`: jumlah SPK menurut periode.
- `routes/layanan.js`: layanan publik dan tambah layanan admin.
- `routes/mitra.js`: registrasi, dashboard, invoice, profil, password.
- `routes/pelanggan.js`: daftar pelanggan admin dan SPK pelanggan.
- `routes/teknisi.js`: tugas teknisi dan daftar teknisi admin.
- `routes/pengaturan.js`: pengaturan publik/admin.
- `routes/booking.js`: pembuatan booking publik.
- `services/pdfservice.js`: render template HTML memakai Puppeteer lalu PDF.

### Alur SPK

1. Admin membuat SPK melalui `POST /api/spk`.
2. Sistem memvalidasi referensi pelanggan, mitra, teknisi, layanan, dan diskon.
3. Sistem membuat nomor SPK, checklist default, dan audit log dalam transaksi MySQL.
4. Teknisi/admin dapat mengubah status, checklist, dan upload foto.
5. Status `Selesai` otomatis membuat transaksi pemasukan.
6. Pengguna yang berhak dapat mengunduh PDF melalui `GET /api/spk/:id/pdf`.

### Alur booking

Booking publik memvalidasi layanan, format tanggal/waktu, lalu menyimpan data ke tabel `booking`. Portal mitra juga mengelola armada, membuat dan membatalkan booking massal berstatus `Baru` atau `Diproses`, melihat dan mengunduh invoice PDF serta riwayat SPK, memperbarui profil, dan melaporkan pembayaran. Unduhan invoice hanya mengizinkan mitra pemilik invoice dan PDF menyertakan ringkasan tagihan serta daftar SPK terkait. Admin dapat melihat data mitra dan booking armada pada halaman `Mitra B2B`; booking dapat diproses, dibatalkan, atau dikonversi secara transaksional menjadi satu SPK per unit. SPK mitra berstatus `Selesai` yang belum memiliki relasi pada `invoice_mitra_spk` tersedia untuk ditagihkan, kecuali sudah tercakup dalam periode invoice lama yang belum mempunyai relasi detail. Admin menerbitkan invoice secara transaksional dari dashboard Mitra B2B; relasi unik SPK mencegah penagihan ganda, dan invoice yang diterbitkan langsung terlihat di portal mitra. Laporan pembayaran invoice harus diverifikasi admin sebelum status invoice menjadi `Lunas` dan transaksi pemasukan dicatat.

## 3. Daftar endpoint utama

Semua path berada di bawah `/api`.

| Kelompok | Endpoint | Akses |
|---|---|---|
| Auth | `POST /auth/login` | Publik |
| Auth | `POST /auth/register` | Publik, membuat pelanggan |
| Auth | `GET /auth/me` | Semua role terautentikasi |
| SPK | `GET /spk` dan `POST /spk` | Admin |
| SPK | `GET /spk/:id`, `GET /spk/:id/pdf` | Admin, teknisi, pelanggan, mitra dengan relasi sesuai |
| SPK | `PATCH /spk/:id/status` | Admin/teknisi pemilik tugas |
| SPK | `PATCH /spk/:id/checklist/:itemId` | Admin/teknisi pemilik tugas |
| SPK | `POST /spk/:id/foto` | Admin/teknisi pemilik tugas |
| Dashboard | `/dashboard/*` | Admin |
| Keuangan | `/keuangan/*` | Admin |
| Laporan | `/laporan/ringkasan` | Admin |
| Layanan | `GET /layanan` | Publik |
| Layanan | `POST /layanan` | Admin |
| Booking | `POST /booking` | Publik |
| Pelanggan | `GET /pelanggan`, `/pelanggan/list` | Admin |
| Pelanggan | `GET /pelanggan/me/spk` | Pelanggan |
| Teknisi | `GET /teknisi/me/tugas` | Teknisi |
| Mitra | `/mitra/register` | Publik |
| Mitra | `GET /mitra/me/dashboard`, `/me/profile`, `/me/armada`, `/me/bookings`, `/me/jobs`, `/me/invoices`, `/me/invoices/:id/pdf` | Mitra |
| Mitra | `POST /mitra/me/armada`, `/me/bookings`, `/me/invoices/:id/pay` | Mitra |
| Mitra | `PATCH /mitra/me/bookings/:id/status` (status `Batal` untuk booking milik mitra berstatus `Baru`/`Diproses`) | Mitra |
| Mitra | `PUT /mitra/me/profile`, `/me/password`, `/me/armada/:id` | Mitra |
| Mitra | `GET /mitra/admin/mitra`, `/admin/bookings`, `/admin/payment-reports`, `/admin/billable-spk` | Admin |
| Mitra | `POST /mitra/admin/invoices` | Admin |
| Mitra | `PATCH /mitra/admin/bookings/:id/status`, `/admin/invoices/:id/payment-status` | Admin |
| Pengaturan | `GET /pengaturan/publik` | Publik |
| Pengaturan | `GET/PUT /pengaturan` | Admin |

## 4. Temuan prioritas

### P0 - harus diperbaiki sebelum produksi

1. **Template PDF tidak sesuai dengan generator.**
   `services/pdfservice.js` mengganti placeholder seperti `{{NO_SPK}}`, `{{CHECKLIST_ITEMS}}`, dan `{{FOTO_SECTION}}`, tetapi `templates/spk-pdf.html` yang ada berisi fungsi JavaScript `unduhNota()` dan tidak berisi layout/placeholder PDF. Endpoint PDF kemungkinan menghasilkan halaman kosong atau isi yang bukan nota SPK. Perbaiki template menjadi HTML nota yang lengkap dan uji endpoint dengan PDF parser atau minimal ukuran/content PDF.
   Lokasi: `services/pdfservice.js`, `templates/spk-pdf.html`.

2. **Secret JWT memiliki fallback yang diketahui.**
   Jika `JWT_SECRET` tidak diatur, token ditandatangani dengan `dev-secret-change-me`. Ini memungkinkan pemalsuan token jika konfigurasi produksi lupa diisi. Aplikasi produksi harus gagal start ketika secret tidak tersedia dan secret harus panjang/acak.
   Lokasi: `server.js`, `middleware/auth.js`, `routes/auth.js`, `routes/mitra.js`.

3. **Token diterima melalui query string.**
   `middleware/auth.js` menerima `req.query.token`. Token dapat masuk ke access log, browser history, analytics, atau referer. Batasi token ke header `Authorization: Bearer` atau gunakan cookie HttpOnly/SameSite dengan desain CSRF yang jelas.
   Lokasi: `middleware/auth.js`.

4. **Tidak ada rate limiting atau proteksi brute force.**
   Login publik dan registrasi dapat dipanggil tanpa batas. Tambahkan rate limit berbasis IP/identifier, logging percobaan gagal, dan pertimbangkan lockout bertahap.
   Lokasi: `routes/auth.js`, `routes/mitra.js`.

5. **Upload hanya memeriksa ekstensi dan MIME request.**
   MIME HTTP dapat dipalsukan. File disajikan langsung dari `/uploads`. Validasi magic bytes dengan library image parser, normalisasi/rekode gambar, dan simpan di lokasi yang tidak dapat mengeksekusi script. Error upload juga perlu ditangani dengan respons terkontrol.
   Lokasi: `middleware/upload.js`, `server.js`.

### P1 - risiko fungsional dan keamanan penting

1. **Relasi bisnis utama tidak memiliki foreign key.**
   `spk.pelanggan_id`, `spk.mitra_id`, `spk.layanan_id`, `spk.teknisi_id`, relasi `transaksi`, `invoice_mitra`, `booking`, serta relasi user-mitra tidak didefinisikan sebagai foreign key. Validasi route tidak cukup untuk semua jalur tulis. Tambahkan FK/index dan migrasi data yang sudah ada.
   Lokasi: `db/database.js`.

2. **Identitas pelanggan dicocokkan menggunakan nomor telepon.**
   `middleware/spk-access.js` dan `routes/pelanggan.js` mencari pelanggan berdasarkan telepon, bukan hubungan eksplisit user -> pelanggan. Tabel `pelanggan.telepon` juga tidak unik. Dua record pelanggan dengan nomor sama dapat menyebabkan akses silang atau riwayat tercampur. Tambahkan `pelanggan.user_id` atau relasi akun yang eksplisit.
   Lokasi: `middleware/spk-access.js`, `routes/pelanggan.js`, `db/database.js`.

3. **Registrasi mitra tidak atomik.**
   `routes/mitra.js` memasukkan record `mitra` lalu record `users` tanpa transaksi. Jika insert user gagal karena constraint atau error lain, mitra yatim tertinggal. Bungkus kedua insert dalam `db.transaction()`.

4. **Error handler membocorkan pesan internal.**
   `server.js` mengirim `err.message` langsung ke klien. Pesan SQLite, filesystem, atau library dapat mengungkap detail internal. Log detail di server, kirim pesan generik ke klien, dan petakan error validasi secara eksplisit.

5. **CORS terbuka untuk semua origin.**
   `app.use(cors())` menerima origin apa pun. Batasi ke origin frontend yang diset melalui environment, terutama jika autentikasi dipindahkan ke cookie.
   Lokasi: `server.js`.

6. **Password reset hanya ada di UI, belum ada API.**
   Halaman pelanggan dan portal mitra menampilkan alur lupa/reset password, tetapi backend tidak memiliki endpoint token reset, pengiriman instruksi, expiry, atau validasi token. Tombol hanya berpindah layar. Hapus UI sementara atau implementasikan reset yang aman dengan token sekali pakai dan masa berlaku.
   Lokasi: `public/pelanggan-portal.html`, `public/portal-mitra.html`, `routes/auth.js`, `routes/mitra.js`.

7. **Status selesai otomatis dicatat sebagai pembayaran.**
   Perubahan SPK ke `Selesai` langsung membuat transaksi `masuk`, sementara PDF juga menampilkan status `LUNAS` hanya berdasarkan status selesai. Secara bisnis pengerjaan selesai dan pembayaran lunas bisa berbeda. Pisahkan status pengerjaan dari status pembayaran atau konfirmasi aturan bisnis ini secara eksplisit.
   Lokasi: `routes/spk.js`, `services/pdfservice.js`, `db/database.js`.

8. **Nomor SPK/invoice berpotensi race condition.**
   Generator membaca nomor terakhir lalu menambah satu. Retry hanya menangani constraint unik, tetapi konkurensi tinggi tetap bergantung pada retry dan tidak ada generator sequence khusus. Gunakan sequence/transaction yang lebih kuat atau tetapkan retry dengan batas dan observability.
   Lokasi: `utils/helper.js`, `routes/spk.js`.

### P2 - kelengkapan produk dan maintainability

1. **Booking belum memiliki workflow operasional.** Tidak ada daftar admin, update status, validasi bentrok jadwal, atau konversi booking ke SPK.
2. **Laporan sangat minimal.** Hanya mengembalikan jumlah SPK; belum ada omzet, biaya, status, layanan, teknisi, mitra, atau ekspor.
3. **Keuangan belum memiliki route tulis admin.** Transaksi hanya dibuat otomatis oleh status SPK atau pembayaran invoice.
4. **Layanan hanya bisa ditambah.** Tidak ada edit/nonaktif/delete route meskipun kolom `aktif` tersedia.
5. **Frontend mengandung banyak data demo statis.** Contoh yang terlihat di dashboard pelanggan, teknisi, dan portal mitra dapat berbeda dari database. Endpoint dinamis perlu menjadi sumber data tunggal dan state loading/error/empty perlu ditambahkan.
6. **Tidak ada test suite.** `package.json` hanya memiliki `start`, `dev`, dan `seed`; belum ada test, lint, migration, atau health-check script.
7. **Aplikasi sulit diuji sebagai modul.** `server.js` langsung memanggil `app.listen()` saat di-require dan tidak mengekspor app. Pisahkan pembuatan app dari listener agar route dapat diuji dengan Supertest.
8. **Penanganan tanggal tidak konsisten.** Sebagian query memakai `toISOString()` UTC, sebagian memakai `localtime`, dan SPK memakai helper waktu lokal. Ini dapat menggeser statistik di sekitar pergantian hari atau timezone server.
9. **Seed menyimpan kredensial demo plaintext di source.** Aman hanya untuk development; jangan gunakan akun/password tersebut di lingkungan nyata dan pindahkan seed demo ke konfigurasi development.
10. **Validasi input belum seragam.** Contoh `layanan.js` menerima harga/durasi tanpa validasi numerik/rentang, `booking.js` hanya memeriksa pola tanggal/waktu tanpa memastikan tanggal valid atau slot tersedia, dan pengaturan admin menerima semua key dari body.

## 5. Hal yang sudah berjalan baik

- Password disimpan dengan `bcryptjs`, bukan plaintext.
- Query database memakai prepared statement pada route yang ditinjau.
- JWT memiliki expiry yang dapat dikonfigurasi.
- Status SPK memakai allowlist dan transition map.
- Operasi pembuatan SPK, checklist, audit, dan pembayaran invoice memakai transaksi pada bagian yang relevan.
- Upload memiliki batas ukuran 5 MB dan allowlist ekstensi/MIME dasar.
- Akses detail SPK memakai middleware terpusat, bukan pemeriksaan berbeda di setiap handler.
- SQLite WAL dan foreign key pragma untuk relasi yang memang didefinisikan sudah diaktifkan.

## 6. Urutan perbaikan yang disarankan

1. Ganti secret JWT fallback dengan fail-fast, hilangkan token query string, batasi CORS, dan tambahkan rate limit login.
2. Perbaiki/rebuild template PDF lalu uji endpoint PDF end-to-end.
3. Tambahkan relasi akun pelanggan yang eksplisit dan audit seluruh aturan akses.
4. Amankan upload dengan validasi isi file/rekode gambar dan penyimpanan non-eksekutabel.
5. Tambahkan transaksi registrasi mitra, error response generik, dan validasi input terpusat.
6. Putuskan model pembayaran: selesai versus lunas, lalu migrasikan schema/API/UI secara konsisten.
7. Lengkapi workflow booking, route CRUD layanan, dan laporan/keuangan sesuai kebutuhan operasional.
8. Pisahkan `createApp()` dari `listen()`, tambahkan test route/auth/SPK/access control, dan jalankan test pada CI.
9. Kurangi data demo statis pada UI dan sambungkan setiap portal ke endpoint backend dengan state loading/error/empty.

## 7. Validasi yang dilakukan

- Semua berkas JavaScript yang ditemukan berhasil melewati `node --check`.
- Inventaris route, middleware, database, service, template, dan halaman publik ditinjau.
- Pencarian pemakaian `fetch`, `/api/`, `localStorage`, auth, status SPK, checklist, dan foto dilakukan untuk mencocokkan UI dengan backend.
- Belum ada test otomatis yang dapat dijalankan karena repository belum menyediakan test script atau test suite.

## 8. Kesimpulan

Fondasi aplikasi sudah cukup jelas untuk MVP internal: route terpisah per domain, role-based JWT, workflow SPK, audit, invoice, upload, dan PDF sudah dirancang. Namun aplikasi belum siap dipakai sebagai layanan produksi tanpa perbaikan P0/P1, terutama secret JWT, token query, upload, kontrol akses pelanggan, template PDF, reset password, dan pemisahan status selesai dari pembayaran. Prioritas paling bernilai adalah mengamankan autentikasi/upload lalu menambahkan test untuk akses SPK dan alur status sebelum memperluas fitur bisnis.

## 9. Perbaikan yang sudah diterapkan

Perubahan pada sesi perbaikan ini:

- JWT dipusatkan di `utils/security.js`; production gagal start bila `JWT_SECRET` tidak diatur.
- Token melalui query string dihapus; autentikasi hanya memakai header Bearer.
- `server.js` sekarang menyediakan `createApp()`, membatasi ukuran body, mengatur CORS melalui `CORS_ORIGINS`, dan tidak membocorkan pesan error internal.
- Login/registrasi memiliki rate limit sederhana.
- Template PDF diganti menjadi nota SPK yang benar dan nilai dinamis di-escape sebelum dirender.
- Upload memeriksa signature JPEG/PNG/WebP, dan error ukuran/file ditangani sebagai respons 400.
- Registrasi mitra dan pelanggan dibuat atomik.
- Akun pelanggan memakai `pelanggan.user_id`; akses riwayat/detail tidak lagi bergantung pada nomor telepon.
- Seed melakukan backfill relasi pelanggan, termasuk untuk database development baru.
- Validasi layanan dan tanggal/waktu booking diperketat.
- Admin dapat melihat booking dan mengubah status booking.

## 10. Backlog yang masih tersisa

Perbaikan penuh masih memerlukan foreign key untuk seluruh tabel bisnis, reset password berbasis token, workflow konversi booking ke SPK, pemisahan status pengerjaan dan pembayaran, pengujian otomatis formal, serta penggantian data demo statis pada frontend. CORS production harus diisi, misalnya `CORS_ORIGINS=https://domain-frontend.example`.

## 11. Status Migrasi XAMPP MySQL

Aplikasi sudah dipindahkan dari adapter SQLite ke MySQL/MariaDB melalui `mysql2/promise`.

Setup XAMPP:

1. Buka XAMPP Control Panel dan jalankan **MySQL**. Apache tidak wajib untuk backend Node.js ini.
2. Buka `http://localhost/phpmyadmin`.
3. Buat database bernama `cucimesin` dengan collation `utf8mb4_unicode_ci`.
4. Pastikan `.env` berisi `DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_NAME=cucimesin`, `DB_USER=root`, dan password MySQL XAMPP.
5. Jalankan `npm install`.
6. Jalankan `npm run seed` untuk membuat schema dan data demo.
7. Jalankan `npm run dev` atau `npm start`.

Schema MySQL tersimpan di `db/schema-mysql.sql`. File SQLite `data/cucimesin.db` tidak dihapus dan tetap menjadi backup lama; aplikasi aktif sekarang memakai MySQL sesuai `.env`.

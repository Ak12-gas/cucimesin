# Analisis Program CuciMesin

Tanggal analisis: 2026-09-15

## 1. Ringkasan

CuciMesin adalah aplikasi operasional jasa cuci mesin kendaraan berbasis Node.js/Express dengan PostgreSQL Supabase melalui `pg`. Aplikasi melayani empat peran.

## Setup Supabase

1. Buat project Supabase dan salin connection string PostgreSQL dari **Connect**.
2. Salin `.env.example` menjadi `.env`, lalu isi `DATABASE_URL` dan `JWT_SECRET`.
3. Jalankan `npm install`, kemudian `npm run dev`.

Untuk menyalin data MySQL lama, isi `SOURCE_DB_*` dan `DATABASE_URL`, lalu jalankan `npm run migrate:supabase`. Database SQLite di `data/cucimesin.db` bukan sumber aktif backend dan tidak disalin. Seeding aplikasi memakai `db/seed-supabase.js`; seed SQLite lama sudah dihapus.

- `admin`: dashboard, SPK, pelanggan, teknisi, keuangan, laporan, pengaturan.
- `teknisi`: tugas SPK, checklist, foto sebelum/sesudah, perubahan status.
- `pelanggan`: riwayat SPK dan detail SPK miliknya.
- `mitra`: dashboard showroom, invoice, profil, dan pembayaran invoice.

Frontend disajikan sebagai berkas HTML statis dari folder `public/`. Backend dan frontend berada dalam satu repository, tanpa build step; backend memiliki test suite bawaan `node:test` yang dijalankan dengan `npm test`.

## 2. Arsitektur dan alur utama

### Entry point

- `server.js` memuat dotenv, membuat Express app, memasang CORS global, parser JSON/urlencoded, static files, seluruh route API, error handler, dan listener port.
- Database memakai `pg`; `server.js` menjalankan `await db.initialize()` sebelum listen. Skema PostgreSQL Supabase dibuat otomatis dengan `CREATE TABLE IF NOT EXISTS`.
- `db/seed-supabase.js` mengisi data demo dalam transaction PostgreSQL. Script ini hanya untuk development.

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
3. Sistem membuat nomor SPK, checklist default, dan audit log dalam transaksi PostgreSQL.
4. Teknisi/admin dapat mengubah status, checklist, dan upload foto.
5. Status `Selesai` tidak otomatis membuat transaksi pemasukan; transaksi baru dicatat setelah admin mengonfirmasi pembayaran.
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

## 4–8. Arsip audit awal (per 2026-11-23)

Bagian ini adalah catatan historis dari audit sebelum perbaikan. Klaim di bawah
**sudah tidak mencerminkan kode saat ini**; rincian perbaikan dan sisa pekerjaan
ada di §9–§10.

Temuan yang dulu masuk prioritas P0/P1 meliputi: template PDF yang tidak sesuai
generator, fallback secret JWT, token lewat query string, tanpa rate limiting,
validasi upload hanya berdasarkan ekstensi/MIME, FK yang dianggap belum lengkap,
identitas pelanggan berbasis telepon, registrasi mitra bukan transaksi, error
handler yang membocorkan pesan internal, CORS terbuka, reset password hanya di UI,
status selesai disamakan dengan lunas, dan generator nomor yang rawan race.
Pada P2 tercatat pula keterbatasan workflow booking, laporan, CRUD layanan,
validasi input, data demo statis, belum adanya test, dan aplikasi yang belum bisa
diuji sebagai modul.

Semua item keamanan dan fungsional di atas telah ditangani sampai batas yang
dijelaskan di §9. Status terbaru: FK untuk relasi bisnis utama diverifikasi sudah ada di
`db/schema-supabase.sql`; tidak perlu menambah constraint baru. Catatan ini
dipertahankan hanya sebagai jejak audit, bukan daftar tugas aktif.

Validasi terkini: `npm test` (mencakup auth/reset + webhook, identitas pelanggan,
matriks akses SPK, batas periode/transaksi keuangan, rate limit, timezone,
generator nomor, status PDF, pemetaan path Storage, batas upload, navigasi reset
frontend, serta smoke test seluruh alur API melalui `createApp()` dengan fake
DB/storage/PDF), `node --check`
untuk seluruh JavaScript aktif, smoke test `GET /api`, dan render PDF.

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
- Status LUNAS pada PDF SPK sekarang berasal dari `pembayaran.status` (pelanggan) atau `invoice_mitra.status` (mitra), bukan dari status SPK; alur "Selesai tapi belum bayar" diuji lewat `npm test`.
- Fallback identitas lewat nomor telepon dihapus; `backfillCustomerLinks()` hanya menautkan data dengan nomor unik saat startup.
- Rate limiter memakai Upstash bila tersedia, mengambil IP dari `X-Forwarded-For` pertama di Vercel, dan memberi peringatan bila production masih memakai memory store.
- Upload memakai `services/storage.js` (Supabase Storage bila dikonfigurasi), sehingga tidak bergantung pada `/tmp` ephemeral di Vercel.
- Seluruh waktu distandardisasi ke Asia/Jakarta (WIB) lewat `utils/timezone.js`; sesi Postgres juga diset ke timezone yang sama.
- Generator nomor SPK/invoice diserialisasi dengan advisory lock Postgres per prefix.
- Pemulihan password memakai token ber-hash yang kedaluarsa 30 menit dan sekali pakai; UI portal pelanggan dan mitra sudah terhubung ke endpoint `/api/auth/forgot-password` dan `/api/auth/reset-password`.
- CI menjalankan `npm ci`, `node --check` untuk berkas JavaScript aktif, dan `npm test`.
- Batas upload disesuaikan dengan batas body Vercel (4 MB saat `VERCEL`).
- `npm run migrate:uploads` menyalin file upload lama ke Supabase Storage (dry-run default, `--apply` untuk mengunggah).
- Test ditambah untuk matriks akses SPK per role, validasi periode/tanggal transaksi keuangan, batas upload Vercel, pemetaan path Storage, dan pengiriman webhook reset.
- Webhook reset kini memakai timeout 5 detik, memeriksa status respons, dan tidak menggagal respons `forgot-password` bila pengiriman gagal.
- `storage.toObjectPath()` dinormalisasi lebih dulu sehingga `/uploads/`, `///uploads/`, dan `uploads/` dipetakan ke object path yang sama.
- Verifikasi skema: foreign key untuk relasi bisnis utama sudah didefinisikan di `db/schema-supabase.sql`.
- Berkas legacy usang `diagnose.js`, `db/seed.js`, dan `db/schema-mysql.sql` dihapus; `data/*.db` dan `api-backup/` sengaja dipertahankan.
- Smoke test `test/route-flow-smoke.test.js` memasang semua domain API lewat `createApp()` dan mengecek ~70 endpoint perwakilan: tidak ada HTTP 5xx, endpoint terproteksi menolak request tanpa token dengan 401, dan endpoint publik tetap bisa diakses.
- Setelah `forgot-password` berhasil, portal pelanggan dan mitra kini mengisi `dev_token` (bila ada), meneruskan pesan sukses ke form reset, lalu otomatis berpindah ke `auth-reset`; regresinya dijaga oleh `test/frontend-reset-navigation.test.js`.

## 10. Backlog yang masih tersisa

- Konfigurasi lingkungan produksi: `CORS_ORIGINS` dan `UPSTASH_*` wajib diisi agar CORS dibatasi dan rate limit berlaku lintas instance. `RESET_WEBHOOK_URL` perlu diarahkan ke pengirim email/WhatsApp nyata; token reset sudah diamankan dan webhook generik sudah tersedia dengan timeout 5 detik serta pengecekan status respons.
- Data demo statis pada frontend perlu ditinjau lagi. Tidak ada penanda `demo`, `dummy`, atau `mock` yang ditemukan di `public/*.html`, jadi ini bukan lagi pekerjaan otomatis: periksa tiap portal terhadap endpoint backend dan tambahkan state loading/error/empty bila belum ada.
- Berkas legacy usang (`diagnose.js`, `db/seed.js`, `db/schema-mysql.sql`) sudah dihapus. `data/*.db` dipertahankan karena berisi data lama, dan `api-backup/` dipertahankan sesuai instruksi.
- Batas upload kini mengikuti platform: 4 MB saat `VERCEL`, 5 MB di lingkungan lain; dokumentasi deployment sudah diselaraskan.
- Skrip `npm run migrate:uploads` tersedia untuk menyalin file lama ke Supabase Storage tanpa mengubah path di database. Jalankan dry-run lebih dulu, lalu `--apply` setelah rencana diperiksa.

## 11. Status Migrasi Supabase

Aplikasi menggunakan PostgreSQL Supabase melalui `pg`. Skema baru tersimpan di
`db/schema-supabase.sql`; saat API mulai, tabel dan index yang belum ada dibuat
secara otomatis.

Untuk development, isi `DATABASE_URL` pada `.env` dengan connection string
Supabase. Untuk menyalin data MySQL lama, isi `SOURCE_DB_*` dan jalankan
`npm run migrate:supabase`. Skrip hanya menerima target Supabase yang kosong;
data SQLite lama bukan sumber aktif backend dan tidak dimigrasikan.

Untuk deployment Vercel, ikuti [VERCEL.md](./VERCEL.md).

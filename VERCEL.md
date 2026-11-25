# Deploy CuciMesin ke Vercel dengan Supabase

Aplikasi menyajikan halaman dari `public/` dan menjalankan Express sebagai
Vercel Functions. Database aplikasi menggunakan PostgreSQL Supabase; Supabase
menyediakan koneksi database, sedangkan Vercel menjalankan web dan API.

## 1. Siapkan Supabase

1. Buat project Supabase dan tunggu sampai database siap.
2. Dari **Connect** di Supabase, salin connection string **Transaction pooler**
   (port `6543`). Jangan gunakan `localhost` atau kredensial database di file
   frontend.
3. Simpan connection string tersebut sebagai `DATABASE_URL`. URL Supabase
   biasanya memakai `sslmode=require`.

## 2. Pindahkan data MySQL

Skrip migrasi menyalin seluruh tabel aplikasi dari MySQL ke Supabase dan menjaga
ID yang ada. Hentikan sementara penulisan ke database lama selama migrasi, dan
pastikan database Supabase target masih kosong. Jangan jalankan skrip ini lagi
pada database yang sudah berisi data.

Di komputer yang dapat terhubung ke MySQL lama:

1. Atur `DATABASE_URL` ke connection string Supabase. Atur koneksi MySQL lama
   sebagai `SOURCE_DB_HOST`, `SOURCE_DB_PORT`, `SOURCE_DB_NAME`, `SOURCE_DB_USER`,
   dan `SOURCE_DB_PASSWORD`. Variabel `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
   dan `DB_PASSWORD` lama juga dapat digunakan sebagai sumber.
2. Jalankan:

   ```powershell
   npm run migrate:supabase
   ```

Skrip membuat skema PostgreSQL, memindahkan semua tabel dalam satu transaksi,
dan membatalkan migrasi jika target tidak kosong. Pastikan hasil log menunjukkan
jumlah baris setiap tabel dan pesan migrasi selesai. Simpan backup MySQL sampai
data di Supabase dan alur aplikasi berhasil diverifikasi. File SQLite lama di
`data/` bukan sumber aktif backend dan tidak disalin oleh skrip ini.

## 3. Hubungkan repository ke Vercel

1. Push perubahan ke repository Git dan import repository itu di Vercel.
2. Pilih root repository sebagai **Root Directory**. Vercel membaca
   `vercel.json` untuk web statis, API Functions, schema, dan template PDF.
   Entry point di `api/<route>/[...path].js` meneruskan URL API bertingkat
   (misalnya `/api/auth/login`) ke handler Express.
3. Di **Project Settings → Environment Variables**, tambahkan untuk Preview dan
   Production:

   ```text
   # Wajib / wajib produksi
   DATABASE_URL=<Supabase Transaction pooler connection string>
   JWT_SECRET=<secret acak minimal 32 byte>

   # Wajib fungsional produksi
   RESET_WEBHOOK_URL=<endpoint pengirim email/WhatsApp/SMS kode reset>

   # Wajib untuk penyimpanan file persisten di Vercel (bucket privat)
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key Supabase>
   SUPABASE_STORAGE_BUCKET_SPK=cucimesin-spk
   SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS=cucimesin-payment-proofs
   # SUPABASE_STORAGE_BUCKET=cucimesin  # Opsional legacy/compat; bukan pengganti bucket privat baru

   # Sangat direkomendasikan untuk Vercel/serverless
   UPSTASH_REDIS_REST_URL=<Upstash Redis REST URL>
   UPSTASH_REDIS_REST_TOKEN=<Upstash Redis REST token>
   TRUST_PROXY=1
   DB_CONNECTION_LIMIT=1

   # Opsional
   APP_TIME_ZONE=Asia/Jakarta
   JWT_EXPIRES=7d
   CORS_ORIGINS=<isi hanya jika frontend beda origin>
   RESET_WEBHOOK_TOKEN=<opsional, bearer token webhook>
   NODE_ENV=production
   # APP_ENV=staging hanya untuk environment staging terisolasi (fail-closed)
   ```

   Catatan klasifikasi:
   - **Wajib**: `DATABASE_URL`.
   - **Wajib produksi**: `JWT_SECRET` (app gagal start di production jika kosong).
   - **Wajib fungsional produksi**: `RESET_WEBHOOK_URL`; tanpa ini token reset tidak dikirim ke user dan `dev_token` tidak dikembalikan di production.
   - **Wajib untuk file persisten di Vercel**: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_STORAGE_BUCKET_SPK` + `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`. Kedua bucket bersifat **private**. Foto SPK diakses lewat **backend proxy** berautorisasi; signed URL hanya fallback foto SPK dengan TTL **60 detik** (on-demand, tidak dipersist). Bukti pembayaran **tidak** menggunakan signed URL. Tanpa config remote, fallback lokal `/tmp` bersifat ephemeral.
   - **Wajib saat `APP_ENV=staging`**: `APP_ENV=staging`, `DATABASE_URL` eksplisit (tanpa fallback `SUPABASE_DATABASE_URL`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET_SPK`, `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`. Validasi staging fail-closed dan hanya menyebut nama variabel yang hilang.
   - **Legacy/compat (opsional)**: `SUPABASE_STORAGE_BUCKET` (jangan pengganti bucket privat baru).
   - **Direkomendasikan serverless**: `UPSTASH_REDIS_REST_URL/TOKEN`, `TRUST_PROXY=1`, `DB_CONNECTION_LIMIT=1`.
   - **Opsional**: `JWT_EXPIRES`, `APP_TIME_ZONE`, `CORS_ORIGINS`, `RESET_WEBHOOK_TOKEN`, `NODE_ENV`, `SUPABASE_DATABASE_URL` (alias `DATABASE_URL` hanya mode non-staging).
   - **Khusus migrasi lokal, jangan di Vercel**: `SOURCE_DB_*` atau alias `DB_HOST/PORT/NAME/USER/PASSWORD`.
   - **Khusus Docker/container, bukan Vercel**: `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_SKIP_DOWNLOAD`, `UPLOAD_DIR`, `PAYMENT_UPLOAD_DIR` (Vercel meremap ke `/tmp`).

   Buat `JWT_SECRET` dengan:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   Panduan penting:
   - `JWT_SECRET` wajib di production.
   - `RESET_WEBHOOK_URL` diperlukan agar reset password produksi dapat dikirim.
   - Supabase Storage wajib untuk penyimpanan file persisten di Vercel.
   - Untuk staging terisolasi, gunakan `APP_ENV=staging` dan isi semua env staging wajib secara eksplisit; `SUPABASE_DATABASE_URL` tidak dipakai sebagai fallback `DATABASE_URL` saat staging.
   - Simpan secret hanya di environment platform/server; jangan commit ke Git dan jangan ekspos ke frontend.
   - Upstash direkomendasikan untuk serverless agar rate limit berlaku lintas instance.
   - `TRUST_PROXY=true` tidak diperbolehkan; gunakan hop count seperti `TRUST_PROXY=1`.
   - `PORT` disediakan oleh platform deployment; jangan diset di Vercel.
   - `CORS_ORIGINS` tidak diperlukan jika frontend dan API memakai domain yang sama.
   - `SUPABASE_DATABASE_URL` dapat dipakai sebagai alias `DATABASE_URL` pada mode non-staging, tetapi dokumentasi utama memakai `DATABASE_URL`.
   - Jangan masukkan `SOURCE_DB_*`/`DB_*` sumber migrasi ke Vercel.
4. Deploy. API memastikan skema tersedia saat mulai, sehingga database user
   harus diizinkan membuat tabel dan index. Setelah deploy, buka
   `https://<domain>/api`; respons yang diharapkan memuat `"status":"ok"`.

## Batasan dan verifikasi

- Database dipindahkan, tetapi file foto SPK dan bukti pembayaran lama tidak ikut
  disalin oleh migrasi database. Upload baru disimpan ke Supabase Storage privat jika
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET_SPK`, dan
  `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS` diisi; tanpa config remote yang lengkap, backend
  jatuh ke `/tmp` yang ephemeral dan tidak dibagikan antar-instance. Foto SPK dilayani lewat
  backend proxy berautorisasi; signed URL hanya fallback foto SPK TTL 60 detik (on-demand,
  tidak dipersist). Bukti pembayaran tidak menggunakan signed URL. Untuk menyalin file lama ke
  Supabase Storage tanpa mengubah path di database, jalankan `npm run migrate:uploads`
  (default dry-run; tidak mutasi DB, tidak overwrite konflik checksum, tidak menghapus file
  sumber otomatis) lalu `npm run migrate:uploads -- --apply` hanya setelah mapping/persetujuan
  eksplisit.
- Batas request/response Vercel adalah 4.5 MB, lebih kecil dari batas aplikasi
  5 MB. Saat `VERCEL` diset, batas multer diturunkan menjadi 4 MB agar file yang
  terlalu besar ditolak oleh API dengan respons JSON, bukan oleh platform.
- Fungsi PDF memakai Chromium yang dibundel untuk runtime Vercel dan tunduk pada
  batas durasi function (`maxDuration` 60 detik).
- Setelah deploy, uji login, booking, pembuatan SPK, pembayaran, laporan, dan PDF.
  Jangan jalankan `npm run seed` pada production karena script itu membuat akun
  demo dengan kata sandi yang diketahui. Buat atau ganti akun admin production
  secara aman.

Untuk deployment container Railway, lihat [DEPLOYMENT.md](./DEPLOYMENT.md).

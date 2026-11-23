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
   DATABASE_URL=<Supabase Transaction pooler connection string>
   DB_CONNECTION_LIMIT=1
   APP_TIME_ZONE=Asia/Jakarta
   JWT_SECRET=<secret acak minimal 32 byte>
   RESET_WEBHOOK_URL=<opsional, pengirim kode reset password>
   RESET_WEBHOOK_TOKEN=<opsional>
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key Supabase>
   SUPABASE_STORAGE_BUCKET=cucimesin
   TRUST_PROXY=1
   UPSTASH_REDIS_REST_URL=<opsional, untuk rate limit bersama>
   UPSTASH_REDIS_REST_TOKEN=<opsional>
   ```

   Buat `JWT_SECRET` dengan:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   Jangan masukkan `SOURCE_DB_*` ke Vercel; variabel itu hanya untuk migrasi
   lokal. Jangan mengisi `PORT`; Vercel mengaturnya. `CORS_ORIGINS` tidak
   diperlukan jika frontend dan API memakai domain yang sama. `TRUST_PROXY=1`
   membuat `req.ip` mengikuti `X-Forwarded-For` Vercel; tanpa itu semua user
   bisa dianggap berasal dari IP proxy yang sama oleh rate limiter. Buat bucket
   `SUPABASE_STORAGE_BUCKET` dengan akses public untuk foto SPK; bukti pembayaran
   tetap lewat endpoint API yang diautentikasi. Tanpa `UPSTASH_*`, rate limit
   hanya berlaku per instance function.
4. Deploy. API memastikan skema tersedia saat mulai, sehingga database user
   harus diizinkan membuat tabel dan index. Setelah deploy, buka
   `https://<domain>/api`; respons yang diharapkan memuat `"status":"ok"`.

## Batasan dan verifikasi

- Database dipindahkan, tetapi file foto SPK dan bukti pembayaran lama tidak ikut
  disalin oleh migrasi database. Upload baru disimpan ke Supabase Storage jika
  `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` diisi; tanpa keduanya backend
  jatuh ke `/tmp` yang ephemeral dan tidak dibagikan antar-instance. Untuk
  menyalin file lama ke Supabase Storage tanpa mengubah path di database, jalankan
  `npm run migrate:uploads` (dry-run) lalu `npm run migrate:uploads -- --apply`.
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

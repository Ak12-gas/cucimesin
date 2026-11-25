# Deploy CuciMesin ke Railway

Untuk deployment serverless di Vercel, ikuti [VERCEL.md](./VERCEL.md). Panduan
ini memakai Railway hanya untuk menjalankan aplikasi; database tetap PostgreSQL
di Supabase.

## 1. Siapkan project Railway

1. Push project ke repository Git private, lalu buat project Railway dari
   repository tersebut. Jangan unggah `.env`, `data/`, atau file upload ke
   repository.
2. Hubungkan service aplikasi ke project. Railway akan mendeteksi `Dockerfile`
   di root project.
3. Jika upload file akan digunakan, tambahkan volume dengan mount path `/data`.
   Jangan jalankan beberapa replica jika file masih disimpan pada volume lokal.

## 2. Atur environment variables

Tambahkan variabel berikut pada service aplikasi:

```text
# Wajib / wajib produksi
DATABASE_URL=<Supabase Transaction pooler connection string>
JWT_SECRET=<secret acak yang panjang>
NODE_ENV=production
# APP_ENV=staging hanya untuk environment staging terisolasi (opsional, fail-closed)

# Wajib fungsional produksi
RESET_WEBHOOK_URL=<endpoint pengirim email/WhatsApp/SMS kode reset>

# Direkomendasikan produksi (persisten & shared, bucket privat)
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key Supabase>
SUPABASE_STORAGE_BUCKET_SPK=cucimesin-spk
SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS=cucimesin-payment-proofs
# SUPABASE_STORAGE_BUCKET=cucimesin  # Opsional legacy/compat; bukan pengganti bucket privat baru
UPSTASH_REDIS_REST_URL=<Upstash Redis REST URL>
UPSTASH_REDIS_REST_TOKEN=<Upstash Redis REST token>

# Khusus Docker/Railway
UPLOAD_DIR=/data/uploads
PAYMENT_UPLOAD_DIR=/data/payment-proofs
TRUST_PROXY=<hop count/IP proxy tepercaya, bukan "true">

# Opsional
DB_CONNECTION_LIMIT=5
APP_TIME_ZONE=Asia/Jakarta
JWT_EXPIRES=7d
CORS_ORIGINS=<isi hanya jika frontend beda origin>
RESET_WEBHOOK_TOKEN=<opsional, bearer token webhook>
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_SKIP_DOWNLOAD=true
```

Klasifikasi:
- **Wajib**: `DATABASE_URL`.
- **Wajib produksi**: `JWT_SECRET`, `NODE_ENV=production`.
- **Wajib fungsional produksi**: `RESET_WEBHOOK_URL`; tanpa ini token reset tidak dikirim ke user dan `dev_token` tidak dikembalikan di production.
- **Wajib saat `APP_ENV=staging`**: `APP_ENV=staging`, `DATABASE_URL` eksplisit (tanpa fallback `SUPABASE_DATABASE_URL`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET_SPK`, `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`. Validasi staging fail-closed: nilai yang hilang menyebabkan startup gagal dengan pesan aman (nama variabel saja).
- **Direkomendasikan produksi**: Supabase Storage (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET_SPK`, `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`) untuk file persisten privat. Foto SPK lewat backend proxy; signed URL hanya fallback foto SPK TTL 60 detik (on-demand, tidak dipersist). Bukti pembayaran tidak memakai signed URL. Upstash (`UPSTASH_REDIS_REST_URL/TOKEN`) untuk rate limit bersama/multi-instance.
- **Khusus platform/container**: `UPLOAD_DIR`, `PAYMENT_UPLOAD_DIR`, `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_SKIP_DOWNLOAD`, `TRUST_PROXY`. Dockerfile sudah menyetel nilai Chromium/upload default.
- **Opsional**: `DB_CONNECTION_LIMIT`, `APP_TIME_ZONE`, `JWT_EXPIRES`, `CORS_ORIGINS`, `RESET_WEBHOOK_TOKEN`, `SUPABASE_DATABASE_URL` (alias `DATABASE_URL` pada mode non-staging).
- **Legacy/compat (opsional)**: `SUPABASE_STORAGE_BUCKET` (jangan pengganti bucket privat baru).
- **Khusus migrasi lokal, jangan di Railway/production runtime**: `SOURCE_DB_*` atau alias `DB_HOST/PORT/NAME/USER/PASSWORD`.

Panduan penting:
- `JWT_SECRET` wajib di production.
- `RESET_WEBHOOK_URL` diperlukan agar reset password produksi dapat dikirim.
- Supabase Storage wajib untuk penyimpanan file persisten di Vercel; di Railway/Docker juga direkomendasikan agar file tidak terikat volume lokal/single replica.
- Untuk staging terisolasi, set `APP_ENV=staging` dan isi semua env staging wajib secara eksplisit; `SUPABASE_DATABASE_URL` tidak akan dipakai sebagai fallback `DATABASE_URL` saat staging.
- Simpan secret hanya di environment platform/server; jangan commit ke Git dan jangan ekspos ke frontend.
- Upstash direkomendasikan untuk serverless/multi-instance.
- `TRUST_PROXY=true` tidak diperbolehkan; gunakan hop count atau IP proxy tepercaya.
- `PORT` disediakan oleh platform deployment; jangan isi `PORT`.

Buat nilai `JWT_SECRET` khusus production, misalnya:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Simpan hasilnya langsung sebagai variable rahasia di Railway. Jika frontend kelak
dipisah ke domain lain, isi `CORS_ORIGINS` dengan origin frontend.

## 3. Migrasi data

Gunakan [panduan Supabase dan Vercel](./VERCEL.md) untuk menjalankan
`npm run migrate:supabase` dari komputer yang dapat mengakses MySQL lama. Target
Supabase harus kosong dan aplikasi lama sebaiknya dihentikan sementara agar data
tidak berubah saat disalin. Simpan backup MySQL sampai jumlah data dan alur
aplikasi berhasil diperiksa.

Database SQLite lama di `data/cucimesin.db` bukan sumber aktif backend dan tidak
termasuk migrasi. File foto SPK di `uploads/` dan bukti pembayaran di
`data/payment-proofs/` juga tidak ikut tersalin oleh migrasi database. Salin
file-file tersebut ke storage persisten jika ingin mempertahankannya. Untuk
Supabase Storage, `npm run migrate:uploads` dapat menyalin file lama (default **dry-run**; tidak mutasi DB, tidak overwrite konflik checksum, **tidak menghapus file sumber otomatis**). Jalankan `--apply` hanya setelah mapping/persetujuan eksplisit, tanpa mengubah path di database.

## 4. Deploy dan verifikasi

Deploy service aplikasi, tunggu status healthy, lalu buka domain yang diberikan.
Verifikasi endpoint `https://<domain>/api`; respons yang diharapkan memuat
`"status":"ok"`. Coba login, pemesanan, upload file, dan pembuatan PDF.

Jangan jalankan `npm run seed` pada production: seed membuat akun demo dengan
kata sandi yang diketahui. Buat atau ganti akun admin production secara aman.
Aktifkan backup berkala di Supabase.

## Pembayaran pelanggan

Pembayaran pelanggan saat ini adalah **transfer bank manual**, bukan pembayaran
kartu/e-wallet otomatis. Setelah SPK pelanggan selesai, pelanggan melihat tagihan
dan rekening tujuan di portal, transfer nominal yang tertera, lalu mengunggah
bukti JPG/PNG/WebP maksimal 5 MB. Admin perlu mengisi rekening pada halaman
**Keuangan → Rekening Pembayaran Online**, kemudian memeriksa bukti di bagian
**Konfirmasi Pembayaran**. Pemasukan dicatat ke arus kas hanya setelah admin
mengonfirmasi bukti. Batas unggah mengikuti konfigurasi aplikasi: 4 MB saat
deploy di Vercel, 5 MB di lingkungan lain. Uji alur ini dengan transaksi uji
sebelum mengumumkan layanan pembayaran.

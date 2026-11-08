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
DATABASE_URL=<Supabase Transaction pooler connection string>
DB_CONNECTION_LIMIT=5
JWT_SECRET=<secret acak yang panjang>
UPLOAD_DIR=/data/uploads
PAYMENT_UPLOAD_DIR=/data/payment-proofs
```

Jangan isi `PORT`; Railway menyediakan port service. Buat nilai `JWT_SECRET`
khusus production, misalnya:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Simpan hasilnya langsung sebagai variable rahasia di Railway. Jika frontend kelak
dipisah ke domain lain, isi `CORS_ORIGINS` dengan origin frontend. Atur
`TRUST_PROXY` hanya sesuai jumlah/lokasi proxy tepercaya; jangan gunakan nilai
`true`.

## 3. Migrasi data

Gunakan [panduan Supabase dan Vercel](./VERCEL.md) untuk menjalankan
`npm run migrate:supabase` dari komputer yang dapat mengakses MySQL lama. Target
Supabase harus kosong dan aplikasi lama sebaiknya dihentikan sementara agar data
tidak berubah saat disalin. Simpan backup MySQL sampai jumlah data dan alur
aplikasi berhasil diperiksa.

Database SQLite lama di `data/cucimesin.db` bukan sumber aktif backend dan tidak
termasuk migrasi. File foto SPK di `uploads/` dan bukti pembayaran di
`data/payment-proofs/` juga tidak ikut tersalin oleh migrasi database. Salin
file-file tersebut ke storage persisten jika ingin mempertahankannya.

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
mengonfirmasi bukti. Uji alur ini dengan transaksi uji sebelum mengumumkan
layanan pembayaran.

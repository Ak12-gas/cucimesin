# Deploy CuciMesin ke Vercel

Konfigurasi Vercel menyajikan halaman dari `public/` dan menjalankan endpoint
Express sebagai Node.js Functions. API tetap memakai MySQL; Vercel tidak
menyediakan database MySQL bawaan untuk aplikasi ini.

## Persiapan

1. Push project ke repository Git dan import repository itu di Vercel.
2. Pilih root project sebagai **Root Directory**. Vercel membaca `vercel.json`
   untuk direktori web, API Functions, aset schema, dan template PDF.
3. Siapkan database MySQL yang dapat diakses dari internet, lalu izinkan koneksi
   dari deployment Vercel sesuai fitur jaringan penyedia database.
4. Tambahkan environment variables berikut di **Project Settings → Environment
   Variables**. Pilih **Preview** untuk deployment Preview dan **Production**
   untuk deployment production. Nilai DB_HOST harus host MySQL yang dapat
   dijangkau dari Vercel, bukan `localhost`, `127.0.0.1`, atau alamat XAMPP lokal.

   ```text
   DB_HOST=<host MySQL>
   DB_PORT=3306
   DB_NAME=<nama database>
   DB_USER=<user database>
   DB_PASSWORD=<password database>
   DB_CONNECTION_LIMIT=5
   JWT_SECRET=<secret acak minimal 32 byte>
   ```

   Buat secret dengan `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
   Jangan mengisi `PORT`; Vercel mengelola port sendiri. `CORS_ORIGINS` tidak
   diperlukan untuk frontend dan API yang sama-sama berada di domain Vercel.
   `UPLOAD_DIR` dan `PAYMENT_UPLOAD_DIR` tidak perlu diisi; function mengarahkan
   keduanya ke direktori sementara yang dapat ditulis.
5. Deploy. Setelah deployment berhasil, buka `https://<domain>/api`; respons
   normal memuat `"status":"ok"`.

## Batasan yang perlu diketahui

- Database wajib sudah dibuat sebelum API pertama dipanggil. API menjalankan
  schema dan migrasi idempoten saat cold start; pastikan user database memiliki
  izin DDL yang diperlukan.
- Berkas unggahan saat ini ditulis ke `/tmp` pada function. Penyimpanan tersebut
  sementara, tidak dibagikan antar-instance, dan dapat hilang kapan saja. Foto
  SPK serta bukti pembayaran **tidak persisten** di deployment ini. Untuk
  penggunaan produksi, pindahkan upload dan pembacaan berkas ke object storage
  persisten sebelum mengaktifkan alur tersebut.
- Fungsi PDF memakai Chromium yang dibundel untuk runtime Vercel. PDF memerlukan
  cold start dan tunduk pada batas durasi Function; `maxDuration` disetel 60
  detik.
- Vercel membatasi payload request dan response Function hingga 4.5 MB. Karena
  batas upload aplikasi 5 MB, unggahan yang mendekati batas tersebut dapat
  ditolak Vercel sebelum mencapai aplikasi.
- Jangan jalankan `npm run seed` pada production: seed membuat akun demo dengan
  kata sandi yang diketahui. Buat akun admin secara aman setelah database siap.

Jika dibutuhkan volume disk persisten atau layanan selalu aktif, gunakan
deployment container di Railway; panduannya ada di [DEPLOYMENT.md](./DEPLOYMENT.md).

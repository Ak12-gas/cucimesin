# Deploy CuciMesin ke Railway

Untuk deployment serverless di Vercel, ikuti [VERCEL.md](./VERCEL.md). Panduan
di bawah ini tetap berlaku untuk deployment container Railway.

Aplikasi ini terdiri dari web statis dan backend Express dalam satu service. Backend
menggunakan MySQL, membuat tabel yang belum ada saat startup, membuat PDF dengan
Chromium, dan menyimpan foto serta bukti pembayaran di disk. Karena itu, deploy
harus menggunakan container dan volume persisten.

## 1. Siapkan project Railway

1. Push project ke repository Git yang private, lalu buat project Railway dari
   repository tersebut. Jangan pernah mengunggah `.env`, `data/`, atau file upload
   ke repository.
2. Tambahkan service **MySQL** ke project yang sama.
3. Hubungkan service aplikasi ke project. Railway akan mendeteksi `Dockerfile` di
   root project.
4. Di pengaturan service aplikasi, tambahkan volume dengan mount path `/data`.
   Aplikasi hanya memakai satu volume untuk `uploads` dan bukti pembayaran.
   Jangan jalankan beberapa replica untuk service ini karena file disimpan di
   volume lokal service.

## 2. Atur environment variables

Tambahkan variabel berikut pada service aplikasi. Ganti `MySQL` dengan nama
service database yang persis jika namanya berbeda:

```text
DB_HOST=${{MySQL.MYSQLHOST}}
DB_PORT=${{MySQL.MYSQLPORT}}
DB_NAME=${{MySQL.MYSQLDATABASE}}
DB_USER=${{MySQL.MYSQLUSER}}
DB_PASSWORD=${{MySQL.MYSQLPASSWORD}}
DB_CONNECTION_LIMIT=10
JWT_SECRET=<secret acak yang panjang>
UPLOAD_DIR=/data/uploads
PAYMENT_UPLOAD_DIR=/data/payment-proofs
RAILWAY_RUN_UID=0
```

Jangan isi `PORT` sendiri; Railway menyediakan port untuk service. Buat nilai
`JWT_SECRET` baru khusus production, misalnya jalankan perintah berikut:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Simpan hasilnya langsung sebagai variable rahasia di Railway.

`RAILWAY_RUN_UID=0` diperlukan agar proses dapat menulis ke volume Railway yang
terpasang pada image dengan user non-root. Jika frontend kelak dipisah ke domain
lain, isi `CORS_ORIGINS` dengan origin frontend tersebut (bisa dipisahkan koma).
Jika web dan API tetap pada domain yang sama, variabel CORS tidak diperlukan.
Atur `TRUST_PROXY` hanya sesuai jumlah/lokasi proxy tepercaya dari penyedia hosting
agar pembatasan percobaan login membaca IP pengunjung dengan benar. Jangan gunakan
nilai `true` untuk mempercayai semua proxy.

## 3. Pindahkan database MySQL lokal

Jika ingin mempertahankan data lokal, export database MySQL `cucimesin` dari
phpMyAdmin/XAMPP sebagai SQL yang berisi struktur dan data, lalu import ke service
MySQL Railway **sebelum deployment pertama aplikasi**. Untuk mengakses database
Railway dari komputer lokal, gunakan koneksi eksternal/TCP proxy Railway sementara
dengan kredensial database; jangan membuka port MySQL secara umum. Setelah import,
nonaktifkan koneksi eksternal tersebut.

Saat aplikasi mulai, `db/database.js` akan memastikan schema aplikasi tersedia dan
menjalankan beberapa migrasi idempoten. File SQLite `data/cucimesin.db` bukan
sumber database yang dipakai backend ini.

Foto SPK yang sudah ada berada di `uploads/`, sedangkan bukti pembayaran berada di
`data/payment-proofs/`. Jika ada file yang ingin dipertahankan, salin juga file-file
tersebut ke subfolder `uploads` dan `payment-proofs` pada volume `/data`. Database
menyimpan nama/path file, jadi file yang tidak ikut dipindahkan tidak dapat
ditampilkan lagi.

## 4. Deploy dan verifikasi

Deploy service aplikasi, tunggu status healthy, lalu buka domain Railway yang
diberikan. Verifikasi endpoint `https://<domain>/api`; respons yang diharapkan
memuat `"status":"ok"`. Coba juga login, pemesanan, upload foto/bukti pembayaran,
dan pembuatan PDF.

Jangan jalankan `npm run seed` pada production: seed tersebut membuat akun demo
dengan kata sandi yang diketahui. Buat/ganti akun admin dan kata sandi production
secara aman setelah database siap. Aktifkan backup berkala untuk MySQL dan volume.

## Pembayaran pelanggan

Pembayaran pelanggan saat ini adalah **transfer bank manual**, bukan pembayaran
kartu/e-wallet otomatis. Setelah SPK pelanggan selesai, pelanggan melihat tagihan
dan rekening tujuan di portal, transfer nominal yang tertera, lalu mengunggah bukti
JPG/PNG/WebP maksimal 5 MB. Admin perlu mengisi rekening pada halaman **Keuangan →
Rekening Pembayaran Online**, kemudian memeriksa bukti di bagian **Konfirmasi
Pembayaran**. Pemasukan dicatat ke arus kas hanya setelah admin mengonfirmasi bukti.
Uji alur ini dengan transaksi uji sebelum mengumumkan layanan pembayaran.

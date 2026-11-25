# Staging Environment Checklist (Non-Secret)

Dokumen ini adalah template prosedur aman untuk menyiapkan environment staging CuciMesin. **Bukan** izin koneksi Supabase/DB/staging, bukan bukti verifikasi, dan **tidak boleh** berisi nilai credential.

## Batasan

- Jangan simpan secret di Git, file tracked, log, screenshot, atau frontend.
- Jangan membaca/menampilkan nilai `.env`, token, JWT, service role key, connection string, atau header Authorization.
- `.env.staging` **tidak** dimuat otomatis oleh kode. Kode hanya memuat `.env` default bila guard dotenv mengizinkan.
- `APP_ENV=staging` melewati pemuatan `.env` dan mengaktifkan validasi staging fail-closed.

## Variabel wajib saat `APP_ENV=staging` (nama saja)

| Variabel | Wajib | Catatan |
|---|---:|---|
| `APP_ENV` | Ya | Harus `staging` (case-insensitive setelah trim). |
| `DATABASE_URL` | Ya | Harus eksplisit. `SUPABASE_DATABASE_URL` **bukan** fallback saat staging. |
| `SUPABASE_URL` | Ya | Project Supabase staging terpisah. |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya | Server-only; jangan ke browser/client/Git/log. |
| `SUPABASE_STORAGE_BUCKET_SPK` | Ya | Bucket privat SPK staging. |
| `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS` | Ya | Bucket privat payment proof staging. |
| `JWT_SECRET` | Ya | Dipakai untuk menandatangani token; staging tidak memakai fallback development. |

## Variabel opsional/sesuai runtime (nama saja)

`NODE_ENV`, `PORT`, `JWT_EXPIRES`, `CORS_ORIGINS`, `TRUST_PROXY`, `DB_CONNECTION_LIMIT`, `APP_TIME_ZONE`, `SUPABASE_STORAGE_BUCKET` (legacy compat), `UPLOAD_DIR`, `PAYMENT_UPLOAD_DIR`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESET_WEBHOOK_URL`, `RESET_WEBHOOK_TOKEN`.

Jangan reuse credential production untuk staging.

## Prosedur aman (lokal/sesi terisolasi)

1. Buka PowerShell **baru** khusus staging. Jangan gunakan sesi production.
2. Set env vars hanya di proses itu. Jangan gunakan `setx` atau User/Machine env permanen. Jangan tulis secret ke file repo.
3. Set nilai staging dari secret manager/input aman; **jangan echo** nilai.

```powershell
# Contoh pola - GANTI placeholder di secret manager/input aman, JANGAN echo nilai.
$env:APP_ENV = "staging"
$env:DATABASE_URL = "<STAGING_DATABASE_URL>"
$env:SUPABASE_URL = "<STAGING_SUPABASE_URL>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<STAGING_SERVICE_ROLE_KEY>"
$env:SUPABASE_STORAGE_BUCKET_SPK = "<STAGING_SPK_BUCKET>"
$env:SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS = "<STAGING_PAYMENT_PROOF_BUCKET>"
$env:JWT_SECRET = "<STAGING_JWT_SECRET>"
```

## Checklist presence-only (tanpa nilai)

```powershell
$required = @(
  'APP_ENV','DATABASE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET_SPK','SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS','JWT_SECRET'
)
foreach ($n in $required) {
  $v = [Environment]::GetEnvironmentVariable($n,'Process')
  "$n=" + ($(if ([string]::IsNullOrEmpty($v)) { 'MISSING' } else { 'PRESENT' }))
}
```

Semua wajib harus `PRESENT` sebelum menjalankan app. Jangan cetak nilai.

## Isolasi & pencegahan salah arah

- Gunakan project Supabase staging terpisah, DB staging terpisah, bucket privat staging terpisah.
- Jangan set `APP_ENV=staging` di production.
- Jangan gunakan `SUPABASE_DATABASE_URL` sebagai fallback staging.
- Jangan reuse credential production.
- Tutup sesi PowerShell staging setelah selesai.
- `.gitignore` sudah mengabaikan `.env`, `.env.*`, `.env*.local`; `.env.example` tetap dapat dilacak.

## Sebelum verifikasi konektivitas

Verifikasi Supabase/DB/staging **belum dilakukan** oleh dokumen ini. Diperlukan persetujuan eksplisit terpisah, target staging terkonfirmasi, dan prosedur read-only/synthetic yang disetujui. Jangan jalankan migrasi/deploy/upload/download/delete tanpa persetujuan.

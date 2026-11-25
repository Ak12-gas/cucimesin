# STORAGE STAGING RUNBOOK — CuciMesin (Tahap 5.8A, Offline Preparation)

**Status dokumen:** Draft persiapan offline. **Bukan izin migrasi, bukan izin akses produksi/staging, bukan bukti verifikasi Supabase.**

**Baseline terverifikasi (lokal, dari laporan tahap sebelumnya):** `npm test` = 119 tests, 119 PASS, 0 FAIL. Storage Service dua bucket private, migration orchestrator, dan migration guard selesai. Belum ada koneksi staging, bucket dibuat, policy dibuat, atau migrasi nyata.

## 1. Tujuan dan Batasan

### Tujuan
- Menyiapkan rencana verifikasi Supabase Storage staging untuk arsitektur dua private bucket.
- Mendefinisikan skenario uji sintetis, checklist prasyarat, kriteria PASS/FAIL, dan prosedur cleanup/rollback yang hanya boleh dijalankan setelah persetujuan terpisah.

### Batasan mutlak (tahap ini)
- Read-only/offline. Tidak ada koneksi Supabase/DB, tidak ada HTTP/DNS/jaringan eksternal, tidak ada migrasi `--apply`, tidak ada upload/download/delete objek Supabase.
- Tidak membuat/mengubah bucket/policy/schema/data. Tidak menghapus/memindahkan/rename file upload sumber. Tidak menyentuh `api-backup/` atau `data/*.db*`.
- Tidak mengubah auth/JWT/pembayaran/ownership/rekening on-demand/endpoint foto SPK/frontend Blob/Storage Service.
- Tidak membaca/mencetak `.env` atau credential. Dokumen ini hanya menyebut **nama** environment variable.

## 2. Arsitektur Dua Private Bucket (Fakta Kode Terverifikasi)

Sumber: `services/storage.js`, `routes/spk.js`, `routes/pembayaran.js`, `services/pdfservice.js`, `middleware/upload.js`.

| Asset type | Bucket default | Env override bucket | Canonical prefix | Public URL | Signed URL |
|---|---|---|---|---:|---|
| `spk_photo` | `cucimesin-spk` | `SUPABASE_STORAGE_BUCKET_SPK` | `spk/` | Tidak | Ya, hanya `spk_photo`, TTL tepat **60 detik**, dibuat on-demand, tidak disimpan DB/browser |
| `payment_proof` | `cucimesin-payment-proofs` | `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS` | `payment-proofs/` | Tidak | Tidak (ditolak oleh Storage Service) |

Fakta tambahan:
- `services/storage.js` memisahkan bucket berdasarkan `assetType` eksplisit; bucket tidak diterima dari input user.
- `LEGACY_COMPAT_BUCKETS` berisi `cucimesin` (`SUPABASE_STORAGE_BUCKET` default legacy) untuk kompatibilitas terbatas; inferensi compat hanya untuk prefix canonical aman.
- Remote Supabase dianggap terkonfigurasi jika `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` ada. Pada runtime Vercel tanpa remote, operasi private asset ditolak `STORAGE_UNAVAILABLE`/503 (tidak menulis ke `/tmp` sebagai permanen). Local fallback hanya non-Vercel saat remote tidak dikonfigurasi.
- Error storage disanitasi (redaksi bearer/JWT/service_role/secret/path internal). Signed URL tidak boleh dicatat di log biasa.

## 3. Kontrak Canonical Path (Fakta Kode Terverifikasi)

Sumber: `db/migrate-uploads-to-storage.js`, `services/storage.js`, `routes/spk.js`, `routes/pembayaran.js`.

- **SPK photo:** `spk/{spkId}/{filename}`. Route upload SPK menyimpan canonical `spk/{spkId}/{timestamp-random}{ext}`.
- **Payment proof:** `payment-proofs/{spkId}/{filename}`. Route upload pembayaran menyimpan canonical `payment-proofs/{spkId}/{timestamp-random}{ext}`.
- Migration guard (5.7.1): `spkId` wajib valid; filename wajib valid; tanpa traversal/segmen kosong/encoded traversal/format tidak sesuai; assetType eksplisit; tidak menebak spkId. File non-canonical tanpa explicit mapping = `REJECTED_AMBIGUOUS` (tidak PLANNED, tidak upload). Duplicate target objectPath = `CONFLICT` (no overwrite, no upload). Checksum identik bukan bukti SPK sama.

## 4. Environment Variable yang Diperlukan (Nama Saja)

> Hanya nama variabel. **Jangan** mencatat/membaca/menampilkan nilai.

| Nama | Wajib/Direkomendasikan/Opsional (berdasarkan kode/dokumen) | Tujuan |
|---|---|---|
| `APP_ENV` | **Wajib untuk staging terisolasi** (`staging`, case-insensitive setelah trim) | Mengaktifkan guard dotenv dan validasi staging fail-closed. |
| `DATABASE_URL` | **Wajib** | Koneksi DB staging. Saat `APP_ENV=staging`, **harus eksplisit** dan tidak boleh digantikan oleh `SUPABASE_DATABASE_URL`. |
| `SUPABASE_DATABASE_URL` | Opsional mode non-staging; **bukan fallback staging** | Alias fallback `DATABASE_URL` hanya untuk mode non-staging. |
| `SUPABASE_URL` | **Wajib saat staging** | URL project Supabase untuk Storage REST. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Wajib saat staging** (server-only) | Akses server-side; **tidak boleh** ke browser/client/log/Git/frontend. |
| `SUPABASE_STORAGE_BUCKET_SPK` | **Wajib eksplisit saat staging** | Bucket SPK privat staging. |
| `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS` | **Wajib eksplisit saat staging** | Bucket payment proof privat staging. |
| `SUPABASE_STORAGE_BUCKET` | Legacy/compat (opsional) | Bucket legacy compat; jangan dipakai sebagai pengganti bucket privat baru. |
| `UPLOAD_DIR` | Opsional/legacy fallback | Root upload lokal; Vercel meremap ke `/tmp` hanya untuk fallback lokal, bukan storage permanen privat. |
| `PAYMENT_UPLOAD_DIR` | Opsional/legacy fallback | Root bukti bayar lokal legacy. |
| `VERCEL` | Platform-provided | Mempengaruhi perilaku runtime safety (tolak local permanent fallback untuk private asset). |

**Belum diverifikasi:** nilai aktual, keberadaan, atau kecocokan env di staging/produksi. Verifikasi hanya boleh dilakukan setelah persetujuan eksplisit, tanpa menampilkan nilai.

**Catatan konsistensi (diperbarui):** `.env.example`, `AGENTS.md`, `VERCEL.md`, dan `DEPLOYMENT.md` sudah mencantumkan `SUPABASE_STORAGE_BUCKET_SPK` dan `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`; `SUPABASE_STORAGE_BUCKET` ditandai sebagai legacy/compat opsional. Staging tetap harus memastikan nama env/bucket benar, bucket privat, dan tidak tertukar.

## 5. Checklist Persiapan Staging (Belum Diverifikasi)

Sebelum Tahap 5.8B (jika disetujui), semua item berikut harus dikonfirmasi oleh pemilik lingkungan:

- [ ] Project Supabase **staging terpisah** dari produksi dipilih/tersedia.
- [ ] Bucket `cucimesin-spk` ada di staging.
- [ ] Bucket `cucimesin-payment-proofs` ada di staging.
- [ ] Kedua bucket **private** (tidak public).
- [ ] Tidak ada public URL/object public access untuk kedua bucket.
- [ ] Service role key hanya di server environment staging; tidak di browser, tidak di repo, tidak di log.
- [ ] Policy/access backend mengikuti least privilege; bucket tidak tertukar.
- [ ] Signed URL hanya untuk `spk_photo`, TTL tepat 60 detik; `payment_proof` tidak punya signed URL.
- [ ] CORS/origin staging dikonfigurasi sesuai kebutuhan; tidak membuka akses publik ke objek privat.
- [ ] Backup/rollback plan staging disiapkan; scope cleanup hanya objek sintetis.
- [ ] Persetujuan eksplisit pengguna diperoleh sebelum koneksi jaringan/staging apa pun.

## 6. Test Plan Berurutan (Untuk Eksekusi Setelah Persetujuan Terpisah)

> **Tidak dijalankan sekarang.** Semua ID/file di bawah adalah **sintetis**.

### Data sintetis yang diizinkan (konsep)
- `spkId`: `STAGING-SPK-0001`
- Foto: `spk/STAGING-SPK-0001/synthetic-photo.png` (buffer PNG sintetis kecil)
- Bukti: `payment-proofs/STAGING-SPK-0001/synthetic-proof.png` (buffer PNG/PDF sintetis kecil)
- Jangan tulis ke `uploads/`/`data/`. Jangan pakai data pelanggan nyata. Cleanup objek sintetis hanya setelah persetujuan terpisah.

| No | Skenario | Tujuan | Prasyarat | Tindakan (setelah persetujuan) | Hasil diharapkan | Bukti verifikasi | PASS/FAIL | Cleanup (persetujuan terpisah) |
|---:|---|---|---|---|---|---|---|---|
| 1 | Konfigurasi env (nama saja) | Pastikan env remote lengkap | Checklist 5 disetujui | Periksa keberadaan `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; catat bucket env opsional | Remote terkonfigurasi; nilai tidak ditampilkan | Log audit internal tanpa nilai | PASS jika variabel ada dan tidak terekspos | N/A |
| 2 | Dua bucket terpisah | Cegah bucket mixing | Skenario 1 PASS | Upload sintetis `spk_photo` dan `payment_proof` via backend/service terkontrol | Objek masuk bucket sesuai assetType | Metadata object path+bucket dari API respons terkontrol | PASS jika terpisah benar | Hapus objek sintetis |
| 3 | Bucket private | Cegah public access | Skenario 2 PASS | Coba akses object path tanpa auth backend/Supabase anon; verifikasi tidak public | Akses publik ditolak | HTTP status/response aman | PASS jika tidak bisa diakses publik | N/A |
| 4 | Upload foto SPK sintetis | Validasi upload canonical | Skenario 1-3 | Upload `spk_photo` ke `spk/STAGING-SPK-0001/synthetic-photo.png` | ObjectPath canonical tersimpan; content-type benar | Respons upload + metadata | PASS jika canonical dan private | Hapus objek sintetis |
| 5 | Download foto SPK via backend authz | Proteksi data | Skenario 4 | GET endpoint foto SPK dengan user berhak | 200, bytes benar, header `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Pragma: no-cache` | Respons header/body hash | PASS jika authz+header benar | N/A |
| 6 | Akses foto tanpa auth | AuthN | Endpoint aktif | GET endpoint foto SPK tanpa token | 401/403 sesuai kontrak | Status code | PASS jika ditolak | N/A |
| 7 | Akses foto user tidak berhak | AuthZ/ownership | User tidak berhak | GET endpoint foto SPK dengan token tidak berhak | 403/404 sesuai kontrak, tidak bocor data | Status code/body aman | PASS jika ditolak | N/A |
| 8 | Signed URL foto SPK | Fallback terkontrol | Skenario 4 | Request `?delivery=signed` atau `/url` | JSON `{url, expiresInSeconds:60, delivery:"signed"}`; URL tidak disimpan/log; TTL 60 | Respons JSON; cek tidak ada persistensi | PASS jika TTL=60 dan tidak dipersist | URL kedaluwarsa alami; hapus objek setelah uji |
| 9 | Signed URL payment_proof ditolak | Cegah eksposur bukti | Skenario 1 | Coba create signed URL untuk `payment_proof` | Ditolak oleh Storage Service | Error terstruktur aman | PASS jika ditolak | N/A |
| 10 | Upload/download bukti bayar berotorisasi | Proteksi bukti | Skenario 1-3 | Upload bukti sintetis; GET `/api/pembayaran/:id/bukti` sebagai owner/admin | 200, bytes benar, headers private/no-store/nosniff | Respons header/body hash | PASS jika hanya berotorisasi | Hapus objek sintetis |
| 11 | Akses publik bukti/foto ditolak | No public path | Skenario 2 | Coba `/uploads/spk/...`, `/uploads/payment-proofs/...` | 404 (guard) / tidak 200 | Status code | PASS jika tidak publik | N/A |
| 12 | Header verifikasi | Hardening | Skenario 5,10 | Inspeksi response headers | `nosniff`, `private, no-store`, `Pragma: no-cache` | Header capture | PASS jika lengkap | N/A |
| 13 | Ukuran/SHA-256 | Integritas | Skenario 4/10 | Bandingkan hash sumber sintetis dan bytes download | Ukuran+SHA-256 sama | Hash report | PASS jika identik | N/A |
| 14 | Objek tidak ditemukan | Error handling aman | Skenario 1 | Request objectPath sintetis yang tidak ada | 404 aman, tidak bocor secret/path internal | Status/body | PASS jika 404 aman | N/A |
| 15 | Storage error/sanitasi | No leak | Skenario 1 | Simulasikan error remote terkontrol di staging test env | 502/503 aman; tidak ada service_role/JWT/token | Response/log review | PASS jika tersanitasi | N/A |
| 16 | Pemisahan bucket/cross-asset | Cegah akses silang | Skenario 2 | Coba resolve/download `payment_proof` pakai path/bucket `spk_photo` dan sebaliknya | Ditolak/404 aman | Status/body | PASS jika tidak bisa silang | N/A |
| 17 | Tidak ada persistensi sensitif | Data hygiene | Skenario 5,8,10 | Periksa DB/log/browser storage untuk URL privat/credential | Tidak ada signed URL/token/credential tersimpan | Audit query/log/review UI | PASS jika bersih | N/A |

## 7. Checklist Supabase Staging

| Item | Wajib | Status | Catatan |
|---|---:|---|---|
| Project staging terpisah dari produksi | Ya | Belum diverifikasi | Jangan gunakan produksi. |
| Bucket `cucimesin-spk` private | Ya | Belum diverifikasi | Nama harus sesuai default/kode. |
| Bucket `cucimesin-payment-proofs` private | Ya | Belum diverifikasi | Nama harus sesuai default/kode. |
| Service role hanya server-side | Ya | Belum diverifikasi | Jangan tampilkan nilai. |
| Browser tidak menerima service role | Ya | Belum diverifikasi | Hanya JWT app user. |
| Policy least privilege | Ya | Belum diverifikasi | Backend-mediated access. |
| Bucket config tidak tertukar | Ya | Belum diverifikasi | Periksa env mapping. |
| Tidak ada public URL | Ya | Belum diverifikasi | Private bucket. |
| Signed URL foto SPK saja, 60s | Ya | Belum diverifikasi | Payment proof ditolak. |
| Tidak ada credential di source control | Ya | Belum diverifikasi | Audit repo/config terpisah. |

## 8. Kriteria PASS/FAIL

**PASS staging preparation/execution (kelak):**
- Semua skenario wajib PASS dengan bukti.
- Tidak ada akses publik ke objek privat.
- Tidak ada credential/URL privat tersimpan di DB/log/browser.
- Upload/download/verify SHA-256 cocok untuk objek sintetis.
- Bucket terpisah dan tidak ada cross-asset access.
- Cleanup objek sintetis selesai setelah persetujuan.

**FAIL / STOP:**
- Ada akses publik, signed URL bocor, bucket salah, cross-asset access, credential exposure, header keamanan hilang, atau verifikasi hash gagal.
- Setiap FAIL menghentikan tahap eksekusi staging sampai RCA dan persetujuan perbaikan.

## 9. Prosedur Cleanup Objek Sintetis (Memerlukan Persetujuan Terpisah)

- Hanya objek dengan prefix/ID sintetis yang telah disepakati (contoh `STAGING-SPK-0001`) yang boleh dibersihkan.
- Cleanup tidak boleh menyentuh file sumber lokal `uploads/`/`data/` pelanggan/legacy.
- Hapus objek sintetis di bucket staging melalui prosedur terkontrol yang disetujui; catat objectPath, waktu, operator, dan hasil. Jangan hapus bucket/policy produksi.
- Jika cleanup gagal, jangan retry liar; laporkan error tersanitasi.

## 10. Rollback dan Penanganan Kegagalan

- **Rollback eksekusi staging:** hentikan pengujian, cabut akses staging sementara jika ada indikasi kebocoran, hapus hanya objek sintetis yang disetujui, dan laporkan RCA.
- **Rollback kode:** tidak ada perubahan kode produksi di Tahap 5.8A. Jika tahap eksekusi mendatang memerlukan perubahan kode, harus lewat PR/patch terpisah dan persetujuan.
- **Kegagalan konfigurasi:** jangan fallback ke bucket publik; jangan pakai produksi; perbaiki staging config secara terpisah.
- **Kegagalan integritas (hash/size mismatch):** tandai FAIL, jangan lanjut migrasi, jangan hapus sumber.

## 11. Risiko dan Hal yang Belum Diverifikasi

- **Belum diverifikasi:** keberadaan/konfigurasi Supabase staging, bucket private, policy, env values, konektivitas, perilaku nyata Supabase SDK/network.
- **Legacy file (audit 5.7):** 15 PNG di root `uploads/` masih `REJECTED_AMBIGUOUS`; `data/payment-proofs/` tidak ditemukan. **Jangan** membuat mapping fiktif untuk file nyata. Mapping memerlukan sumber kebenaran sah dan review terpisah; jangan masukkan file legacy ke staging plan sebagai siap migrasi.
- **Inventaris lokal tidak lengkap untuk bukti bayar:** tidak ada direktori `data/payment-proofs/` lokal saat audit.
- **Dokumentasi env sudah diselaraskan** untuk mencantumkan `SUPABASE_STORAGE_BUCKET_SPK` dan `SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS`; pastikan environment staging nyata mengisi nama env tersebut secara eksplisit (tanpa nilai di repo/log).

## 12. Pernyataan Batas

Dokumen ini adalah **rencana persiapan offline**. Dokumen ini **bukan** persetujuan migrasi, bukan persetujuan akses staging/produksi, bukan bukti bahwa bucket/policy/credential Supabase sudah benar, dan bukan izin menjalankan `--apply`. Tahap 5.8B (verifikasi staging) hanya boleh dimulai setelah persetujuan eksplisit pengguna.
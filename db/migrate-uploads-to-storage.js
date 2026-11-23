'use strict';

// Menyalin file upload lama dari disk ke Supabase Storage.
// Default hanya mencetak rencana; gunakan --apply untuk benar-benar mengunggah.
// Objek path sengaja sama dengan penafsiran runtime:
//   - foto SPK: <relative path di UPLOAD_DIR>  (DB menyimpan /uploads/<path>)
//   - bukti bayar: payment-proofs/<nama file>  (DB menyimpan nama file polos)
// Sehingga tidak perlu mengubah baris database.

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const storage = require('../services/storage');

const apply = process.argv.includes('--apply');

async function collectFiles(root, objectPrefix = '') {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // lewati .gitkeep dan marker serupa
    const absolute = path.join(root, entry.name);
    const objectPath = `${objectPrefix}${entry.name}`.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute, `${objectPath}/`));
    } else if (entry.isFile()) {
      files.push({ absolute, objectPath });
    }
  }
  return files;
}

async function main() {
  // Dry-run sengaja tidak memerlukan kredensial agar rencana bisa diperiksa
  // tanpa menyentuh Supabase. Kredensial hanya diperlukan saat --apply.
  if (apply && !storage.isRemoteConfigured()) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi untuk --apply.');
  }

  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  const proofDir = path.resolve(
    process.env.PAYMENT_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'payment-proofs')
  );

  const [photos, proofs] = await Promise.all([
    collectFiles(uploadDir),
    collectFiles(proofDir, 'payment-proofs/')
  ]);

  const byObjectPath = new Map();
  for (const file of [...photos, ...proofs]) byObjectPath.set(file.objectPath, file);
  const files = [...byObjectPath.values()].sort((a, b) => a.objectPath.localeCompare(b.objectPath));

  if (!files.length) {
    console.log('Tidak ada file lama yang ditemukan.');
    return;
  }

  console.log(`${apply ? 'Mengunggah' : 'Rencana upload'}: ${files.length} file`);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    try {
      if (!apply) {
        console.log(`  [dry-run] ${file.absolute} -> ${file.objectPath}`);
        continue;
      }
      const bytes = await fs.readFile(file.absolute);
      await storage.upload(file.objectPath, bytes, storage.contentTypeForPath(file.objectPath));
      uploaded += 1;
      console.log(`  [ok] ${file.objectPath}`);
    } catch (error) {
      if (error.status === 409) {
        skipped += 1;
        console.log(`  [ada] ${file.objectPath}`);
      } else {
        failed += 1;
        console.error(`  [gagal] ${file.objectPath}: ${error.message}`);
      }
    }
  }

  console.log(`Selesai: ${uploaded} diunggah, ${skipped} sudah ada, ${failed} gagal.`);
  if (failed) process.exitCode = 1;
  if (!apply) console.log('Jalankan dengan --apply setelah memeriksa rencana di atas.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Dipakai hanya untuk legacy/local fallback. File baru masuk memory lalu
// disimpan lewat services/storage.js (Supabase Storage atau disk lokal).
const dir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
fs.mkdirSync(dir, { recursive: true });

const allowedExts = ['.jpeg', '.jpg', '.png', '.webp'];
const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

function imageBytes(input) {
  if (Buffer.isBuffer(input)) return input.subarray(0, 12);
  const fd = fs.openSync(input, 'r');
  try {
    const bytes = Buffer.alloc(12);
    fs.readSync(fd, bytes, 0, 12, 0);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function hasValidImageSignature(input, mimeType) {
  const bytes = imageBytes(input);
  const isJpeg = mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return isJpeg || isPng || isWebp;
}

function isAllowedImage(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return allowedExts.includes(ext) && allowedMimeTypes.includes(file.mimetype);
}

// Vercel membatasi body request 4,5 MB, lebih kecil dari batas aplikasi 5 MB.
// Turunkan batas saat berjalan di Vercel agar error terjadi di aplikasi dengan
// respons JSON, bukan ditolak platform sebelum route sempat dijalankan.
const MAX_UPLOAD_BYTES = process.env.VERCEL ? 4 * 1024 * 1024 : 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (isAllowedImage(file)) return cb(null, true);
    const error = new Error('Upload gagal: Format file atau MIME type tidak didukung atau berbahaya');
    error.code = 'INVALID_FILE_TYPE';
    return cb(error, false);
  }
});

module.exports = upload;
module.exports.hasValidImageSignature = hasValidImageSignature;
module.exports.isAllowedImage = isAllowedImage;
module.exports.uploadDir = dir;
module.exports.maxUploadBytes = MAX_UPLOAD_BYTES;

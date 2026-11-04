const multer = require('multer');
const path = require('path');
const fs = require('fs');

const dir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
// Pastikan folder ini memiliki izin ketat (misal: chmod 755 di Ubuntu) 
// agar file di dalamnya tidak bisa dieksekusi.
fs.mkdirSync(dir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

// Perbaikan: Gunakan array untuk pencocokan pasti, bukan Regex parsial
const allowedExts = ['.jpeg', '.jpg', '.png', '.webp'];
const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

function hasValidImageSignature(filePath, mimeType) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bytes = Buffer.alloc(12);
    fs.readSync(fd, bytes, 0, 12, 0);
    const isJpeg = mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isWebp = mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    return isJpeg || isPng || isWebp;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Batas 5MB
  fileFilter: (req, file, cb) => {
    // 1. Cek ekstensi file secara presisi
    const ext = path.extname(file.originalname).toLowerCase();
    const isExtValid = allowedExts.includes(ext);
    
    // 2. Cek MIME type sebenarnya dari header file HTTP
    const isMimeValid = allowedMimeTypes.includes(file.mimetype);

    if (isExtValid && isMimeValid) {
      cb(null, true);
    } else {
      const error = new Error('Upload gagal: Format file atau MIME type tidak didukung atau berbahaya');
      error.code = 'INVALID_FILE_TYPE';
      cb(error, false);
    }
  }
});

module.exports.hasValidImageSignature = hasValidImageSignature;
module.exports.uploadDir = dir;
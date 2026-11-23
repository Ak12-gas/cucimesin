const test = require('node:test');
const assert = require('node:assert/strict');

const uploadPath = require.resolve('../middleware/upload');
delete require.cache[uploadPath];
process.env.VERCEL = '1';
const uploadModule = require('../middleware/upload');

test('batas upload di Vercel lebih kecil dari batas body platform', () => {
  assert.equal(uploadModule.maxUploadBytes, 4 * 1024 * 1024);
  assert.ok(uploadModule.maxUploadBytes < 4.5 * 1024 * 1024);
});

test('validasi tipe file tetap tersedia', () => {
  assert.equal(typeof uploadModule.isAllowedImage, 'function');
  assert.equal(
    uploadModule.isAllowedImage({ originalname: 'bukti.png', mimetype: 'image/png' }),
    true
  );
  assert.equal(
    uploadModule.isAllowedImage({ originalname: 'bukti.exe', mimetype: 'image/png' }),
    false
  );
});

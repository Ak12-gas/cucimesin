const test = require('node:test');
const assert = require('node:assert/strict');

const originalEnv = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
  UPLOAD_DIR: process.env.UPLOAD_DIR
};

const storagePath = require.resolve('../services/storage');
delete require.cache[storagePath];
const storage = require('../services/storage');

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('path /uploads lama diterjemahkan ke object path Storage', () => {
  assert.equal(storage.toObjectPath('/uploads/2026/11/foto.png'), '2026/11/foto.png');
  assert.equal(storage.toObjectPath('///uploads/foto.jpg'), 'foto.jpg');
  assert.equal(storage.toObjectPath('foto-webp.webp'), 'foto-webp.webp');
});

test('URL publik Supabase dikonversi kembali ke object path', () => {
  process.env.SUPABASE_URL = 'https://contoh.supabase.co/';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  process.env.SUPABASE_STORAGE_BUCKET = 'cucimesin';

  const url = storage.publicUrl('2026/11/foto.png');
  assert.equal(
    url,
    'https://contoh.supabase.co/storage/v1/object/public/cucimesin/2026/11/foto.png'
  );
  assert.equal(storage.toObjectPath(url), '2026/11/foto.png');
  assert.equal(storage.toObjectPath('https://domain-lain.example/foto.png'), null);
});

test('tanpa konfigurasi remote, public URL tetap relatif', () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(storage.isRemoteConfigured(), false);
  assert.equal(storage.publicUrl('bukti.png'), '/uploads/bukti.png');
});

test('content type mengikuti ekstensi, mengabaikan query string', () => {
  assert.equal(storage.contentTypeForPath('foto.PNG?token=abc'), 'image/png');
  assert.equal(storage.contentTypeForPath('foto.jpeg'), 'image/jpeg');
  assert.equal(storage.contentTypeForPath('foto.webp'), 'image/webp');
  assert.equal(storage.contentTypeForPath('dokumen.pdf'), 'application/octet-stream');
});

test('path kosong tidak menghasilkan object path', () => {
  assert.equal(storage.toObjectPath(''), null);
  assert.equal(storage.toObjectPath(null), null);
});

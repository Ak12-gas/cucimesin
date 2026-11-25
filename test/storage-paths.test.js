const test = require('node:test');
const assert = require('node:assert/strict');

const STORAGE_MODULE = require.resolve('../services/storage');
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'UPLOAD_DIR'];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function loadStorage(env = {}) {
  delete require.cache[STORAGE_MODULE];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return require('../services/storage');
}

function assertRejectsOrInvalid(fn, message) {
  return assert.rejects(fn, (err) => {
    assert.ok(err, message || 'harus menolak');
    return true;
  });
}

test('storage path contract: canonical dan legacy (Tahap 4.5)', async (t) => {
  const envSnap = snapshotEnv();
  t.after(() => { restoreEnv(envSnap); delete require.cache[STORAGE_MODULE]; });

  await t.test('accepts canonical spk path for spk_photo', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const resolved = storage.toObjectPath('spk_photo', 'spk/123/foto-1.jpg');
    assert.ok(resolved);
    assert.equal(resolved.assetType, 'spk_photo');
    assert.equal(resolved.bucket, 'cucimesin-spk');
    assert.equal(resolved.objectPath, 'spk/123/foto-1.jpg');
    assert.equal(resolved.canonical, true);
  });

  await t.test('accepts canonical payment proof path for payment_proof', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const resolved = storage.toObjectPath('payment_proof', 'payment-proofs/123/bukti-1.png');
    assert.ok(resolved);
    assert.equal(resolved.assetType, 'payment_proof');
    assert.equal(resolved.bucket, 'cucimesin-payment-proofs');
    assert.equal(resolved.objectPath, 'payment-proofs/123/bukti-1.png');
    assert.equal(resolved.canonical, true);
  });

  await t.test('compat mode normalizes /uploads, uploads, and ///uploads paths', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    for (const value of ['/uploads/2026/11/foto.png', 'uploads/2026/11/foto.png', '///uploads/foto.jpg']) {
      const resolved = storage.toObjectPath('spk_photo', value, { mode: 'compat' });
      assert.ok(resolved, `harus menerima ${value}`);
      assert.equal(resolved.assetType, 'spk_photo');
      assert.equal(resolved.bucket, 'cucimesin-spk');
      assert.ok(!resolved.objectPath.startsWith('/'));
      assert.ok(resolved.objectPath.endsWith(pathBasename(value)));
    }
  });

  await t.test('compat mode maps bare filename only for payment_proof', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const proof = storage.toObjectPath('payment_proof', 'bukti-123.png', { mode: 'compat' });
    assert.ok(proof);
    assert.equal(proof.assetType, 'payment_proof');
    assert.equal(proof.bucket, 'cucimesin-payment-proofs');
    // Bare filename adalah legacy compat; diterima hanya untuk payment_proof dan dipetakan ke prefix payment-proofs/.
    // canonical bisa false karena butuh konteks spk_id untuk bentuk target payment-proofs/{spk_id}/{filename}.
    assert.match(proof.objectPath, /^payment-proofs\/.*bukti-123\.png$/);
    assert.equal(proof.canonical, false);

    const spk = storage.toObjectPath('spk_photo', 'foto-123.png', { mode: 'compat' });
    assert.equal(isRejected(spk), true, 'bare filename tidak boleh diterima untuk spk_photo');
  });

  await t.test('compat mode accepts legacy Supabase public URL from old cucimesin bucket when verifiable', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const value = 'https://project.supabase.co/storage/v1/object/public/cucimesin/payment-proofs/old-bukti.png';
    const resolved = storage.toObjectPath('payment_proof', value, { mode: 'compat' });
    assert.ok(resolved);
    assert.equal(resolved.assetType, 'payment_proof');
    assert.equal(resolved.bucket, 'cucimesin-payment-proofs');
    assert.equal(resolved.objectPath, 'payment-proofs/old-bukti.png');
  });

  await t.test('rejects unknown Supabase bucket, external URL, malformed path, and empty value', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const bad = [
      ['spk_photo', 'https://project.supabase.co/storage/v1/object/public/unknown-bucket/spk/1/a.jpg'],
      ['spk_photo', 'https://evil.example.com/spk/1/a.jpg'],
      ['spk_photo', 'spk/1/../evil.jpg'],
      ['spk_photo', 'spk/1/%2E%2E/evil.jpg'],
      ['spk_photo', ''],
      ['spk_photo', null],
      ['payment_proof', 'javascript:alert(1)'],
    ];
    for (const [assetType, value] of bad) {
      const resolved = storage.toObjectPath(assetType, value, { mode: 'compat' });
      assert.equal(isRejected(resolved), true, `harus menolak ${assetType}:${String(value)}`);
    }
  });

  await t.test('does not guess assetType when path is ambiguous', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const ambiguous = '2026/11/foto.png'; // bisa spk legacy, tapi tanpa assetType tidak boleh ditebak
    await assertRejectsOrInvalid(async () => storage.toObjectPath(undefined, ambiguous, { mode: 'compat' }));
    await assertRejectsOrInvalid(async () => storage.toObjectPath('', ambiguous, { mode: 'compat' }));
  });

  await t.test('rejects signed URL/tokenized URL as canonical DB value', async () => {
    const storage = await loadStorage({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const signed = 'https://project.supabase.co/storage/v1/object/sign/cucimesin-spk/spk/1/a.jpg?token=secret';
    let threw = null;
    try {
      storage.toObjectPath('spk_photo', signed, { mode: 'strict' });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'signed URL tidak boleh diterima sebagai canonical DB path');
    assert.match(String(threw.code || ''), /INVALID_OBJECT_PATH|INVALID_PATH/i);
  });
});

function pathBasename(p) {
  return String(p).split('/').filter(Boolean).pop();
}

function isRejected(resolved) {
  if (resolved === null || resolved === undefined) return true;
  if (resolved === false) return true;
  if (typeof resolved === 'object' && resolved.valid === false) return true;
  if (typeof resolved === 'object' && resolved.objectPath === null) return true;
  return false;
}

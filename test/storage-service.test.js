const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STORAGE_MODULE = require.resolve('../services/storage');

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'UPLOAD_DIR',
  'PAYMENT_UPLOAD_DIR',
  'VERCEL'
];

function snapshotEnv() {
  const snap = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap) {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

async function loadStorage(env = {}) {
  delete require.cache[STORAGE_MODULE];
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return require('../services/storage');
}

function assertStructuredError(err, expected) {
  assert.ok(err && typeof err === 'object', 'error harus berupa object');
  if (expected.code) assert.equal(err.code, expected.code, `code harus ${expected.code}`);
  if (expected.status) assert.equal(err.status, expected.status, `status harus ${expected.status}`);
  if (expected.assetType !== undefined) assert.equal(err.assetType, expected.assetType, 'assetType harus sesuai');
  const msg = String(err.message || '').toLowerCase();
  for (const secret of ['service_role', 'supabase_service_role_key', 'eyj', 'bearer ']) {
    assert.ok(!msg.includes(secret), `error message tidak boleh membocorkan ${secret}`);
  }
}

test('storage service: mapping bucket dan contract dasar', async (t) => {
  const envSnap = snapshotEnv();
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    restoreEnv(envSnap);
    delete require.cache[STORAGE_MODULE];
  });

  await t.test('maps spk_photo and payment_proof to correct private buckets', async () => {
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    assert.equal(typeof storage.getBucketForAssetType, 'function', 'getBucketForAssetType harus ada');
    assert.equal(storage.getBucketForAssetType('spk_photo'), 'cucimesin-spk');
    assert.equal(storage.getBucketForAssetType('payment_proof'), 'cucimesin-payment-proofs');
  });

  await t.test('rejects unknown asset type for upload/download/remove/createSignedUrl', async () => {
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const badType = 'invoice_photo';
    const calls = [
      () => storage.upload(badType, 'spk/1/a.jpg', Buffer.from('x'), 'image/jpeg'),
      () => storage.download(badType, 'spk/1/a.jpg'),
      () => storage.remove(badType, 'spk/1/a.jpg'),
      () => storage.createSignedUrl(badType, 'spk/1/a.jpg', 60),
    ];
    for (const call of calls) {
      await assert.rejects(call, (err) => {
        assertStructuredError(err, { code: 'INVALID_ASSET_TYPE' });
        return true;
      });
    }
  });

  await t.test('upload stores object in mapped bucket and returns canonical metadata, not public URL', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
    };
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const result = await storage.upload('spk_photo', 'spk/12/photo.jpg', Buffer.from('img'), 'image/jpeg');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/storage/v1/object/cucimesin-spk/spk/12/photo.jpg'));
    assert.ok(!calls[0].url.includes('/object/public/'));
    assert.equal(result.assetType, 'spk_photo');
    assert.equal(result.bucket, 'cucimesin-spk');
    assert.equal(result.objectPath, 'spk/12/photo.jpg');
    assert.ok(!('publicUrl' in result), 'result tidak boleh mengandung publicUrl');
    assert.ok(!('signedUrl' in result), 'result tidak boleh mengandung signedUrl');
    assert.ok(!('url' in result), 'result tidak boleh mengandung url publik');
  });

  await t.test('download reads from mapped bucket and rejects cross-bucket/public URL object path', async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const result = await storage.download('payment_proof', 'payment-proofs/7/bukti.png');
    assert.ok(calls[0].includes('/storage/v1/object/cucimesin-payment-proofs/payment-proofs/7/bukti.png'));
    assert.ok(!calls[0].includes('/object/public/'));
    assert.ok(Buffer.isBuffer(result.bytes) || result instanceof Buffer || ArrayBuffer.isView(result.bytes));
    assert.equal(result.assetType, 'payment_proof');
    assert.equal(result.bucket, 'cucimesin-payment-proofs');

    await assert.rejects(
      () => storage.download('spk_photo', 'https://project.supabase.co/storage/v1/object/public/cucimesin-payment-proofs/payment-proofs/7/bukti.png'),
      (err) => {
        assertStructuredError(err, { assetType: 'spk_photo' });
        return true;
      }
    );
  });

  await t.test('remove deletes only from mapped bucket and is explicit on not-found', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    };
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const result = await storage.remove('spk_photo', 'spk/1/old.jpg');
    assert.equal(calls[0].method, 'DELETE');
    assert.ok(calls[0].url.includes('/storage/v1/object/cucimesin-spk/spk/1/old.jpg'));
    assert.equal(result.assetType, 'spk_photo');
    assert.equal(result.bucket, 'cucimesin-spk');
    assert.equal(result.removed, false);
  });

  await t.test('rejects path traversal, backslash, encoded traversal, and empty segments', async () => {
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const badPaths = [
      'spk/1/../secret.jpg',
      'spk/1/%2e%2e/secret.jpg',
      'spk\\1\\secret.jpg',
      'spk//1/secret.jpg',
      '/spk/1/secret.jpg',
      '',
      '   '
    ];
    for (const objectPath of badPaths) {
      await assert.rejects(
        () => storage.upload('spk_photo', objectPath, Buffer.from('x'), 'image/jpeg'),
        (err) => {
          assertStructuredError(err, {});
          assert.match(String(err.code || ''), /INVALID_OBJECT_PATH|INVALID_PATH|INVALID_ASSET_TYPE/i);
          return true;
        }
      );
    }
  });

  await t.test('rejects unverified external URLs and unknown bucket URLs', async () => {
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    const badValues = [
      'https://evil.example.com/spk/1/a.jpg',
      'https://project.supabase.co/storage/v1/object/public/unknown-bucket/spk/1/a.jpg',
      'http://169.254.169.254/latest/meta-data',
    ];
    for (const value of badValues) {
      await assert.rejects(
        () => storage.download('spk_photo', value),
        (err) => {
          assertStructuredError(err, {});
          return true;
        }
      );
    }
  });

  await t.test('createSignedUrl allows only spk_photo with exact 60s TTL', async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ signedURL: '/object/sign/cucimesin-spk/spk/1/a.jpg?token=abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });

    await assert.rejects(
      () => storage.createSignedUrl('payment_proof', 'payment-proofs/1/a.jpg', 60),
      (err) => {
        assertStructuredError(err, { code: 'UNSUPPORTED_ASSET_TYPE' });
        return true;
      }
    );

    for (const ttl of [59, 61, 600, 0, -1]) {
      await assert.rejects(
        () => storage.createSignedUrl('spk_photo', 'spk/1/a.jpg', ttl),
        (err) => {
          assertStructuredError(err, {});
          return true;
        }
      );
    }

    const result = await storage.createSignedUrl('spk_photo', 'spk/1/a.jpg', 60);
    assert.equal(result.assetType, 'spk_photo');
    assert.equal(result.bucket, 'cucimesin-spk');
    assert.equal(result.expiresInSeconds, 60);
    assert.ok(result.url, 'signed URL harus dikembalikan');
    assert.ok(!String(result.url).includes('service-role-test'));
    // pastikan request sign mengarah ke bucket SPK
    assert.ok(calls.some((c) => c.url.includes('/storage/v1/object/sign/cucimesin-spk/spk/1/a.jpg')));
  });

  await t.test('storage unavailable returns safe structured error without leaking internals', async () => {
    global.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:54321 service-role-test'); };
    const storage = await loadStorage({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    await assert.rejects(
      () => storage.download('spk_photo', 'spk/1/a.jpg'),
      (err) => {
        assertStructuredError(err, {});
        assert.equal(err.status, 503);
        assert.match(String(err.code || ''), /STORAGE_UNAVAILABLE|UNAVAILABLE/i);
        assert.ok(!String(err.message).includes('service-role-test'));
        return true;
      }
    );
  });
});

test('storage service: local fallback aman dan tidak memakai /tmp sebagai permanen', async (t) => {
  const envSnap = snapshotEnv();
  t.after(() => {
    restoreEnv(envSnap);
    delete require.cache[STORAGE_MODULE];
  });

  await t.test('local fallback only allowed when remote not configured and not on Vercel', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-storage-'));
    t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    const storage = await loadStorage({ UPLOAD_DIR: dir });
    assert.equal(typeof storage.upload, 'function');
    // kontrak baru: saat remote tidak tersedia di lingkungan non-vercel, implementasi boleh local fallback
    // namun harus tetap mengembalikan metadata canonical (bukan public URL) dan assetType/bucket.
    const result = await storage.upload('spk_photo', 'spk/1/local.jpg', Buffer.from('abc'), 'image/jpeg');
    assert.equal(result.assetType, 'spk_photo');
    assert.equal(result.bucket, 'cucimesin-spk');
    assert.equal(result.objectPath, 'spk/1/local.jpg');
    assert.ok(!('publicUrl' in result));
  });
});

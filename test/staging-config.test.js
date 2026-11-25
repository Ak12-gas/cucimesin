'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const DUMMY = {
  DATABASE_URL: 'postgresql://dummy-user:dummy-pass@db.example.invalid:5432/dummy_db',
  SUPABASE_DATABASE_URL: 'postgresql://dummy-user:dummy-pass@fallback.example.invalid:5432/fallback_db',
  SUPABASE_URL: 'https://dummy-project.example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-key',
  SUPABASE_STORAGE_BUCKET_SPK: 'dummy-spk-bucket',
  SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS: 'dummy-payment-bucket',
  JWT_SECRET: 'dummy-jwt-secret-value'
};

const REQUIRED = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET_SPK',
  'SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS',
  'JWT_SECRET'
];

function runNode(script, env = {}) {
  const childEnv = { ...process.env };
  for (const k of [...REQUIRED, 'SUPABASE_DATABASE_URL', 'APP_ENV']) delete childEnv[k];
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 15000
  });
}

function assertNoSensitiveLeak(res) {
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  for (const val of Object.values(DUMMY)) {
    assert.equal(out.includes(val), false, 'dummy sensitive value must not leak');
  }
  assert.equal(/Bearer\s+/i.test(out), false, 'Bearer token must not leak');
  assert.equal(/postgresql:\/\//i.test(out), false, 'connection string must not leak');
}

function stagingEnv(overrides = {}) {
  return {
    APP_ENV: 'staging',
    ...DUMMY,
    ...overrides
  };
}

test('staging config validation', async (t) => {
  await t.test('APP_ENV=staging with all required vars passes', async () => {
    const script = "const {validateStagingConfig}=require('./utils/staging-config'); const r=validateStagingConfig(process.env); console.log(JSON.stringify(r));";
    const res = runNode(script, stagingEnv());
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout.trim());
    assert.deepEqual(payload, { ok: true, staging: true, missing: [] });
    assertNoSensitiveLeak(res);
  });

  await t.test('DATABASE_URL empty but SUPABASE_DATABASE_URL set fails and names DATABASE_URL', async () => {
    const script = "try{require('./utils/staging-config').validateStagingConfig(process.env); console.log('ok')}catch(e){console.log(JSON.stringify({msg:e.message,missing:e.missing||null,code:e.code||null}))}";
    const res = runNode(script, stagingEnv({ DATABASE_URL: '', SUPABASE_DATABASE_URL: DUMMY.SUPABASE_DATABASE_URL }));
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout.trim());
    assert.equal(payload.code, 'STAGING_CONFIG_INVALID');
    assert.deepEqual(payload.missing, ['DATABASE_URL']);
    assert.match(payload.msg, /DATABASE_URL/);
    assert.doesNotMatch(payload.msg, /SUPABASE_DATABASE_URL/);
    assertNoSensitiveLeak(res);
  });

  await t.test('DATABASE_URL and SUPABASE_DATABASE_URL both empty fails', async () => {
    const script = "try{require('./utils/staging-config').validateStagingConfig(process.env)}catch(e){console.log(JSON.stringify(e.missing))}";
    const res = runNode(script, stagingEnv({ DATABASE_URL: '', SUPABASE_DATABASE_URL: '' }));
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const missing = JSON.parse(res.stdout.trim());
    assert.ok(missing.includes('DATABASE_URL'));
  });

  for (const name of REQUIRED) {
    await t.test(`missing ${name} fails naming only that required var`, async () => {
      const env = stagingEnv();
      delete env[name];
      const script = "try{require('./utils/staging-config').validateStagingConfig(process.env)}catch(e){console.log(JSON.stringify({missing:e.missing,msg:e.message}))}";
      const res = runNode(script, env);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.deepEqual(payload.missing, [name]);
      assert.match(payload.msg, new RegExp(name));
      assertNoSensitiveLeak(res);
    });
  }

  for (const name of REQUIRED.filter((name) => name !== 'DATABASE_URL')) {
    await t.test(`${name} empty/whitespace fails`, async () => {
      const script = "try{require('./utils/staging-config').validateStagingConfig(process.env)}catch(e){console.log(JSON.stringify(e.missing))}";
      const res = runNode(script, stagingEnv({ [name]: '   ' }));
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const missing = JSON.parse(res.stdout.trim());
      assert.deepEqual(missing, [name]);
      assertNoSensitiveLeak(res);
    });
  }

  for (const appEnv of ['development', 'test', 'production', '']) {
    await t.test(`APP_ENV=${appEnv || '<empty>'} does not activate staging validation`, async () => {
      const env = { APP_ENV: appEnv }; // missing required staging vars should not matter
      const script = "const r=require('./utils/staging-config').validateStagingConfig(process.env); console.log(JSON.stringify(r));";
      const res = runNode(script, env);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.ok, true);
      assert.equal(payload.staging, false);
    });
  }

  await t.test('APP_ENV with case/whitespace is recognized as staging', async () => {
    const script = "try{require('./utils/staging-config').validateStagingConfig(process.env)}catch(e){console.log(JSON.stringify(e.missing))}";
    const res = runNode(script, { ...stagingEnv(), APP_ENV: '  StAgInG  ', DATABASE_URL: '' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const missing = JSON.parse(res.stdout.trim());
    assert.ok(missing.includes('DATABASE_URL'));
  });

  await t.test('error does not contain dummy secret/url/connection string/Bearer', async () => {
    const script = "try{require('./utils/staging-config').validateStagingConfig(process.env)}catch(e){console.log(e.message)}";
    const res = runNode(script, stagingEnv({ SUPABASE_SERVICE_ROLE_KEY: '' }));
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /SUPABASE_SERVICE_ROLE_KEY/);
    assertNoSensitiveLeak(res);
  });

  await t.test('validation is idempotent/safe to call repeatedly', async () => {
    const script = "const {validateStagingConfig}=require('./utils/staging-config'); for(let i=0;i<5;i++) validateStagingConfig(process.env); console.log('ok');";
    const res = runNode(script, stagingEnv());
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'ok');
  });
});

test('db/database staging DATABASE_URL selection', async (t) => {
  await t.test('staging uses DATABASE_URL only', async () => {
    const script = "const db=require('./db/database'); try{db.connect()}catch(e){console.log(e.message)}";
    const res = runNode(script, {
      APP_ENV: 'staging',
      DATABASE_URL: DUMMY.DATABASE_URL,
      SUPABASE_DATABASE_URL: DUMMY.SUPABASE_DATABASE_URL
    });
    // It may fail later connecting, but should not fail with staging missing DATABASE_URL message.
    const out = `${res.stdout}\n${res.stderr}`;
    assert.doesNotMatch(out, /DATABASE_URL wajib diatur saat APP_ENV=staging/);
    assertNoSensitiveLeak(res);
  });

  await t.test('staging does not fallback to SUPABASE_DATABASE_URL', async () => {
    const script = "const db=require('./db/database'); try{db.connect(); console.log('unexpected')}catch(e){console.log(e.message)}";
    const res = runNode(script, {
      APP_ENV: 'staging',
      DATABASE_URL: '',
      SUPABASE_DATABASE_URL: DUMMY.SUPABASE_DATABASE_URL
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /DATABASE_URL wajib diatur saat APP_ENV=staging/);
    assertNoSensitiveLeak(res);
  });

  await t.test('non-staging keeps existing DATABASE_URL || SUPABASE_DATABASE_URL fallback', async () => {
    const script = "const db=require('./db/database'); try{db.connect()}catch(e){console.log(e.message)}";
    const res = runNode(script, {
      APP_ENV: 'development',
      DATABASE_URL: '',
      SUPABASE_DATABASE_URL: DUMMY.SUPABASE_DATABASE_URL
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.doesNotMatch(out, /DATABASE_URL belum diatur/);
    assert.doesNotMatch(out, /DATABASE_URL wajib diatur saat APP_ENV=staging/);
    assertNoSensitiveLeak(res);
  });

  await t.test('non-staging still errors when both DB URLs missing', async () => {
    const script = "const db=require('./db/database'); try{db.connect()}catch(e){console.log(e.message)}";
    const res = runNode(script, {
      APP_ENV: 'development',
      DATABASE_URL: '',
      SUPABASE_DATABASE_URL: ''
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /DATABASE_URL belum diatur/);
    assertNoSensitiveLeak(res);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-env-iso-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function runNode(script, { cwd = REPO_ROOT, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  // Remove inherited flags that would interfere with specific cases unless explicitly set.
  for (const k of ['APP_ENV', 'SKIP_DOTENV', 'DOTENV_TEST_SENTINEL', 'DOTENV_DUMMY_SECRET']) {
    if (!(k in env)) delete childEnv[k];
  }
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    timeout: 15000
  });
  return res;
}

function assertNoSecretLeak(res, secret) {
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  assert.equal(out.includes(secret), false, 'dummy secret must not appear in stdout/stderr');
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*=/.test(out), false, 'env assignment/value must not be printed');
}

async function writeDummyEnv(dir) {
  const secret = 'dummy-secret-value-DO-NOT-PRINT';
  await fs.writeFile(path.join(dir, '.env'), 'DOTENV_TEST_SENTINEL=from_dotenv\nDOTENV_DUMMY_SECRET=' + secret + '\n', 'utf8');
  return secret;
}

test('env isolation: dotenv loading guard', async (t) => {
  await t.test('APP_ENV=staging does not load .env', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); const r=loadEnvIfAllowed(); console.log(JSON.stringify({skipped:r.skipped, sentinel:process.env.DOTENV_TEST_SENTINEL||null}));";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT, APP_ENV: 'staging' } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.skipped, true);
      assert.equal(payload.sentinel, null);
      assertNoSecretLeak(res, secret);
    });
  });

  await t.test('SKIP_DOTENV=1 does not load .env', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); const r=loadEnvIfAllowed(); console.log(JSON.stringify({skipped:r.skipped, sentinel:process.env.DOTENV_TEST_SENTINEL||null}));";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT, SKIP_DOTENV: '1' } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.skipped, true);
      assert.equal(payload.sentinel, null);
      assertNoSecretLeak(res, secret);
    });
  });

  await t.test('SKIP_DOTENV=true (case-insensitive) does not load .env', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); const r=loadEnvIfAllowed(); console.log(JSON.stringify({skipped:r.skipped, sentinel:process.env.DOTENV_TEST_SENTINEL||null}));";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT, SKIP_DOTENV: 'TrUe' } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.skipped, true);
      assert.equal(payload.sentinel, null);
      assertNoSecretLeak(res, secret);
    });
  });

  await t.test('APP_ENV other than staging keeps default dotenv loading', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); const r=loadEnvIfAllowed(); console.log(JSON.stringify({skipped:r.skipped, sentinel:process.env.DOTENV_TEST_SENTINEL||null}));";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT, APP_ENV: 'development' } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.skipped, false);
      assert.equal(payload.sentinel, 'from_dotenv');
      assertNoSecretLeak(res, secret);
    });
  });

  await t.test('process.env variables are not overridden by dotenv', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); const r=loadEnvIfAllowed(); console.log(JSON.stringify({skipped:r.skipped, sentinel:process.env.DOTENV_TEST_SENTINEL||null}));";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT, APP_ENV: 'development', DOTENV_TEST_SENTINEL: 'from_process' } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout.trim());
      assert.equal(payload.skipped, false);
      assert.equal(payload.sentinel, 'from_process');
      assertNoSecretLeak(res, secret);
    });
  });

  await t.test('no dummy secret leaked when dotenv loads', async () => {
    await withTempDir(async (dir) => {
      const secret = await writeDummyEnv(dir);
      const script = "const {loadEnvIfAllowed}=require(process.env.REPO_ROOT+'/utils/env.js'); loadEnvIfAllowed(); console.log('ok');";
      const res = runNode(script, { cwd: dir, env: { REPO_ROOT } });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(res.stdout.trim(), 'ok');
      assertNoSecretLeak(res, secret);
    });
  });
});

'use strict';

const REQUIRED_STAGING_VARS = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET_SPK',
  'SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS',
  'JWT_SECRET'
];

function isStagingEnv(env = process.env) {
  return String(env.APP_ENV == null ? '' : env.APP_ENV).trim().toLowerCase() === 'staging';
}

function hasValue(env, name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim().length > 0 : value != null && String(value).trim().length > 0;
}

function getMissingStagingVars(env = process.env) {
  if (!isStagingEnv(env)) return [];
  return REQUIRED_STAGING_VARS.filter((name) => !hasValue(env, name));
}

function validateStagingConfig(env = process.env) {
  if (!isStagingEnv(env)) {
    return { ok: true, staging: false, missing: [] };
  }
  const missing = getMissingStagingVars(env);
  if (missing.length > 0) {
    const err = new Error(`Konfigurasi staging tidak lengkap: ${missing.join(', ')}`);
    err.code = 'STAGING_CONFIG_INVALID';
    err.missing = [...missing];
    throw err;
  }
  return { ok: true, staging: true, missing: [] };
}

module.exports = {
  REQUIRED_STAGING_VARS,
  isStagingEnv,
  getMissingStagingVars,
  validateStagingConfig
};

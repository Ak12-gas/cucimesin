'use strict';

const dotenv = require('dotenv');

function isTruthyFlag(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === '1' || v === 'true';
}

function shouldLoadDotenv(env = process.env) {
  const appEnv = String(env.APP_ENV == null ? '' : env.APP_ENV).trim().toLowerCase();
  if (appEnv === 'staging') return false;
  if (isTruthyFlag(env.SKIP_DOTENV)) return false;
  return true;
}

function loadEnvIfAllowed(options = {}) {
  const env = options.env || process.env;
  if (!shouldLoadDotenv(env)) {
    return { loaded: false, skipped: true };
  }
  const result = dotenv.config(options.dotenvOptions);
  return { loaded: true, skipped: false, result };
}

module.exports = {
  shouldLoadDotenv,
  loadEnvIfAllowed
};

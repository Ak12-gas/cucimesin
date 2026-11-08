const path = require('path');

function writableUploadDir(configuredPath, fallbackPath) {
  if (configuredPath && configuredPath.startsWith('/tmp/')) return configuredPath;
  const relativePath = configuredPath ? configuredPath.replace(/^[\\/]+/, '') : fallbackPath;
  return path.join('/tmp', 'cucimesin', relativePath);
}

process.env.UPLOAD_DIR = writableUploadDir(process.env.UPLOAD_DIR, 'uploads');
process.env.PAYMENT_UPLOAD_DIR = writableUploadDir(process.env.PAYMENT_UPLOAD_DIR, 'payment-proofs');

const db = require('./db/database');

let initializationPromise;
let app;

async function handler(req, res) {
  if (!initializationPromise) {
    initializationPromise = db.initialize().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  try {
    await initializationPromise;
    if (!app) app = require('./server').createApp();
  } catch (error) {
    console.error('[STARTUP ERROR]', error);
    return res.status(503).json({ error: 'API belum siap. Periksa konfigurasi database dan environment.' });
  }

  return app(req, res);
}

module.exports = handler;

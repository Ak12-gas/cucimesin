require('./utils/env').loadEnvIfAllowed();
const { validateStagingConfig } = require('./utils/staging-config');
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const path = require('path');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const trustedProxy = process.env.TRUST_PROXY?.trim();
  if (trustedProxy && trustedProxy.toLowerCase() !== 'false') {
    if (trustedProxy.toLowerCase() === 'true') {
      throw new Error('TRUST_PROXY must specify a hop count or trusted proxy address; "true" is unsafe');
    }
    const hopCount = Number(trustedProxy);
    app.set('trust proxy', Number.isInteger(hopCount) && hopCount >= 0 ? hopCount : trustedProxy);
  }
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);

  app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    credentials: false
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  const { uploadDir } = require('./middleware/upload');
  const denyPrivateUploadPath = (req, res, next) => {
    const raw = `${req.baseUrl || ''}${req.path || ''}`;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch (_e) { return res.status(400).json({ error: 'Bad request' }); }
    const normalized = decoded.replace(/\\/g, '/').toLowerCase();
    if (/\/(spk|payment-proofs)(\/|$)/i.test(normalized)) {
      return res.status(404).json({ error: 'Not found' });
    }
    return next();
  };
  app.use('/uploads', denyPrivateUploadPath);
  app.use('/uploads', express.static(uploadDir, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
  }));
  if (process.env.VERCEL) {
    app.use('/api/uploads', denyPrivateUploadPath);
    app.use('/api/uploads', express.static(uploadDir, {
      dotfiles: 'deny',
      index: false,
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
    }));
  }
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api', (req, res) => res.json({ name: 'CuciMesin API', version: '1.0.0', status: 'ok' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await require('./db/database').get('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'error', db: 'down' });
    }
  });

  app.use('/api/auth',       require('./routes/auth'));
  app.use('/api/dashboard',  require('./routes/dashboard'));
  app.use('/api/spk',        require('./routes/spk'));
  app.use('/api/pelanggan',  require('./routes/pelanggan'));
  app.use('/api/pembayaran', require('./routes/pembayaran'));
  app.use('/api/teknisi',    require('./routes/teknisi'));
  app.use('/api/keuangan',   require('./routes/keuangan'));
  app.use('/api/laporan',    require('./routes/laporan'));
  app.use('/api/pengaturan', require('./routes/pengaturan'));
  app.use('/api/booking',    require('./routes/booking'));
  app.use('/api/layanan',    require('./routes/layanan'));
  app.use('/api/mitra',      require('./routes/mitra'));

  app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack || err.message);
    if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: 'File upload tidak valid atau terlalu besar' });
    }
    if (['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ENOTFOUND', 'ETIMEDOUT', '08000', '08003', '08006', '57P03'].includes(err.code)) {
      return res.status(503).json({ error: 'Database tidak tersedia. Periksa DATABASE_URL dan koneksi Supabase.' });
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    const safeMessage = status >= 500
      ? 'Server error'
      : (err.expose === true && typeof err.message === 'string' && err.message ? err.message : 'Bad request');
    res.status(status).json({ error: safeMessage });
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const start = async () => {
    validateStagingConfig();
    const db = require('./db/database');
    await db.initialize();
    const app = createApp();
    const server = await new Promise((resolve, reject) => {
      const instance = app.listen(PORT, () => resolve(instance));
      instance.once('error', reject);
    });
    console.log(`CuciMesin backend berjalan di http://localhost:${PORT}`);
    console.log(`API base: http://localhost:${PORT}/api`);
    const { closeBrowser } = require('./services/pdfservice');
    const shutdown = async () => { await closeBrowser(); server.close(async () => { await db.close(); process.exit(0); }); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  };
  start().catch((error) => { console.error('[STARTUP ERROR]', error); process.exit(1); });
}

module.exports = { createApp };
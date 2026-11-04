const attempts = new Map();

// Cleanup expired entries every 5 minutes to prevent memory leak
const CLEANUP_INTERVAL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.startedAt >= entry.windowMs) {
      attempts.delete(key);
    }
  }
}, CLEANUP_INTERVAL).unref();

function rateLimit({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const current = attempts.get(key);

    if (!current || now - current.startedAt >= windowMs) {
      attempts.set(key, { startedAt: now, count: 1, windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.ceil((windowMs - (now - current.startedAt)) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    }

    return next();
  };
}

module.exports = rateLimit;

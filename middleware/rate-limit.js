'use strict';

// Ip klien: percaya X-Forwarded-For hanya di Vercel atau ketika TRUST_PROXY
// sudah diatur di server.js. Jika tidak, semua request bisa terlihat dari IP
// proxy yang sama dan bersama-sama kena 429.
function clientKey(req) {
  if (process.env.VERCEL && req.headers && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function createMemoryStore() {
  const attempts = new Map();
  return {
    async increment(key, windowSeconds) {
      const now = Date.now();
      const entry = attempts.get(key);
      if (!entry || now - entry.startedAt >= windowSeconds * 1000) {
        attempts.set(key, { startedAt: now, count: 1 });
        return { count: 1, retryAfter: windowSeconds };
      }
      entry.count += 1;
      return {
        count: entry.count,
        retryAfter: Math.max(1, Math.ceil(windowSeconds - (now - entry.startedAt) / 1000))
      };
    }
  };
}

function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

const UPSTASH_INCREMENT_SCRIPT = "local c=redis.call('INCR',KEYS[1]) if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return c";

function createUpstashStore(config, fetchImpl = fetch) {
  const url = config.url.replace(/\/$/, '');
  return {
    async increment(key, windowSeconds) {
      const response = await fetchImpl(`${url}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([['EVAL', UPSTASH_INCREMENT_SCRIPT, 1, key, windowSeconds]])
      });
      if (!response.ok) throw new Error(`Upstash rate limit gagal: ${response.status}`);
      const result = await response.json();
      const count = Number(result && result[0] && result[0].result);
      if (!Number.isFinite(count)) throw new Error('Upstash rate limit mengembalikan count tidak valid');
      return { count, retryAfter: windowSeconds };
    }
  };
}

let sharedStore;
let fallbackStore;
let warningShown = false;

function resolveStore(explicitStore) {
  if (explicitStore) return explicitStore;

  const config = upstashConfig();
  if (config) {
    if (!sharedStore) sharedStore = createUpstashStore(config);
    return sharedStore;
  }

  if (!fallbackStore) {
    fallbackStore = createMemoryStore();
    if (process.env.NODE_ENV === 'production' && !warningShown) {
      console.warn('[rate-limit] UPSTASH_REDIS_REST_* belum diatur; memakai memory store per proses.');
      warningShown = true;
    }
  }
  return fallbackStore;
}

function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, store } = {}) {
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  return async (req, res, next) => {
    const key = `ratelimit:${req.baseUrl || ''}${req.path || ''}:${clientKey(req)}`;

    let result;
    try {
      result = await resolveStore(store).increment(key, windowSeconds);
    } catch (error) {
      if (store) throw error;
      console.error('[rate-limit] shared store gagal, jatuh ke memory:', error.message);
      if (!fallbackStore) fallbackStore = createMemoryStore();
      result = await fallbackStore.increment(`${key}:fallback`, windowSeconds);
    }

    if (result.count > max) {
      res.setHeader('Retry-After', String(result.retryAfter || windowSeconds));
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    }
    return next();
  };
}

module.exports = rateLimit;
module.exports.rateLimit = rateLimit;
module.exports.clientKey = clientKey;
module.exports.createMemoryStore = createMemoryStore;
module.exports.createUpstashStore = createUpstashStore;

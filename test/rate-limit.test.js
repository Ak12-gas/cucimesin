const test = require('node:test');
const assert = require('node:assert/strict');
const rateLimit = require('../middleware/rate-limit');

function fakeRes() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function fakeReq(ip = '10.0.0.1', headers = {}) {
  return { ip, path: '/login', baseUrl: '/api/auth', headers, socket: { remoteAddress: ip } };
}

test('clientKey mengambil X-Forwarded-For pertama di Vercel', () => {
  const previous = process.env.VERCEL;
  try {
    process.env.VERCEL = '1';
    assert.equal(
      rateLimit.clientKey(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })),
      '1.2.3.4'
    );
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test('clientKey memakai req.ip dan membuang prefix ::ffff:', () => {
  const previous = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.equal(rateLimit.clientKey(fakeReq('::ffff:10.0.0.1')), '10.0.0.1');
  } finally {
    if (previous !== undefined) process.env.VERCEL = previous;
  }
});

test('rate limit memakai store yang disuntikkan dan mengembalikan 429 setelah max', async () => {
  const calls = [];
  const store = {
    async increment(key, windowSeconds) {
      calls.push({ key, windowSeconds });
      return { count: calls.length, retryAfter: 900 };
    }
  };
  const middleware = rateLimit({ max: 2, windowMs: 900000, store });

  const first = fakeRes();
  await middleware(fakeReq(), first, () => {});
  assert.equal(first.statusCode, null);

  const second = fakeRes();
  await middleware(fakeReq(), second, () => {});
  assert.equal(second.statusCode, null);

  const third = fakeRes();
  await middleware(fakeReq(), third, () => {});
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers['Retry-After'], '900');

  assert.equal(calls.length, 3);
  assert.match(calls[0].key, /ratelimit:\/api\/auth\/login:10\.0\.0\.1/);
});

test('memory store mengembalikan hitungan inkremental', async () => {
  const store = rateLimit.createMemoryStore();
  assert.deepEqual(await store.increment('k', 60), { count: 1, retryAfter: 60 });
  assert.equal((await store.increment('k', 60)).count, 2);
});

test('Upstash store hanya menetapkan TTL saat counter dibuat', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: true, json: async () => [{ result: 1 }] };
  };
  const store = rateLimit.createUpstashStore(
    { url: 'https://upstash.test/', token: 'test-token' },
    fetchImpl
  );

  await store.increment('ratelimit:login:1.2.3.4', 900);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://upstash.test/pipeline');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].body.length, 1);
  const [command, script, numKeys, keyArg, windowArg] = calls[0].body[0];
  assert.equal(command, 'EVAL');
  assert.match(script, /redis\.call\('INCR',KEYS\[1\]\)/);
  assert.match(script, /c==1.*redis\.call\('EXPIRE',KEYS\[1\],ARGV\[1\]\)/);
  assert.equal(numKeys, 1);
  assert.equal(keyArg, 'ratelimit:login:1.2.3.4');
  assert.equal(windowArg, 900);
});

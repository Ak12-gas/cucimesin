'use strict';

const fs = require('fs/promises');
const path = require('path');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

const ASSET_TYPES = {
  spk_photo: {
    assetType: 'spk_photo',
    bucketEnv: 'SUPABASE_STORAGE_BUCKET_SPK',
    defaultBucket: 'cucimesin-spk',
    canonicalPrefix: 'spk/',
    signedUrlAllowed: true,
  },
  payment_proof: {
    assetType: 'payment_proof',
    bucketEnv: 'SUPABASE_STORAGE_BUCKET_PAYMENT_PROOFS',
    defaultBucket: 'cucimesin-payment-proofs',
    canonicalPrefix: 'payment-proofs/',
    signedUrlAllowed: false,
  }
};

const LEGACY_COMPAT_BUCKETS = new Set(['cucimesin']);

class StorageError extends Error {
  constructor({ code, message, statusCode = 500, operation, assetType, cause }) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.statusCode = statusCode;
    this.status = statusCode;
    this.operation = operation;
    this.assetType = assetType;
    if (cause && process.env.NODE_ENV !== 'production') {
      this.causeMessage = sanitizeMessage(cause.message || String(cause));
    }
  }
}

function sanitizeMessage(message) {
  return String(message || '')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/service_role/gi, '[REDACTED_KEY]');
}

function makeError(code, message, statusCode, { operation, assetType, cause } = {}) {
  return new StorageError({
    code,
    message,
    statusCode,
    operation,
    assetType,
    cause: cause ? { message: sanitizeMessage(cause.message || String(cause)) } : undefined,
  });
}

function settings() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    legacyBucket: process.env.SUPABASE_STORAGE_BUCKET || 'cucimesin'
  };
}

function isRemoteConfigured() {
  const { url, key } = settings();
  return Boolean(url && key);
}

function isVercelRuntime() {
  return Boolean(process.env.VERCEL);
}

function getBucketForAssetType(assetType) {
  const cfg = ASSET_TYPES[assetType];
  if (!cfg) {
    throw makeError('INVALID_ASSET_TYPE', 'Asset type tidak didukung', 400, { operation: 'getBucketForAssetType', assetType });
  }
  return process.env[cfg.bucketEnv] || cfg.defaultBucket;
}

function getAssetConfig(assetType, operation) {
  const cfg = ASSET_TYPES[assetType];
  if (!cfg) {
    throw makeError('INVALID_ASSET_TYPE', 'Asset type tidak didukung', 400, { operation, assetType });
  }
  return cfg;
}

function normalizeObjectPath(objectPath) {
  return String(objectPath).replace(/\\/g, '/').replace(/^\/+/, '');
}

function hasTraversalOrInvalidSegments(objectPath) {
  const raw = String(objectPath);
  if (!raw || !raw.trim()) return true;
  if (raw.includes('\\')) return true;
  if (/^[A-Za-z]:\//.test(raw)) return true;
  if (raw.startsWith('/')) return true;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return true; }
  decoded = decoded.replace(/\\/g, '/');
  if (decoded.includes('\0')) return true;
  if (decoded.startsWith('/') || /^[A-Za-z]:\//.test(decoded)) return true;
  const segments = normalizeObjectPath(decoded).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return true;
  return false;
}

function validateCanonicalObjectPath(assetType, objectPath, operation) {
  getAssetConfig(assetType, operation);
  if (typeof objectPath !== 'string' || !objectPath.trim()) {
    throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
  }
  if (hasTraversalOrInvalidSegments(objectPath)) {
    throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
  }
  const normalized = normalizeObjectPath(objectPath);
  const segments = normalized.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) {
    throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
  }
  // Prevent protocol-like or URL paths
  if (/^https?:/i.test(normalized) || normalized.includes('://')) {
    throw makeError('INVALID_OBJECT_PATH', 'Object path tidak boleh berupa URL', 400, { operation, assetType });
  }
  return normalized;
}

function encodeObjectPath(objectPath) {
  return normalizeObjectPath(objectPath).split('/').map(encodeURIComponent).join('/');
}

function contentTypeForPath(objectPath) {
  const ext = path.extname(String(objectPath).split('?')[0]).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function parseSupabaseObjectUrl(raw, operation, assetType) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const { url: supabaseUrl } = settings();
  if (supabaseUrl) {
    const expectedOrigin = new URL(supabaseUrl).origin;
    if (url.origin !== expectedOrigin) return { kind: 'external' };
  }
  const publicMatch = url.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (publicMatch) {
    return { kind: 'public', bucket: decodeURIComponent(publicMatch[1]), objectPath: decodeURIComponent(publicMatch[2]) };
  }
  const signMatch = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (signMatch) {
    return { kind: 'signed', bucket: decodeURIComponent(signMatch[1]), objectPath: decodeURIComponent(signMatch[2]) };
  }
  return { kind: 'other-supabase' };
}

function isCanonicalForAsset(assetType, objectPath) {
  const cfg = getAssetConfig(assetType, 'validate');
  return normalizeObjectPath(objectPath).startsWith(cfg.canonicalPrefix);
}

function toObjectPath(assetType, storedValue, options = {}) {
  const operation = 'toObjectPath';
  // Compat old signature: toObjectPath(value)
  if (arguments.length === 1) {
    const value = assetType;
    return legacyToObjectPathString(value);
  }
  // Compat old signature where first arg is not known asset type but looks like path/value and second omitted
  if (!ASSET_TYPES[assetType] && typeof assetType === 'string' && (storedValue === undefined || typeof storedValue === 'object')) {
    // ambiguous: cannot guess assetType
    throw makeError('INVALID_ASSET_TYPE', 'Asset type wajib dan tidak boleh ditebak', 400, { operation, assetType });
  }

  const cfg = getAssetConfig(assetType, operation);
  const mode = options.mode === 'compat' ? 'compat' : (options.mode === 'strict' ? 'strict' : 'compat');
  const raw = storedValue;

  if (raw === null || raw === undefined) {
    if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
    return null;
  }

  // Reject signed/tokenized URLs as canonical DB value
  if (/^https?:\/\//i.test(raw)) {
    const parsed = parseSupabaseObjectUrl(raw, operation, assetType);
    if (!parsed || parsed.kind === 'external' || parsed.kind === 'other-supabase') {
      if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'URL object path tidak diizinkan', 400, { operation, assetType });
      return null;
    }
    if (parsed.kind === 'signed') {
      throw makeError('INVALID_OBJECT_PATH', 'Signed URL tidak boleh disimpan sebagai path canonical', 400, { operation, assetType });
    }
    if (parsed.kind === 'public') {
      const allowedBuckets = new Set([getBucketForAssetType(assetType), ...LEGACY_COMPAT_BUCKETS]);
      if (!allowedBuckets.has(parsed.bucket)) {
        if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Bucket object path tidak dikenal', 400, { operation, assetType });
        return null;
      }
      const obj = normalizeObjectPath(parsed.objectPath);
      if (hasTraversalOrInvalidSegments(obj)) {
        if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
        return null;
      }
      const canonical = isCanonicalForAsset(assetType, obj);
      if (!canonical && mode === 'strict') {
        throw makeError('INVALID_OBJECT_PATH', 'Object path bukan canonical untuk asset type ini', 400, { operation, assetType });
      }
      return { assetType, bucket: getBucketForAssetType(assetType), objectPath: obj, canonical };
    }
  }

  // Non-URL path
  let candidate = String(raw).trim();
  if (candidate.includes('://') || /^[a-z]+:/i.test(candidate)) {
    // e.g. javascript:, data:, etc.
    if (/^https?:/i.test(candidate)) {
      // handled above
    } else {
      if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
      return null;
    }
  }

  candidate = candidate.replace(/\\/g, '/');
  candidate = candidate.replace(/^\/+/, '/');
  // normalize /uploads legacy forms: /uploads/, uploads/, ///uploads/
  const slashNormalized = candidate.replace(/\\/g, '/');
  const hadUploadsPrefix = /^\/+uploads\//i.test(slashNormalized) || /^uploads\//i.test(slashNormalized);
  if (hadUploadsPrefix) {
    candidate = normalizeObjectPath(slashNormalized).replace(/^uploads\//i, '');
  } else {
    candidate = normalizeObjectPath(candidate);
  }

  // bare filename
  if (!candidate.includes('/')) {
    if (assetType === 'payment_proof' && mode === 'compat') {
      const obj = `payment-proofs/${candidate}`;
      if (hasTraversalOrInvalidSegments(obj)) {
        if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
        return null;
      }
      return { assetType, bucket: getBucketForAssetType(assetType), objectPath: obj, canonical: false };
    }
    // Legacy compat: bentuk /uploads/<filename> tanpa direktori untuk spk_photo tetap ambigu,
    // tetapi diterima sebagai non-canonical hanya bila berasal dari prefix uploads legacy.
    if (assetType === 'spk_photo' && mode === 'compat' && hadUploadsPrefix) {
      const obj = candidate;
      if (hasTraversalOrInvalidSegments(obj)) return null;
      return { assetType, bucket: getBucketForAssetType(assetType), objectPath: obj, canonical: false };
    }
    // Bare filename tanpa konteks direktori untuk spk_photo - tolak demi keamanan.
    if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid untuk asset type ini', 400, { operation, assetType });
    return null;
  }

  if (hasTraversalOrInvalidSegments(candidate)) {
    if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
    return null;
  }

  // If canonical for other asset type, reject
  const otherTypes = Object.keys(ASSET_TYPES).filter((t) => t !== assetType);
  for (const other of otherTypes) {
    if (isCanonicalForAsset(other, candidate) && !isCanonicalForAsset(assetType, candidate)) {
      if (mode === 'strict') throw makeError('INVALID_OBJECT_PATH', 'Object path tidak sesuai asset type', 400, { operation, assetType });
      return null;
    }
  }

  const canonical = isCanonicalForAsset(assetType, candidate);
  if (!canonical && mode === 'strict') {
    throw makeError('INVALID_OBJECT_PATH', 'Object path bukan canonical untuk asset type ini', 400, { operation, assetType });
  }
  return {
    assetType,
    bucket: getBucketForAssetType(assetType),
    objectPath: candidate,
    canonical,
  };
}

function legacyToObjectPathString(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^https?:\/\//i.test(raw)) {
    const { legacyBucket } = settings();
    const marker = `/storage/v1/object/public/${legacyBucket}/`;
    const index = raw.indexOf(marker);
    if (index === -1) return null;
    return decodeURIComponent(raw.slice(index + marker.length));
  }
  return normalizeObjectPath(raw).replace(/^uploads\//, '') || null;
}

function inferAssetTypeFromPath(objectPath) {
  const normalized = normalizeObjectPath(String(objectPath || ''));
  if (normalized.startsWith('spk/')) return 'spk_photo';
  if (normalized.startsWith('payment-proofs/')) return 'payment_proof';
  return null;
}

function ensureRemoteOrLocal(operation, assetType) {
  if (isRemoteConfigured()) return 'remote';
  if (isVercelRuntime()) {
    throw makeError('STORAGE_UNAVAILABLE', 'Storage remote tidak dikonfigurasi pada runtime serverless', 503, { operation, assetType });
  }
  return 'local';
}

function localRoot() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
}

function assertInsideRoot(objectPath) {
  const root = localRoot();
  const absolute = path.resolve(root, normalizeObjectPath(objectPath));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw makeError('INVALID_OBJECT_PATH', 'Path file tidak valid', 400, { operation: 'localPath', assetType: undefined });
  }
  return absolute;
}

async function upload(assetType, objectPath, buffer, contentType) {
  const operation = 'upload';
  // Compat old signature: upload(objectPath, buffer, contentType)
  if (arguments.length === 3 && typeof assetType === 'string' && !ASSET_TYPES[assetType] && Buffer.isBuffer(objectPath)) {
    const inferred = inferAssetTypeFromPath(assetType);
    if (!inferred) throw makeError('INVALID_ASSET_TYPE', 'Asset type tidak dapat dipetakan secara aman', 400, { operation, assetType: undefined });
    return upload(inferred, assetType, objectPath, buffer);
  }
  const cfg = getAssetConfig(assetType, operation);
  const normalized = validateCanonicalObjectPath(assetType, objectPath, operation);
  if (!Buffer.isBuffer(buffer)) {
    throw makeError('INVALID_INPUT', 'Buffer file tidak valid', 400, { operation, assetType });
  }
  const ct = String(contentType || contentTypeForPath(normalized) || '').trim();
  if (!ct) throw makeError('INVALID_INPUT', 'Content type tidak valid', 400, { operation, assetType });

  const mode = ensureRemoteOrLocal(operation, assetType);
  const bucket = getBucketForAssetType(assetType);

  if (mode === 'local') {
    const absolute = assertInsideRoot(normalized);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, buffer);
    return { assetType, bucket, objectPath: normalized, size: buffer.length, contentType: ct };
  }

  const { url, key } = settings();
  try {
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': ct,
        'x-upsert': 'false'
      },
      body: buffer
    });
    if (!response.ok) {
      if (response.status === 404) throw makeError('OBJECT_NOT_FOUND', 'Object storage tidak ditemukan', 404, { operation, assetType });
      if (response.status === 401 || response.status === 403) throw makeError('PERMISSION_DENIED', 'Akses storage ditolak', 403, { operation, assetType });
      throw makeError('UPSTREAM_STORAGE_ERROR', 'Gagal mengunggah file ke storage', 502, { operation, assetType });
    }
    return { assetType, bucket, objectPath: normalized, size: buffer.length, contentType: ct };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw makeError('STORAGE_UNAVAILABLE', 'Storage tidak tersedia', 503, { operation, assetType, cause: error });
  }
}

async function download(assetType, objectPath) {
  const operation = 'download';
  // Compat old signature: download(objectPath)
  if (arguments.length === 1 && typeof assetType === 'string' && !ASSET_TYPES[assetType]) {
    const inferred = inferAssetTypeFromPath(assetType);
    if (!inferred) throw makeError('INVALID_ASSET_TYPE', 'Asset type tidak dapat dipetakan secara aman', 400, { operation, assetType: undefined });
    return download(inferred, assetType);
  }
  const cfg = getAssetConfig(assetType, operation);
  if (typeof objectPath !== 'string' || !objectPath.trim()) {
    throw makeError('INVALID_OBJECT_PATH', 'Object path tidak valid', 400, { operation, assetType });
  }

  // Reject URLs / external paths
  if (/^https?:\/\//i.test(objectPath)) {
    const parsed = parseSupabaseObjectUrl(objectPath, operation, assetType);
    if (!parsed || parsed.kind === 'external' || parsed.kind === 'other-supabase' || parsed.kind === 'signed') {
      throw makeError('INVALID_OBJECT_PATH', 'URL eksternal/signed tidak diizinkan untuk object path', 400, { operation, assetType });
    }
    if (parsed.kind === 'public') {
      const allowedBuckets = new Set([getBucketForAssetType(assetType), ...LEGACY_COMPAT_BUCKETS]);
      if (!allowedBuckets.has(parsed.bucket)) {
        throw makeError('INVALID_OBJECT_PATH', 'Bucket tidak diizinkan', 400, { operation, assetType });
      }
      // Canonicalize and continue as object path only if bucket matches legacy allowed for this asset? safer: require mapped bucket
      // But for download of explicit public URL in private bucket world, reject to prevent bypass.
      throw makeError('INVALID_OBJECT_PATH', 'Public URL tidak diizinkan; gunakan object path canonical', 400, { operation, assetType });
    }
  }

  const normalized = validateCanonicalObjectPath(assetType, objectPath, operation);
  const bucket = getBucketForAssetType(assetType);
  const mode = ensureRemoteOrLocal(operation, assetType);

  if (mode === 'local') {
    try {
      const absolute = assertInsideRoot(normalized);
      const bytes = await fs.readFile(absolute);
      return { bytes, contentType: contentTypeForPath(normalized), assetType, bucket, objectPath: normalized };
    } catch (error) {
      if (error && error.code === 'ENOENT') throw makeError('OBJECT_NOT_FOUND', 'Object tidak ditemukan', 404, { operation, assetType, cause: error });
      if (error instanceof StorageError) throw error;
      throw makeError('STORAGE_UNAVAILABLE', 'Storage tidak tersedia', 503, { operation, assetType, cause: error });
    }
  }

  const { url, key } = settings();
  try {
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!response.ok) {
      if (response.status === 404) throw makeError('OBJECT_NOT_FOUND', 'Object tidak ditemukan', 404, { operation, assetType });
      if (response.status === 401 || response.status === 403) throw makeError('PERMISSION_DENIED', 'Akses storage ditolak', 403, { operation, assetType });
      throw makeError('UPSTREAM_STORAGE_ERROR', 'Gagal mengunduh file dari storage', 502, { operation, assetType });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || contentTypeForPath(normalized);
    return { bytes, contentType, assetType, bucket, objectPath: normalized };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw makeError('STORAGE_UNAVAILABLE', 'Storage tidak tersedia', 503, { operation, assetType, cause: error });
  }
}

async function remove(assetType, objectPath) {
  const operation = 'remove';
  if (arguments.length === 1 && typeof assetType === 'string' && !ASSET_TYPES[assetType]) {
    const inferred = inferAssetTypeFromPath(assetType);
    if (!inferred) {
      // old behavior tolerated null-ish; but unknown string without assetType is unsafe
      if (!assetType) return { removed: false };
      throw makeError('INVALID_ASSET_TYPE', 'Asset type tidak dapat dipetakan secara aman', 400, { operation, assetType: undefined });
    }
    return remove(inferred, assetType);
  }
  getAssetConfig(assetType, operation);
  if (!objectPath) return { assetType, bucket: getBucketForAssetType(assetType), objectPath: null, removed: false };
  const normalized = validateCanonicalObjectPath(assetType, objectPath, operation);
  const bucket = getBucketForAssetType(assetType);
  const mode = ensureRemoteOrLocal(operation, assetType);

  if (mode === 'local') {
    let removed = false;
    try {
      await fs.unlink(assertInsideRoot(normalized));
      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw makeError('STORAGE_UNAVAILABLE', 'Gagal menghapus file lokal', 503, { operation, assetType, cause: error });
    }
    return { assetType, bucket, objectPath: normalized, removed };
  }

  const { url, key } = settings();
  try {
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` }
    });
    if (response.status === 404) return { assetType, bucket, objectPath: normalized, removed: false };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw makeError('PERMISSION_DENIED', 'Akses storage ditolak', 403, { operation, assetType });
      throw makeError('UPSTREAM_STORAGE_ERROR', 'Gagal menghapus file dari storage', 502, { operation, assetType });
    }
    return { assetType, bucket, objectPath: normalized, removed: true };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw makeError('STORAGE_UNAVAILABLE', 'Storage tidak tersedia', 503, { operation, assetType, cause: error });
  }
}

async function createSignedUrl(assetType, objectPath, expiresInSeconds) {
  const operation = 'createSignedUrl';
  const cfg = getAssetConfig(assetType, operation);
  if (!cfg.signedUrlAllowed) {
    throw makeError('UNSUPPORTED_ASSET_TYPE', 'Signed URL tidak didukung untuk asset type ini', 400, { operation, assetType });
  }
  const normalized = validateCanonicalObjectPath(assetType, objectPath, operation);
  const ttl = Number(expiresInSeconds);
  if (!Number.isInteger(ttl) || ttl !== 60) {
    throw makeError('INVALID_INPUT', 'TTL signed URL harus tepat 60 detik', 400, { operation, assetType });
  }
  const bucket = getBucketForAssetType(assetType);
  const mode = ensureRemoteOrLocal(operation, assetType);
  if (mode === 'local') {
    // No public/private signed URL infra in local fallback; be explicit.
    throw makeError('STORAGE_UNAVAILABLE', 'Signed URL tidak tersedia pada local fallback', 503, { operation, assetType });
  }

  const { url, key } = settings();
  try {
    const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodeObjectPath(normalized)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: ttl })
    });
    if (!response.ok) {
      if (response.status === 404) throw makeError('OBJECT_NOT_FOUND', 'Object tidak ditemukan', 404, { operation, assetType });
      if (response.status === 401 || response.status === 403) throw makeError('PERMISSION_DENIED', 'Akses storage ditolak', 403, { operation, assetType });
      throw makeError('UPSTREAM_STORAGE_ERROR', 'Gagal membuat signed URL', 502, { operation, assetType });
    }
    const body = await response.json().catch(() => ({}));
    const signed = body.signedURL || body.signedUrl || body.url;
    if (!signed || typeof signed !== 'string') {
      throw makeError('UPSTREAM_STORAGE_ERROR', 'Respons signed URL tidak valid', 502, { operation, assetType });
    }
    const fullUrl = signed.startsWith('http') ? signed : `${url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    return { assetType, bucket, objectPath: normalized, expiresInSeconds: ttl, url: fullUrl };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw makeError('STORAGE_UNAVAILABLE', 'Storage tidak tersedia', 503, { operation, assetType, cause: error });
  }
}

module.exports = {
  ASSET_TYPES,
  StorageError,
  isRemoteConfigured,
  getBucketForAssetType,
  contentTypeForPath,
  toObjectPath,
  upload,
  download,
  remove,
  createSignedUrl,
  // Compatibility exports (deprecated for new code)
  publicUrl: function publicUrlDisabled() {
    throw makeError('UNSUPPORTED_OPERATION', 'Public URL tidak didukung untuk bucket private', 400, { operation: 'publicUrl' });
  }
};

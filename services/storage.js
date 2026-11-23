'use strict';

const fs = require('fs/promises');
const path = require('path');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function settings() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'cucimesin'
  };
}

function isRemoteConfigured() {
  const { url, key } = settings();
  return Boolean(url && key);
}

function localRoot() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
}

function legacyProofDir() {
  return path.resolve(
    process.env.PAYMENT_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'payment-proofs')
  );
}

async function readLocal(normalized) {
  try {
    return await fs.readFile(assertInsideRoot(normalized));
  } catch (error) {
    if (error.code === 'ENOENT' && normalized.startsWith('payment-proofs/')) {
      return fs.readFile(path.join(legacyProofDir(), path.basename(normalized)));
    }
    throw error;
  }
}

function normalizeObjectPath(objectPath) {
  return String(objectPath).replace(/\\/g, '/').replace(/^\/+/, '');
}

function encodeObjectPath(objectPath) {
  return normalizeObjectPath(objectPath).split('/').map(encodeURIComponent).join('/');
}

function assertInsideRoot(objectPath) {
  const root = localRoot();
  const absolute = path.resolve(root, normalizeObjectPath(objectPath));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error('Path file tidak valid');
  }
  return absolute;
}

function publicUrl(objectPath) {
  const normalized = normalizeObjectPath(objectPath);
  if (!isRemoteConfigured()) return `/uploads/${normalized}`;
  const { url, bucket } = settings();
  return `${url}/storage/v1/object/public/${bucket}/${encodeObjectPath(normalized)}`;
}

function toObjectPath(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^https?:\/\//i.test(raw)) {
    const { bucket } = settings();
    const marker = `/storage/v1/object/public/${bucket}/`;
    const index = raw.indexOf(marker);
    if (index === -1) return null;
    return decodeURIComponent(raw.slice(index + marker.length));
  }
  // Normalisasi dulu agar bentuk /uploads/, ///uploads/, atau uploads/ semua
  // diterjemahkan ke object path yang sama seperti saat file disimpan.
  return normalizeObjectPath(raw).replace(/^uploads\//, '') || null;
}

function contentTypeForPath(objectPath) {
  const ext = path.extname(String(objectPath).split('?')[0]).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function upload(objectPath, buffer, contentType) {
  const normalized = normalizeObjectPath(objectPath);
  if (!isRemoteConfigured()) {
    const absolute = assertInsideRoot(normalized);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, buffer);
    return publicUrl(normalized);
  }

  const { url, bucket, key } = settings();
  const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType || contentTypeForPath(normalized),
      'x-upsert': 'false'
    },
    body: buffer
  });
  if (!response.ok) {
    const error = new Error(`Gagal mengunggah file: ${response.status} ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return publicUrl(normalized);
}

async function download(objectPath) {
  const normalized = normalizeObjectPath(objectPath);
  if (!isRemoteConfigured()) return readLocal(normalized);

  const { url, bucket, key } = settings();
  const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) throw new Error(`Gagal mengunduh file: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function remove(objectPath) {
  if (!objectPath) return;
  const normalized = normalizeObjectPath(objectPath);
  if (!isRemoteConfigured()) {
    try {
      await fs.unlink(assertInsideRoot(normalized));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (normalized.startsWith('payment-proofs/')) {
      try {
        await fs.unlink(path.join(legacyProofDir(), path.basename(normalized)));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return;
  }

  const { url, bucket, key } = settings();
  const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeObjectPath(normalized)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Gagal menghapus file: ${response.status}`);
  }
}

module.exports = {
  isRemoteConfigured,
  publicUrl,
  toObjectPath,
  contentTypeForPath,
  upload,
  download,
  remove
};

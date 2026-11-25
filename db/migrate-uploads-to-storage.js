'use strict';

// Migrasi upload lama ke Supabase Storage private bucket (offline-safe orchestrator).
// Default: dry-run (tidak upload, tidak mutasi DB, tidak hapus sumber).
// CLI nyata hanya berjalan bila file dieksekusi langsung.

require('../utils/env').loadEnvIfAllowed();
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const defaultStorage = require('../services/storage');

const ASSET_TYPES = {
  spk_photo: {
    assetType: 'spk_photo',
    canonicalPrefix: 'spk/',
    allowedExts: new Set(['.jpg', '.jpeg', '.png', '.webp']),
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp'])
  },
  payment_proof: {
    assetType: 'payment_proof',
    canonicalPrefix: 'payment-proofs/',
    allowedExts: new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']),
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  }
};

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'
};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeRel(root, absolute) {
  const rel = path.relative(root, absolute);
  return rel.split(path.sep).join('/');
}

function sanitizeError(err) {
  const msg = String(err && err.message ? err.message : err || 'Unknown error');
  return msg
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/(service_role|SUPABASE_SERVICE_ROLE_KEY|secret)[^\s]*/gi, '[REDACTED]')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[REDACTED_PATH]')
    .replace(/\/(Users|home|var|tmp|etc|private)\/[^\s"']+/g, '[REDACTED_PATH]');
}

function normalizePosix(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isPathInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function detectAssetType(objectPath, options = {}) {
  const p = normalizePosix(objectPath);
  if (p.startsWith('payment-proofs/')) return 'payment_proof';
  if (p.startsWith('spk/')) return 'spk_photo';
  // Legacy: files under uploadDir not under payment-proofs are SPK photos only when clearly under spk-like path? Do not guess.
  if (options.allowSpkLegacy && !p.startsWith('payment-proofs/')) return 'spk_photo';
  return null;
}

function canonicalizeObjectPath(assetType, objectPath) {
  const cfg = ASSET_TYPES[assetType];
  if (!cfg) return null;
  const p = normalizePosix(objectPath).replace(/^\/+/, '');
  if (!p.startsWith(cfg.canonicalPrefix)) return null;
  return p;
}

function isValidExtAndMime(assetType, filePath, contentType) {
  const cfg = ASSET_TYPES[assetType];
  if (!cfg) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mime = String(contentType || MIME_BY_EXT[ext] || '').toLowerCase();
  return cfg.allowedExts.has(ext) && cfg.allowedMimes.has(mime);
}

function hasTraversal(raw) {
  const s = String(raw || '');
  if (s.includes('\0')) return true;
  let decoded = s;
  try { decoded = decodeURIComponent(s); } catch { return true; }
  const norm = decoded.replace(/\\/g, '/');
  return norm.split('/').some(seg => seg === '..' || seg === '.');
}

function isValidSpkId(spkId) {
  const s = String(spkId == null ? '' : spkId).trim();
  if (!s) return false;
  if (s === '.' || s === '..') return false;
  if (/[\\/]/.test(s)) return false;
  if (/[\0\r\n\t]/.test(s)) return false;
  if (/%2e|%2f|%5c/i.test(s)) return false;
  // conservative: allow alphanum, dash, underscore, dot but no leading dot-only
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
}

function isValidFilename(filename) {
  const s = String(filename == null ? '' : filename).trim();
  if (!s) return false;
  if (s === '.' || s === '..') return false;
  if (/[\\/]/.test(s)) return false;
  if (/[\0\r\n\t]/.test(s)) return false;
  if (/%2e|%2f|%5c/i.test(s)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(s);
}

function validateCanonicalPath(assetType, objectPath) {
  const cfg = ASSET_TYPES[assetType];
  if (!cfg) return { ok: false, reason: 'REJECTED_ASSET_TYPE' };
  const p = normalizePosix(objectPath).replace(/^\/+/, '');
  if (!p || hasTraversal(p) || p.includes('\\') || p.includes('//')) return { ok: false, reason: 'REJECTED_PATH' };
  const expectedPrefix = cfg.canonicalPrefix;
  if (!p.startsWith(expectedPrefix)) return { ok: false, reason: 'REJECTED_NON_CANONICAL' };
  const rest = p.slice(expectedPrefix.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.length !== 2) return { ok: false, reason: 'REJECTED_NON_CANONICAL' };
  const [spkId, filename] = segments;
  if (!isValidSpkId(spkId)) return { ok: false, reason: 'REJECTED_NON_CANONICAL' };
  if (!isValidFilename(filename)) return { ok: false, reason: 'REJECTED_NON_CANONICAL' };
  const ext = path.extname(filename).toLowerCase();
  if (!cfg.allowedExts.has(ext)) return { ok: false, reason: 'REJECTED_INVALID_FILE' };
  const canonical = `${expectedPrefix}${spkId}/${filename}`;
  if (canonical !== p) return { ok: false, reason: 'REJECTED_NON_CANONICAL' };
  return { ok: true, canonical, spkId, filename, assetType };
}

function normalizeMappingInput(mapping) {
  const entries = [];
  if (!mapping) return entries;
  if (Array.isArray(mapping)) {
    for (const m of mapping) entries.push(m);
  } else if (typeof mapping === 'object') {
    for (const [k, v] of Object.entries(mapping)) {
      if (v && typeof v === 'object') entries.push({ source: k, ...v });
      else entries.push({ source: k, spkId: v });
    }
  }
  return entries;
}

function buildMappingIndex(options) {
  const rawEntries = [
    ...normalizeMappingInput(options.mapping),
    ...normalizeMappingInput(options.mappings),
    ...normalizeMappingInput(options.legacyMapping),
    ...normalizeMappingInput(options.legacyMappings)
  ];
  const index = new Map();
  const errors = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') {
      errors.push({ source: '', reason: 'REJECTED_MAPPING_INVALID' });
      continue;
    }
    const source = normalizePosix(raw.source || raw.relativePath || raw.path || raw.from || raw.file || '').replace(/^\/+/, '');
    const assetType = raw.assetType || raw.type || raw.asset_type || null;
    const spkId = raw.spkId == null ? raw.spk_id : raw.spkId;
    const filename = raw.filename == null ? raw.targetFilename : raw.filename;
    if (!source || hasTraversal(source)) {
      errors.push({ source, reason: 'REJECTED_MAPPING_INVALID' });
      continue;
    }
    if (!ASSET_TYPES[assetType]) {
      errors.push({ source, reason: 'REJECTED_MAPPING_INVALID' });
      continue;
    }
    if (!isValidSpkId(spkId)) {
      errors.push({ source, reason: 'REJECTED_MAPPING_INVALID' });
      continue;
    }
    if (filename != null && !isValidFilename(filename)) {
      errors.push({ source, reason: 'REJECTED_MAPPING_INVALID' });
      continue;
    }
    const key = source;
    if (index.has(key)) {
      errors.push({ source, reason: 'REJECTED_MAPPING_DUPLICATE' });
      continue;
    }
    index.set(key, { source: key, assetType, spkId: String(spkId).trim(), filename: filename == null ? null : String(filename).trim() });
  }
  return { index, errors };
}

async function collectFiles(root, objectPrefix = '', sourceRoot = root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    const relFromRoot = path.relative(sourceRoot, absolute);
    const relPosix = normalizePosix(relFromRoot);
    const objectPath = normalizePosix(path.posix.join(objectPrefix, entry.name));

    if (entry.isSymbolicLink()) {
      files.push({ absolute, objectPath, relPath: relPosix, symlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute, objectPath, sourceRoot));
    } else if (entry.isFile()) {
      files.push({ absolute, objectPath, relPath: relPosix, symlink: false });
    }
  }
  return files;
}

async function defaultDownload(adapter, assetType, objectPath) {
  if (adapter && typeof adapter.download === 'function') return adapter.download(assetType, objectPath);
  throw new Error('Storage adapter download() tidak tersedia');
}

async function defaultUpload(adapter, assetType, objectPath, bytes, contentType) {
  if (adapter && typeof adapter.upload === 'function') return adapter.upload(assetType, objectPath, bytes, contentType);
  throw new Error('Storage adapter upload() tidak tersedia');
}

async function runMigration(options = {}) {
  const dryRun = options.dryRun !== false; // default true
  const adapter = options.storage || options.adapter || defaultStorage;
  const sourceRoot = path.resolve(options.sourceRoot || process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
  const uploadDir = path.resolve(options.uploadDir || sourceRoot);
  const proofDir = path.resolve(options.paymentProofDir || options.proofDir || process.env.PAYMENT_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'payment-proofs'));
  const selectedAssetTypes = new Set(options.assetTypes || ['spk_photo', 'payment_proof']);
  for (const t of selectedAssetTypes) {
    if (!ASSET_TYPES[t]) throw new Error(`Asset type tidak didukung: ${t}`);
  }

  if (options.db) {
    // Safety: orchestrator must not mutate DB. If a db handle is passed, we only allow read-only inspection by caller outside; we never call it.
  }

  const report = {
    dryRun,
    startedAt: new Date().toISOString(),
    sourceRoot: safeRel(process.cwd(), sourceRoot) || '.',
    items: [],
    summary: { scanned: 0, planned: 0, uploaded: 0, verified: 0, skipped_identical: 0, conflicts: 0, failed: 0, rejected: 0 }
  };

  const mappingBuilt = buildMappingIndex(options);
  for (const mErr of mappingBuilt.errors) {
    report.summary.rejected += 1;
    report.items.push({
      source: mErr.source || null,
      objectPath: null,
      assetType: null,
      status: mErr.reason || 'REJECTED_MAPPING_INVALID',
      action: 'reject',
      error: 'Invalid explicit mapping'
    });
  }

  const [spkRaw, proofRaw] = await Promise.all([
    selectedAssetTypes.has('spk_photo') ? collectFiles(uploadDir, '', uploadDir) : [],
    selectedAssetTypes.has('payment_proof') ? collectFiles(proofDir, '', proofDir) : []
  ]);

  const rawFiles = [];
  for (const f of spkRaw) {
    const rel = normalizePosix(f.relPath).replace(/^\/+/, '');
    if (rel.startsWith('payment-proofs/')) continue; // avoid duplicate scan when dirs overlap
    rawFiles.push({ ...f, scanBase: uploadDir, scanTypeHint: 'spk_photo', sourceRel: rel });
  }
  for (const f of proofRaw) {
    const rel = normalizePosix(f.relPath).replace(/^\/+/, '');
    rawFiles.push({ ...f, scanBase: proofDir, scanTypeHint: 'payment_proof', sourceRel: rel });
  }

  // Resolve candidates first to detect duplicate target paths deterministically.
  const candidates = [];
  const usedMappingKeys = new Set();
  for (const file of rawFiles) {
    const relPath = normalizePosix(file.sourceRel).replace(/^\/+/, '');
    const mappingKeys = [relPath, normalizePosix(path.posix.join(path.basename(file.scanBase), relPath))];
    let mapping = null;
    let mappingKey = null;
    for (const k of mappingKeys) {
      if (mappingBuilt.index.has(k)) { mapping = mappingBuilt.index.get(k); mappingKey = k; break; }
    }
    if (mappingKey) usedMappingKeys.add(mappingKey);

    let assetType = null;
    let objectPath = null;
    let rejectStatus = null;
    let rejectReason = null;

    if (mapping) {
      assetType = mapping.assetType;
      const filename = mapping.filename || path.posix.basename(relPath);
      if (!ASSET_TYPES[assetType]) {
        rejectStatus = 'REJECTED_MAPPING_INVALID';
      } else if (!isValidSpkId(mapping.spkId) || !isValidFilename(filename)) {
        rejectStatus = 'REJECTED_MAPPING_INVALID';
      } else {
        objectPath = normalizePosix(path.posix.join(ASSET_TYPES[assetType].canonicalPrefix, String(mapping.spkId).trim(), filename));
      }
    } else {
      // No explicit mapping: only accept already-canonical path shape with valid spkId/filename.
      const canonicalSpk = relPath.startsWith('spk/');
      const canonicalProof = relPath.startsWith('payment-proofs/');
      if (canonicalSpk || canonicalProof) {
        assetType = canonicalSpk ? 'spk_photo' : 'payment_proof';
        objectPath = relPath;
      } else {
        // Legacy ambiguous (e.g. uploads/filename.png without spkId) - never guess.
        assetType = file.scanTypeHint || null;
        rejectStatus = 'REJECTED_AMBIGUOUS';
        rejectReason = 'Missing explicit mapping for non-canonical legacy path';
      }
    }

    candidates.push({ file, relPath, mapping, assetType, objectPath, rejectStatus, rejectReason });
  }

  // Mark mappings that didn't match any scanned file as rejected (safe report, no guessing)
  for (const [k, m] of mappingBuilt.index.entries()) {
    if (!usedMappingKeys.has(k)) {
      report.summary.rejected += 1;
      report.items.push({
        source: k,
        objectPath: null,
        assetType: m.assetType,
        status: 'REJECTED_MAPPING_UNUSED',
        action: 'reject',
        error: 'Mapping source not found in scanned files'
      });
    }
  }

  const targetCounts = new Map();
  for (const c of candidates) {
    if (c.objectPath && !c.rejectStatus) {
      targetCounts.set(c.objectPath, (targetCounts.get(c.objectPath) || 0) + 1);
    }
  }

  const files = candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const plannedTargets = new Set();

  for (const candidate of files) {
    report.summary.scanned += 1;
    const file = candidate.file;
    const relPath = normalizePosix(candidate.relPath || file.relPath || '').replace(/^\/+/, '');
    const item = {
      source: relPath,
      objectPath: candidate.objectPath || null,
      assetType: candidate.assetType || null,
      status: null,
      action: null
    };

    try {
      if (candidate.rejectStatus) {
        item.status = candidate.rejectStatus;
        item.action = 'reject';
        item.error = candidate.rejectReason || 'Rejected';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }

      if (file.symlink) {
        const real = await fs.realpath(file.absolute).catch(() => null);
        const baseRoot = file.scanBase;
        if (!real || !isPathInside(baseRoot, real)) {
          item.status = 'REJECTED_SYMLINK_ESCAPE';
          item.action = 'reject';
          report.summary.rejected += 1;
          report.items.push(item);
          continue;
        }
      }

      const baseRoot = file.scanBase;
      if (!isPathInside(baseRoot, file.absolute) || hasTraversal(relPath) || hasTraversal(candidate.objectPath || '')) {
        item.status = 'REJECTED_PATH';
        item.action = 'reject';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }

      const assetType = candidate.assetType;
      item.assetType = assetType;
      if (!assetType || !ASSET_TYPES[assetType] || !selectedAssetTypes.has(assetType)) {
        item.status = !selectedAssetTypes.has(assetType) ? 'REJECTED_ASSET_TYPE' : 'REJECTED_MAPPING_INVALID';
        item.action = 'reject';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }

      const validation = validateCanonicalPath(assetType, candidate.objectPath);
      if (!validation.ok) {
        item.status = validation.reason;
        item.action = 'reject';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }
      const canonical = validation.canonical;
      item.objectPath = canonical;
      item.spkId = validation.spkId;
      item.filename = validation.filename;

      const bytes = await fs.readFile(file.absolute);
      const contentType = MIME_BY_EXT[path.extname(validation.filename).toLowerCase()] || MIME_BY_EXT[path.extname(file.absolute).toLowerCase()] || 'application/octet-stream';
      if (!isValidExtAndMime(assetType, validation.filename, contentType) || !isValidExtAndMime(assetType, file.absolute, contentType)) {
        item.status = 'REJECTED_INVALID_FILE';
        item.action = 'reject';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }

      const sourceHash = sha256(bytes);
      const sourceSize = bytes.length;
      item.size = sourceSize;
      item.sha256 = sourceHash;
      item.contentType = contentType;

      if ((targetCounts.get(canonical) || 0) > 1 || plannedTargets.has(canonical)) {
        item.status = 'CONFLICT';
        item.action = 'conflict';
        item.error = 'Duplicate target objectPath';
        report.summary.conflicts += 1;
        report.items.push(item);
        continue;
      }

      if (dryRun) {
        item.status = 'PLANNED';
        item.action = 'dry-run';
        plannedTargets.add(canonical);
        report.summary.planned += 1;
        report.items.push(item);
        continue;
      }

      // Guard before any upload
      const guard = validateCanonicalPath(assetType, canonical);
      if (!guard.ok) {
        item.status = guard.reason;
        item.action = 'reject';
        report.summary.rejected += 1;
        report.items.push(item);
        continue;
      }

      // Check existing destination
      let existing = null;
      try {
        const dl = await defaultDownload(adapter, assetType, canonical);
        const existingBytes = Buffer.isBuffer(dl) ? dl : dl && dl.bytes;
        if (Buffer.isBuffer(existingBytes)) {
          existing = { bytes: existingBytes, sha256: sha256(existingBytes), size: existingBytes.length };
        }
      } catch (err) {
        const status = err && (err.status || err.statusCode);
        if (status !== 404) {
          item.status = 'VERIFY_FAILED';
          item.action = 'verify';
          item.error = sanitizeError(err);
          report.summary.failed += 1;
          report.items.push(item);
          continue;
        }
      }

      if (existing) {
        if (existing.sha256 === sourceHash && existing.size === sourceSize) {
          item.status = 'SKIPPED_IDENTICAL';
          item.action = 'skip';
          plannedTargets.add(canonical);
          report.summary.skipped_identical += 1;
          report.summary.verified += 1;
          report.items.push(item);
          continue;
        }
        item.status = 'CONFLICT';
        item.action = 'conflict';
        item.error = 'Target object exists with different checksum';
        item.existing = { size: existing.size, sha256: existing.sha256 };
        report.summary.conflicts += 1;
        report.items.push(item);
        continue;
      }

      // Upload
      if (plannedTargets.has(canonical)) {
        item.status = 'CONFLICT';
        item.action = 'conflict';
        item.error = 'Duplicate target objectPath';
        report.summary.conflicts += 1;
        report.items.push(item);
        continue;
      }
      try {
        await defaultUpload(adapter, assetType, canonical, bytes, contentType);
        plannedTargets.add(canonical);
        report.summary.uploaded += 1;
      } catch (err) {
        item.status = 'UPLOAD_FAILED';
        item.action = 'upload';
        item.error = sanitizeError(err);
        report.summary.failed += 1;
        report.items.push(item);
        continue;
      }

      // Verify by download
      try {
        const dl2 = await defaultDownload(adapter, assetType, canonical);
        const outBytes = Buffer.isBuffer(dl2) ? dl2 : dl2 && dl2.bytes;
        if (!Buffer.isBuffer(outBytes)) throw new Error('Download verification returned invalid bytes');
        const outHash = sha256(outBytes);
        const outSize = outBytes.length;
        if (outSize !== sourceSize || outHash !== sourceHash) {
          item.status = 'VERIFY_FAILED';
          item.action = 'verify';
          item.expected = { size: sourceSize, sha256: sourceHash };
          item.actual = { size: outSize, sha256: outHash };
          report.summary.failed += 1;
          report.items.push(item);
          continue;
        }
        item.status = 'VERIFIED';
        item.action = 'copied';
        report.summary.verified += 1;
        report.items.push(item);
      } catch (err) {
        item.status = 'VERIFY_FAILED';
        item.action = 'verify';
        item.error = sanitizeError(err);
        report.summary.failed += 1;
        report.items.push(item);
      }
    } catch (err) {
      item.status = item.status || 'FAILED';
      item.action = item.action || 'process';
      item.error = sanitizeError(err);
      report.summary.failed += 1;
      report.items.push(item);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dryRun = !apply;
  if (apply && !defaultStorage.isRemoteConfigured()) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diisi untuk --apply.');
  }
  const report = await runMigration({
    dryRun,
    uploadDir: path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')),
    paymentProofDir: path.resolve(process.env.PAYMENT_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'payment-proofs')),
    storage: defaultStorage
  });
  console.log(JSON.stringify(report.summary));
  if (!dryRun && report.summary.failed > 0) process.exitCode = 1;
  if (dryRun) console.log('Jalankan dengan --apply setelah memeriksa rencana di atas.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitizeError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  runMigration,
  _internal: {
    sha256,
    sanitizeError,
    detectAssetType,
    canonicalizeObjectPath,
    isValidExtAndMime,
    hasTraversal,
    isValidSpkId,
    isValidFilename,
    validateCanonicalPath,
    buildMappingIndex
  }
};

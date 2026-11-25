const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATE_MODULE = require.resolve('../db/migrate-uploads-to-storage');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeFakeStorage(initial = {}) {
  const objects = new Map(); // key: assetType::objectPath -> {bytes, contentType}
  for (const [k, v] of Object.entries(initial)) objects.set(k, { bytes: Buffer.from(v.bytes), contentType: v.contentType || 'application/octet-stream' });
  const calls = { upload: [], download: [], remove: [] };
  return {
    calls,
    objects,
    async upload(assetType, objectPath, bytes, contentType) {
      calls.upload.push({ assetType, objectPath, size: bytes.length, contentType });
      objects.set(`${assetType}::${objectPath}`, { bytes: Buffer.from(bytes), contentType });
      return { assetType, objectPath, size: bytes.length, contentType };
    },
    async download(assetType, objectPath) {
      calls.download.push({ assetType, objectPath });
      const v = objects.get(`${assetType}::${objectPath}`);
      if (!v) { const e = new Error('not found'); e.status = 404; throw e; }
      return { bytes: Buffer.from(v.bytes), contentType: v.contentType, assetType, objectPath };
    },
    async remove(assetType, objectPath) {
      calls.remove.push({ assetType, objectPath });
      objects.delete(`${assetType}::${objectPath}`);
      return { removed: true };
    }
  };
}

async function makeTempTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-'));
  const uploadDir = path.join(root, 'uploads');
  const proofDir = path.join(root, 'payment-proofs');
  await fs.mkdir(path.join(uploadDir, 'spk', '1'), { recursive: true });
  await fs.mkdir(path.join(proofDir, 'payment-proofs', '1'), { recursive: true });
  await fs.writeFile(path.join(uploadDir, 'spk', '1', 'foto.jpg'), Buffer.from('spk-photo'));
  await fs.writeFile(path.join(proofDir, 'payment-proofs', '1', 'bukti.png'), Buffer.from('proof-image'));
  return { root, uploadDir, proofDir };
}

async function snapshotTree(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push({ p: path.relative(dir, p).replace(/\\/g,'/'), bytes: await fs.readFile(p) });
    }
  }
  await walk(dir);
  out.sort((a,b)=>a.p.localeCompare(b.p));
  return out.map(x => ({ p: x.p, hash: sha256(x.bytes), size: x.bytes.length }));
}

test('migrate uploads to storage contract (Tahap 4.5/5.6)', async (t) => {
  await t.test('migration module must expose safe offline orchestrator without side effects on require', async () => {
    const source = await fs.readFile(MIGRATE_MODULE, 'utf8');
    const hasRunMigrationExport = /module\.exports\s*=\s*\{[\s\S]*runMigration|exports\.runMigration\s*=/.test(source);
    const hasMainGuard = /require\.main\s*===\s*module/.test(source);
    assert.ok(hasRunMigrationExport, 'runMigration harus diekspor untuk pengujian/offline orchestration');
    assert.ok(hasMainGuard, 'main() tidak boleh berjalan saat module di-require (harus guard require.main)');
    // Requiring should be safe/offline
    delete require.cache[MIGRATE_MODULE];
    const mod = require('../db/migrate-uploads-to-storage');
    assert.equal(typeof mod.runMigration, 'function');
  });

  await t.test('dry-run reports planned actions and does not upload/mutate/delete', async () => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const beforeUpload = await snapshotTree(uploadDir);
    const beforeProof = await snapshotTree(proofDir);
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({ dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    assert.equal(report.dryRun, true);
    assert.equal(storage.calls.upload.length, 0);
    assert.equal(storage.calls.remove.length, 0);
    assert.ok(report.summary.scanned >= 2);
    assert.ok(report.summary.planned >= 2);
    assert.deepEqual(await snapshotTree(uploadDir), beforeUpload);
    assert.deepEqual(await snapshotTree(proofDir), beforeProof);
    assert.ok(report.items.every(i => ['PLANNED','REJECTED_PATH','REJECTED_INVALID_FILE','REJECTED_ASSET_TYPE','REJECTED_NON_CANONICAL','REJECTED_SYMLINK_ESCAPE'].includes(i.status)));
  });

  await t.test('copy uploads to correct bucket per assetType without DB mutation', async () => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    let dbTouched = false;
    const report = await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root, db: { query(){ dbTouched = true; } } });
    assert.equal(dbTouched, false);
    assert.ok(storage.calls.upload.length >= 2);
    const spk = storage.calls.upload.find(c => c.assetType === 'spk_photo');
    const proof = storage.calls.upload.find(c => c.assetType === 'payment_proof');
    assert.ok(spk, 'harus ada upload spk_photo');
    assert.ok(proof, 'harus ada upload payment_proof');
    assert.match(spk.objectPath, /^spk\//);
    assert.match(proof.objectPath, /^payment-proofs\//);
    assert.equal(report.summary.uploaded >= 2, true);
    assert.equal(report.summary.failed, 0);
  });

  await t.test('verify checks existence and checksum; idempotent rerun skips identical objects', async () => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const r1 = await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    assert.equal(r1.summary.failed, 0);
    assert.ok(r1.summary.verified >= 2);
    const uploadsAfterFirst = storage.calls.upload.length;
    const r2 = await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    assert.equal(storage.calls.upload.length, uploadsAfterFirst, 'rerun identik tidak boleh upload ulang');
    assert.ok(r2.summary.skipped_identical >= 2 || r2.summary.verified >= 2);
    assert.equal(r2.summary.conflicts, 0);
  });

  await t.test('conflict with different checksum does not overwrite without explicit rule', async () => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    // seed conflicting object with same path but different bytes
    const storage = makeFakeStorage({
      'spk_photo::spk/1/foto.jpg': { bytes: Buffer.from('different'), contentType: 'image/jpeg' }
    });
    const report = await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    const conflict = report.items.find(i => i.objectPath === 'spk/1/foto.jpg');
    assert.ok(conflict);
    assert.equal(conflict.status, 'CONFLICT');
    assert.equal(report.summary.conflicts >= 1, true);
    // existing object should remain unchanged
    const existing = storage.objects.get('spk_photo::spk/1/foto.jpg');
    assert.equal(existing.bytes.toString(), 'different');
  });

  await t.test('source files are never deleted and cleanup requires explicit approval flag', async () => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const beforeUpload = await snapshotTree(uploadDir);
    const beforeProof = await snapshotTree(proofDir);
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root, cleanup: true });
    assert.deepEqual(await snapshotTree(uploadDir), beforeUpload, 'file sumber SPK tidak boleh dihapus');
    assert.deepEqual(await snapshotTree(proofDir), beforeProof, 'file sumber bukti tidak boleh dihapus');
    assert.equal(storage.calls.remove.length, 0, 'tidak boleh memanggil storage.remove');
  });

  await t.test('rejects traversal/symlink escape/invalid file/ambiguous asset; report has no secrets/absolute paths', async (st) => {
    const { root, uploadDir, proofDir } = await makeTempTree();
    st.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    await fs.writeFile(path.join(uploadDir, 'spk', '1', 'evil.txt'), 'bad');
    // symlink escape (best effort; skip assertion if OS disallows)
    let symlinkCreated = false;
    try {
      const outside = path.join(root, 'outside.jpg');
      await fs.writeFile(outside, 'outside');
      await fs.symlink(outside, path.join(uploadDir, 'spk', '1', 'link.jpg'));
      symlinkCreated = true;
    } catch {}
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({ dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    const txt = report.items.find(i => i.source && i.source.endsWith('evil.txt'));
    assert.ok(txt);
    assert.match(txt.status, /REJECTED/);
    if (symlinkCreated) {
      const sym = report.items.find(i => i.source && i.source.endsWith('link.jpg'));
      assert.ok(sym);
      assert.match(sym.status, /REJECTED/);
    }
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(process.env.SUPABASE_SERVICE_ROLE_KEY || '___never___'));
    assert.ok(!/[A-Za-z]:\\Users\\/.test(serialized), 'report tidak boleh bocor absolute path Windows');
  });

  await t.test('root uploads without explicit mapping are REJECTED_AMBIGUOUS and never uploaded/planned', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-amb-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, 'legacy.jpg'), Buffer.from('legacy'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({ dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    const item = report.items.find(i => i.source === 'legacy.jpg');
    assert.ok(item);
    assert.equal(item.status, 'REJECTED_AMBIGUOUS');
    assert.equal(report.summary.planned, 0);
    assert.equal(storage.calls.upload.length, 0);
  });

  await t.test('root uploads with explicit valid mapping becomes PLANNED with canonical spk path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-map-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, 'legacy.jpg'), Buffer.from('legacy'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({
      dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root,
      mapping: [{ source: 'legacy.jpg', assetType: 'spk_photo', spkId: '123' }]
    });
    const item = report.items.find(i => i.source === 'legacy.jpg');
    assert.ok(item);
    assert.equal(item.status, 'PLANNED');
    assert.equal(item.assetType, 'spk_photo');
    assert.equal(item.objectPath, 'spk/123/legacy.jpg');
    assert.equal(storage.calls.upload.length, 0);
  });

  await t.test('mapping without/invalid spkId or traversal is rejected', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-badmap-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, 'legacy.jpg'), Buffer.from('legacy'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({
      dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root,
      mapping: [
        { source: 'legacy.jpg', assetType: 'spk_photo' },
        { source: 'legacy.jpg', assetType: 'spk_photo', spkId: '' },
        { source: 'legacy.jpg', assetType: 'spk_photo', spkId: '../x' }
      ]
    });
    assert.equal(report.summary.planned, 0);
    assert.ok(report.items.some(i => /REJECTED_MAPPING_INVALID/.test(i.status)));
    assert.equal(storage.calls.upload.length, 0);
  });

  await t.test('duplicate target objectPath conflicts and never overwrites/uploads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-dupt-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, 'a.jpg'), Buffer.from('A'));
    await fs.writeFile(path.join(uploadDir, 'b.jpg'), Buffer.from('B'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({
      dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root,
      mapping: [
        { source: 'a.jpg', assetType: 'spk_photo', spkId: '9', filename: 'same.jpg' },
        { source: 'b.jpg', assetType: 'spk_photo', spkId: '9', filename: 'same.jpg' }
      ]
    });
    assert.ok(report.summary.conflicts >= 1);
    assert.equal(storage.calls.upload.length, 0);
    assert.ok(report.items.filter(i => i.objectPath === 'spk/9/same.jpg').every(i => i.status === 'CONFLICT' || i.status === 'REJECTED_MAPPING_INVALID'));
  });

  await t.test('identical checksum with different spkId mapping is not auto-merged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-samehash-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    const bytes = Buffer.from('same-bytes');
    await fs.writeFile(path.join(uploadDir, 'a.jpg'), bytes);
    await fs.writeFile(path.join(uploadDir, 'b.jpg'), bytes);
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({
      dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root,
      mapping: [
        { source: 'a.jpg', assetType: 'spk_photo', spkId: '1', filename: 'foto.jpg' },
        { source: 'b.jpg', assetType: 'spk_photo', spkId: '2', filename: 'foto.jpg' }
      ]
    });
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.conflicts, 0);
    const a = report.items.find(i => i.objectPath === 'spk/1/foto.jpg');
    const b = report.items.find(i => i.objectPath === 'spk/2/foto.jpg');
    assert.equal(a.status, 'VERIFIED');
    assert.equal(b.status, 'VERIFIED');
    assert.equal(storage.calls.upload.length, 2);
  });

  await t.test('canonical payment proof path accepted only with explicit valid mapping/asset type', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-proof-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(path.join(proofDir, 'payment-proofs', '7'), { recursive: true });
    await fs.writeFile(path.join(proofDir, 'payment-proofs', '7', 'bukti.jpg'), Buffer.from('proof'));
    await fs.writeFile(path.join(uploadDir, 'loose-proof.jpg'), Buffer.from('proof2'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    const report = await runMigration({
      dryRun: true, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root,
      mapping: [{ source: 'loose-proof.jpg', assetType: 'payment_proof', spkId: '7' }]
    });
    const canonical = report.items.find(i => i.objectPath === 'payment-proofs/7/bukti.jpg');
    const mapped = report.items.find(i => i.objectPath === 'payment-proofs/7/loose-proof.jpg');
    assert.ok(canonical);
    assert.equal(canonical.status, 'PLANNED');
    assert.ok(mapped);
    assert.equal(mapped.status, 'PLANNED');
  });

  await t.test('apply guard: ambiguous items cannot reach upload in non-dry-run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cucimesin-migrate-guard-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const uploadDir = path.join(root, 'uploads');
    const proofDir = path.join(root, 'payment-proofs');
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(uploadDir, 'legacy.jpg'), Buffer.from('legacy'));
    delete require.cache[MIGRATE_MODULE];
    const { runMigration } = require('../db/migrate-uploads-to-storage');
    const storage = makeFakeStorage();
    storage.upload = async () => { throw new Error('upload must not be called for ambiguous item'); };
    const report = await runMigration({ dryRun: false, uploadDir, paymentProofDir: proofDir, storage, sourceRoot: root });
    const item = report.items.find(i => i.source === 'legacy.jpg');
    assert.equal(item.status, 'REJECTED_AMBIGUOUS');
    assert.equal(report.summary.uploaded, 0);
  });
});

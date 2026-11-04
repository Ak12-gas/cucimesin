const express = require('express');
const db = require('../db/database');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const { loadSpk, authorizeSpk } = require('../middleware/spk-access');
const { generateNoSPK, defaultChecklist, toLocalDateTimeString } = require('../utils/helper');
const { generateSPKPdf } = require('../services/pdfservice');
const router = express.Router();
const VALID_PHOTO_TYPES = ['sebelum', 'sesudah'];

const VALID_STATUSES = ['Menunggu', 'Dikerjakan', 'Selesai', 'Batal'];

async function writeAudit(entityType, entityId, action, actor, detail = null, connection) {
  if (!actor) return;
  await db.run(`
    INSERT INTO audit_log (entity_type, entity_id, action, actor_id, actor_role, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [entityType, entityId, action, actor.id || null, actor.role || null, detail ? JSON.stringify(detail) : null], connection);
}

function validateExistingReference(row, fieldName, tableName, message) {
  if (row === undefined || row === null) {
    throw new Error(`${fieldName} tidak valid`);
  }
  return Number(row.id || row);
}

async function validatePayload(req) {
  const { pelanggan_id, mitra_id, teknisi_id, diskon } = req.body;

  if (pelanggan_id !== undefined && pelanggan_id !== null && pelanggan_id !== '') {
    const pelanggan = await db.get('SELECT id FROM pelanggan WHERE id=?', [Number(pelanggan_id)]);
    validateExistingReference(pelanggan, 'pelanggan_id', 'pelanggan', 'pelanggan_id tidak valid');
  }

  if (mitra_id !== undefined && mitra_id !== null && mitra_id !== '') {
    const mitra = await db.get('SELECT id FROM mitra WHERE id=?', [Number(mitra_id)]);
    validateExistingReference(mitra, 'mitra_id', 'mitra', 'mitra_id tidak valid');
  }

  if (teknisi_id !== undefined && teknisi_id !== null && teknisi_id !== '') {
    const teknisi = await db.get("SELECT id FROM users WHERE id=? AND role='teknisi' AND aktif=1", [Number(teknisi_id)]);
    validateExistingReference(teknisi, 'teknisi_id', 'users', 'teknisi_id tidak valid');
  }

  const safeDiskon = Number(diskon ?? 0);
  if (!Number.isFinite(safeDiskon) || safeDiskon < 0) {
    throw new Error('diskon harus berupa angka positif');
  }

  return { pelanggan_id: pelanggan_id === '' ? null : pelanggan_id ? Number(pelanggan_id) : null,
    mitra_id: mitra_id === '' ? null : mitra_id ? Number(mitra_id) : null,
    teknisi_id: teknisi_id === '' ? null : teknisi_id ? Number(teknisi_id) : null,
    diskon: safeDiskon };
}

function buildSpkQuery(whereClauses = [], values = []) {
  const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return {
    countQuery: `
      SELECT COUNT(*) AS total
      FROM spk
      LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
      LEFT JOIN mitra m ON m.id = spk.mitra_id
      LEFT JOIN layanan l ON l.id = spk.layanan_id
      LEFT JOIN users u ON u.id = spk.teknisi_id
      ${whereClause}
    `,
    listQuery: `
      SELECT spk.*, 
             COALESCE(p.nama, m.nama_showroom) AS pelanggan,
             p.kategori AS kategori,
             l.nama AS layanan_nama,
             u.nama AS teknisi_nama
      FROM spk
      LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
      LEFT JOIN mitra m ON m.id = spk.mitra_id
      LEFT JOIN layanan l ON l.id = spk.layanan_id
      LEFT JOIN users u ON u.id = spk.teknisi_id
      ${whereClause}
      ORDER BY spk.id DESC
    `,
    values
  };
}

router.get('/', auth(['admin']), async (req, res) => {
  const whereClauses = [];
  const values = [];

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 0);

  if (req.query.status) {
    whereClauses.push('spk.status = ?');
    values.push(req.query.status);
  }

  if (req.query.pelanggan_id) {
    whereClauses.push('spk.pelanggan_id = ?');
    values.push(Number(req.query.pelanggan_id));
  }

  if (req.query.mitra_id) {
    whereClauses.push('spk.mitra_id = ?');
    values.push(Number(req.query.mitra_id));
  }

  if (req.query.teknisi_id) {
    whereClauses.push('spk.teknisi_id = ?');
    values.push(Number(req.query.teknisi_id));
  }

  if (req.query.search) {
    whereClauses.push('(spk.no_spk LIKE ? OR spk.plat_nomor LIKE ? OR COALESCE(p.nama, m.nama_showroom) LIKE ?)');
    const term = `%${req.query.search}%`;
    values.push(term, term, term);
  }

  const { countQuery, listQuery, values: queryValues } = buildSpkQuery(whereClauses, values);

  const total = (await db.get(countQuery, queryValues))?.total || 0;

  if (limit > 0) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const offset = (safePage - 1) * safeLimit;

    const rows = await db.all(`${listQuery} LIMIT ? OFFSET ?`, [...queryValues, safeLimit, offset]);

    res.json({
      items: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      }
    });
    return;
  }

  const rows = await db.all(listQuery, queryValues);
  res.json(rows);
});

router.get('/:id/pdf', auth(['admin', 'teknisi', 'pelanggan', 'mitra']), loadSpk, authorizeSpk, async (req, res) => {
  const spk = req.spk;

  spk.checklist = await db.all('SELECT * FROM spk_checklist WHERE spk_id=? ORDER BY urutan', [spk.id]);
  spk.foto = await db.all('SELECT * FROM spk_foto WHERE spk_id=? ORDER BY id', [spk.id]);
  spk.laporan = await db.get(`
    SELECT r.*, u.nama AS teknisi_nama
    FROM spk_laporan r
    LEFT JOIN users u ON u.id=r.teknisi_id
    WHERE r.spk_id=?
  `, [spk.id]);

  try {
    const pdf = Buffer.from(await generateSPKPdf(spk));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Content-Disposition', `attachment; filename="SPK-${spk.no_spk}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('PDF generation failed:', error);
    res.status(500).json({ error: 'Gagal membuat PDF SPK' });
  }
});

router.get('/:id', auth(['admin', 'teknisi', 'pelanggan', 'mitra']), loadSpk, authorizeSpk, async (req, res) => {
  const spk = req.spk;

  spk.checklist = await db.all('SELECT * FROM spk_checklist WHERE spk_id=? ORDER BY urutan', [spk.id]);
  spk.foto = await db.all('SELECT * FROM spk_foto WHERE spk_id=? ORDER BY id', [spk.id]);
  spk.laporan = await db.get(`
    SELECT r.*, u.nama AS teknisi_nama
    FROM spk_laporan r
    LEFT JOIN users u ON u.id=r.teknisi_id
    WHERE r.spk_id=?
  `, [spk.id]);

  res.json(spk);
});

router.post('/', auth(['admin']), async (req, res, next) => {
  const { plat_nomor, merk_tipe, tahun, warna, layanan_id, teknisi_id, catatan,
    pelanggan_nama, pelanggan_telepon, pelanggan_email } = req.body;

  if (!plat_nomor || !layanan_id) {
    return res.status(400).json({ error: 'Plat & layanan wajib' });
  }

  try {
    const validated = await validatePayload(req);
    const layanan = await db.get('SELECT * FROM layanan WHERE id=? AND aktif=1', [Number(layanan_id)]);

    if (!layanan) {
      return res.status(400).json({ error: 'Layanan tidak ditemukan' });
    }

    const harga = Number(layanan.harga || 0);
    const safeDiskon = validated.diskon;   // <-- gunakan nama berbeda

    if (safeDiskon > harga) {
      return res.status(400).json({ error: 'diskon tidak boleh melebihi harga layanan' });
    }

    const total = Math.max(0, harga - safeDiskon);

    const id = await db.transaction(async (connection) => {
      let pelangganId = validated.pelanggan_id;

      if (!pelangganId && pelanggan_nama && pelanggan_telepon) {
        const existingPelanggan = await db.get(
          'SELECT id FROM pelanggan WHERE telepon=? ORDER BY id DESC LIMIT 1',
          [pelanggan_telepon], connection
        );
        if (existingPelanggan) {
          pelangganId = existingPelanggan.id;
        } else {
          const pelangganResult = await db.run(`
            INSERT INTO pelanggan (nama, telepon, email, kategori)
            VALUES (?, ?, ?, 'Normal')
          `, [pelanggan_nama, pelanggan_telepon, pelanggan_email || null], connection);
          pelangganId = Number(pelangganResult.insertId);
        }
      }

      let createdId = null;
      let attempts = 0;

      while (attempts < 5) {
        try {
          const no_spk = await generateNoSPK(db, connection);
          const result = await db.run(`
            INSERT INTO spk (no_spk, pelanggan_id, mitra_id, plat_nomor, merk_tipe, tahun, warna,
                             layanan_id, harga, diskon, total, teknisi_id, catatan, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'Menunggu')
          `, [
            no_spk, pelangganId, validated.mitra_id, plat_nomor,
            merk_tipe || null, tahun || null, warna || null,
            Number(layanan_id), harga, safeDiskon, total,
            validated.teknisi_id, catatan || null
          ], connection);

          createdId = Number(result.insertId);

          for (const [index, item] of defaultChecklist().entries()) {
            await db.run(
              'INSERT INTO spk_checklist (spk_id, item, urutan) VALUES (?,?,?)',
              [createdId, item, index], connection
            );
          }

          await writeAudit('spk', createdId, 'create', req.user, {
            no_spk, pelanggan_id: pelangganId, mitra_id: validated.mitra_id,
            teknisi_id: validated.teknisi_id, total
          }, connection);

          return createdId;
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') { attempts += 1; continue; }
          throw error;
        }
      }
      throw new Error('Gagal membuat nomor SPK unik');
    });

    const createdSpk = await db.get(`
      SELECT spk.*, 
             COALESCE(p.nama, m.nama_showroom) AS pelanggan,
             p.kategori, p.telepon AS pelanggan_telepon, p.email AS pelanggan_email,
             l.nama AS layanan_nama, l.durasi_menit,
             u.nama AS teknisi_nama
      FROM spk
      LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
      LEFT JOIN mitra m ON m.id = spk.mitra_id
      LEFT JOIN layanan l ON l.id = spk.layanan_id
      LEFT JOIN users u ON u.id = spk.teknisi_id
      WHERE spk.id = ?
    `, [id]);

    res.status(201).json(createdSpk);
  } catch (error) {
    if (error.code && error.code !== 'ER_DUP_ENTRY') return next(error);
    res.status(400).json({ error: error.message || 'Validasi gagal' });
  }
});

router.patch('/:id/status', auth(['admin', 'teknisi']), loadSpk, authorizeSpk, async (req, res) => {
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status tidak valid' });
  }

  const current = req.spk;
  const allowedTransitions = {
    Menunggu: ['Menunggu', 'Dikerjakan', 'Batal'],
    Dikerjakan: ['Dikerjakan', 'Selesai', 'Batal'],
    Selesai: ['Selesai'],
    Batal: ['Batal']
  };

  if (current.status !== status && !allowedTransitions[current.status]?.includes(status)) {
    return res.status(400).json({ error: 'Transisi status tidak valid' });
  }

  if (status === current.status) {
    return res.json(current);
  }

  const updated = await db.transaction(async (connection) => {
    const now = toLocalDateTimeString();
    const updates = ['status = ?'];
    const values = [status];

    if (status === 'Dikerjakan' && !current.waktu_mulai) {
      updates.push('waktu_mulai = ?');
      values.push(now);
    }

    if (status === 'Selesai' && !current.waktu_selesai) {
      updates.push('waktu_selesai = ?');
      values.push(now);
    }

    values.push(String(req.params.id));

    const result = await db.run(`UPDATE spk SET ${updates.join(', ')} WHERE id = ? AND status = ?`, [...values, current.status], connection);

    if (!result.affectedRows) {
      return db.get(`
        SELECT spk.*, COALESCE(p.nama, m.nama_showroom) AS pelanggan,
               p.kategori, p.telepon AS pelanggan_telepon, p.email AS pelanggan_email,
               l.nama AS layanan_nama, l.durasi_menit, u.nama AS teknisi_nama
        FROM spk
        LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
        LEFT JOIN mitra m ON m.id = spk.mitra_id
        LEFT JOIN layanan l ON l.id = spk.layanan_id
        LEFT JOIN users u ON u.id = spk.teknisi_id
        WHERE spk.id = ?
      `, [req.params.id], connection);
    }

    await writeAudit('spk', current.id, 'status_change', req.user, {
      from: current.status,
      to: status,
      no_spk: current.no_spk
    }, connection);

    return db.get(`
      SELECT spk.*, 
             COALESCE(p.nama, m.nama_showroom) AS pelanggan,
             p.kategori, p.telepon AS pelanggan_telepon, p.email AS pelanggan_email,
             l.nama AS layanan_nama, l.durasi_menit,
             u.nama AS teknisi_nama
      FROM spk
      LEFT JOIN pelanggan p ON p.id = spk.pelanggan_id
      LEFT JOIN mitra m ON m.id = spk.mitra_id
      LEFT JOIN layanan l ON l.id = spk.layanan_id
      LEFT JOIN users u ON u.id = spk.teknisi_id
      WHERE spk.id = ?
    `, [req.params.id], connection);
  });

  res.json(updated);
});

router.put('/:id/laporan', auth(['teknisi']), loadSpk, authorizeSpk, async (req, res) => {
  if (req.spk.status !== 'Dikerjakan') {
    return res.status(409).json({ error: 'Laporan hanya dapat dikirim saat SPK sedang dikerjakan' });
  }

  const laporan = String(req.body.laporan || '').trim();
  if (laporan.length < 10 || laporan.length > 5000) {
    return res.status(400).json({ error: 'Laporan wajib diisi antara 10 sampai 5000 karakter' });
  }

  await db.transaction(async (connection) => {
    await db.run(`
      INSERT INTO spk_laporan (spk_id, teknisi_id, laporan)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE teknisi_id=VALUES(teknisi_id), laporan=VALUES(laporan), updated_at=CURRENT_TIMESTAMP
    `, [req.spk.id, req.user.id, laporan], connection);
    await writeAudit('spk', req.spk.id, 'technician_report', req.user, { no_spk: req.spk.no_spk }, connection);
  });

  res.json(await db.get(`
    SELECT r.*, u.nama AS teknisi_nama
    FROM spk_laporan r
    LEFT JOIN users u ON u.id=r.teknisi_id
    WHERE r.spk_id=?
  `, [req.spk.id]));
});

router.patch('/:id/teknisi', auth(['admin']), loadSpk, async (req, res) => {
  const teknisiId = Number(req.body.teknisi_id);
  if (!Number.isInteger(teknisiId) || teknisiId < 1) {
    return res.status(400).json({ error: 'teknisi_id tidak valid' });
  }

  const teknisi = await db.get("SELECT id FROM users WHERE id=? AND role='teknisi' AND aktif=1", [teknisiId]);
  if (!teknisi) return res.status(400).json({ error: 'Teknisi tidak ditemukan atau tidak aktif' });

  const current = req.spk;
  const updated = await db.transaction(async (connection) => {
    const result = await db.run('UPDATE spk SET teknisi_id=? WHERE id=? AND teknisi_id <=> ?', [teknisiId, current.id, current.teknisi_id], connection);
    if (!result.affectedRows) return db.get('SELECT * FROM spk WHERE id=?', [current.id], connection);
    await writeAudit('spk', current.id, 'teknisi_reassign', req.user, {
      from_teknisi_id: current.teknisi_id,
      to_teknisi_id: teknisiId,
      no_spk: current.no_spk
    }, connection);
    return db.get('SELECT * FROM spk WHERE id=?', [current.id], connection);
  });

  res.json(updated);
});

router.patch('/:id/checklist/:itemId', auth(['teknisi', 'admin']), loadSpk, authorizeSpk, async (req, res) => {
  const { selesai } = req.body;

  if (typeof selesai !== 'boolean') {
    return res.status(400).json({ error: 'Field selesai harus boolean' });
  }

  const item = await db.get('SELECT id FROM spk_checklist WHERE id=? AND spk_id=?', [req.params.itemId, req.params.id]);
  if (!item) {
    return res.status(404).json({ error: 'Checklist item tidak ditemukan' });
  }

  await db.run('UPDATE spk_checklist SET selesai=? WHERE id=? AND spk_id=?', [selesai ? 1 : 0, req.params.itemId, req.params.id]);

  await writeAudit('spk_checklist', Number(req.params.itemId), 'checklist_update', req.user, {
    spk_id: Number(req.params.id),
    selesai
  });

  res.json(await db.get('SELECT * FROM spk_checklist WHERE id=?', [req.params.itemId]));
});


router.post('/:id/foto', auth(['teknisi', 'admin']), loadSpk, authorizeSpk, upload.single('foto'), async (req, res) => {
  const { tipe } = req.body;

  if (!VALID_PHOTO_TYPES.includes(tipe)) {
    return res.status(400).json({ error: 'Tipe foto harus sebelum atau sesudah' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'File foto wajib' });
  }

  if (!upload.hasValidImageSignature(req.file.path, req.file.mimetype)) {
    require('fs').unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Isi file foto tidak valid' });
  }

  const r = await db.run('INSERT INTO spk_foto (spk_id, tipe, path) VALUES (?,?,?)', [req.params.id, tipe, `/uploads/${req.file.filename}`]);

  await writeAudit('spk_foto', Number(r.insertId), 'upload_foto', req.user, {
    spk_id: Number(req.params.id),
    tipe,
    path: `/uploads/${req.file.filename}`
  });

  res.status(201).json(await db.get('SELECT * FROM spk_foto WHERE id=?', [r.insertId]));
});

module.exports = router;
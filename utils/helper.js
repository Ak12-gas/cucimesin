'use strict';

const { toAppDate, toAppDateTime, addAppDays } = require('./timezone');

// Nama lama dipertahankan untuk kompatibilitas, tetapi sekarang selalu WIB
// dan tidak bergantung pada timezone proses (Node di lokal vs Vercel).
function toLocalDateString(date = new Date()) {
  return toAppDate(date);
}

function toLocalDateTimeString(date = new Date()) {
  return toAppDateTime(date);
}

function localizedDateDaysAgo(days) {
  return toAppDate(addAppDays(new Date(), -days));
}

// Hash deterministik untuk kunci advisory lock Postgres (int32).
function lockKey(scope) {
  let hash = 0;
  for (let index = 0; index < scope.length; index += 1) {
    hash = (hash * 31 + scope.charCodeAt(index)) | 0;
  }
  return hash;
}

async function withNumberLock(db, connection, scope, callback) {
  const key = lockKey(scope);
  if (connection) {
    // Transaksi sudah terbuka: lock dilepas otomatis saat COMMIT/ROLLBACK.
    await db.get('SELECT pg_advisory_xact_lock(?)', [key], connection);
    return callback();
  }
  await db.get('SELECT pg_advisory_lock(?)', [key]);
  try {
    return await callback();
  } finally {
    await db.get('SELECT pg_advisory_unlock(?)', [key]);
  }
}

// "Baca terakhir + 1" tetap dipakai agar numbering existing tidak berubah,
// tetapi kini diserialisasi oleh advisory lock per prefix.
async function nextNumber(db, connection, table, column, prefix) {
  return withNumberLock(db, connection, `${table}:${prefix}`, async () => {
    const row = await db.get(
      `SELECT ${column} FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`,
      [prefix + '%'], connection
    );
    const last = row ? parseInt(String(row[column]).split('-').pop(), 10) : 0;
    const next = Number.isFinite(last) && last > 0 ? last + 1 : 1;
    return prefix + String(next).padStart(3, '0');
  });
}

async function generateNoSPK(db, connection) {
  const date = toAppDate();
  const prefix = `SPK-${date.slice(0, 4)}${date.slice(5, 7)}-`;
  return nextNumber(db, connection, 'spk', 'no_spk', prefix);
}

async function generateNoInvoice(db, mitraId, connection) {
  const date = toAppDate();
  const prefix = `INV-${mitraId}-${date.slice(0, 4)}${date.slice(5, 7)}-`;
  return nextNumber(db, connection, 'invoice_mitra', 'no_invoice', prefix);
}

function defaultChecklist() {
  return [
    'Masking ECU & Kabel Elektrikal',
    'Check Kondisi Aki & Alternator',
    'Penyemprotan Chemical Khusus',
    'Bilas & Pengeringan Detail'
  ];
}

module.exports = {
  toLocalDateString,
  toLocalDateTimeString,
  localizedDateDaysAgo,
  generateNoSPK,
  generateNoInvoice,
  defaultChecklist
};

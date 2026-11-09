require('dotenv').config();
const mysql = require('mysql2/promise');
const db = require('./database');

const TABLES = [
  'mitra',
  'users',
  'layanan',
  'pelanggan',
  'spk',
  'spk_checklist',
  'spk_foto',
  'spk_laporan',
  'transaksi',
  'pembayaran',
  'invoice_mitra',
  'invoice_mitra_spk',
  'booking',
  'booking_schedule_lock',
  'pengaturan',
  'audit_log',
  'armada',
  'booking_armada',
  'booking_armada_unit'
];

const OPTIONAL_SOURCE_TABLES = new Set(['booking_schedule_lock']);

const ID_TABLES = TABLES.filter((table) => ![
  'invoice_mitra_spk',
  'booking_schedule_lock',
  'pengaturan',
  'booking_armada_unit'
].includes(table));

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function createSourceConnection() {
  const host = process.env.SOURCE_DB_HOST || process.env.DB_HOST;
  const database = process.env.SOURCE_DB_NAME || process.env.DB_NAME;
  const user = process.env.SOURCE_DB_USER || process.env.DB_USER;
  const password = process.env.SOURCE_DB_PASSWORD !== undefined
    ? process.env.SOURCE_DB_PASSWORD
    : (process.env.DB_PASSWORD || '');
  if (!host || !database || !user) {
    throw new Error('SOURCE_DB_HOST, SOURCE_DB_NAME, dan SOURCE_DB_USER (atau DB_* lama) wajib diatur.');
  }
  return mysql.createConnection({
    host,
    port: Number(process.env.SOURCE_DB_PORT || process.env.DB_PORT || 3306),
    database,
    user,
    password,
    dateStrings: true,
    connectTimeout: 10000
  });
}

async function ensureTargetIsEmpty() {
  for (const table of TABLES) {
    const result = await db.get(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
    if (Number(result.count) !== 0) {
      throw new Error(`Tabel Supabase "${table}" sudah berisi data. Migrasi dibatalkan agar data tidak tertimpa.`);
    }
  }
}

async function getSourceTables(source) {
  const [rows] = await source.query(`
    SELECT TABLE_NAME AS table_name
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
  `);
  const available = new Set(rows.map((row) => row.table_name));
  const missingRequired = TABLES.filter((table) => !available.has(table) && !OPTIONAL_SOURCE_TABLES.has(table));
  if (missingRequired.length) {
    throw new Error(`Tabel wajib tidak ditemukan di MySQL sumber: ${missingRequired.join(', ')}`);
  }
  return available;
}

async function copyTable(source, table, client) {
  const quoted = quoteIdentifier(table);
  const [countRows] = await source.query(`SELECT COUNT(*) AS total FROM \`${table}\``);
  const total = Number(countRows[0].total);
  if (!total) return 0;

  const pageSize = 250;
  for (let offset = 0; offset < total; offset += pageSize) {
    const [rows] = await source.query(`SELECT * FROM \`${table}\` LIMIT ? OFFSET ?`, [pageSize, offset]);
    if (!rows.length) break;

    const columns = Object.keys(rows[0]);
    const columnSql = columns.map(quoteIdentifier).join(', ');
    const valuesSql = rows.map((_, rowIndex) => {
      const placeholders = columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`);
      return `(${placeholders.join(', ')})`;
    }).join(', ');
    const values = rows.flatMap((row) => columns.map((column) => row[column]));
    await client.query(`INSERT INTO ${quoted} (${columnSql}) VALUES ${valuesSql}`, values);
  }
  return total;
}

async function resetIdentitySequences(client) {
  for (const table of ID_TABLES) {
    const quoted = quoteIdentifier(table);
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${quoted}`,
      [table]
    );
  }
}

async function migrate() {
  let source;
  try {
    source = await createSourceConnection();
    await db.initialize({ migrateLegacyPayments: false });
    await ensureTargetIsEmpty();
    const sourceTables = await getSourceTables(source);
    for (const table of TABLES) {
      if (!sourceTables.has(table)) {
        console.log(`Skipped ${table}: table does not exist in MySQL source`);
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const migrated = [];
      for (const table of TABLES) {
        if (!sourceTables.has(table)) continue;
        const total = await copyTable(source, table, client);
        migrated.push([table, total]);
      }
      await resetIdentitySequences(client);
      await client.query('COMMIT');
      for (const [table, total] of migrated) {
        console.log(`Migrated ${table}: ${total} rows`);
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log('Migrasi data MySQL ke Supabase selesai.');
  } finally {
    if (source) await source.end();
    await db.close();
  }
}

migrate().catch((error) => {
  console.error('[MIGRATION ERROR]', error.message);
  process.exitCode = 1;
});

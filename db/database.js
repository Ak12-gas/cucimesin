require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (value) => value);
types.setTypeParser(1083, (value) => value);
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);
types.setTypeParser(20, (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

function createPool() {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL belum diatur. Isi connection string Supabase di environment.');
  }
  return new Pool({
    connectionString,
    max: Number(process.env.DB_CONNECTION_LIMIT || 5),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
}

let pool;
function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

function toPostgresSql(sql) {
  let output = '';
  let parameterIndex = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (quote === '`') {
        output += character === '`' ? '"' : character;
        if (character === '`') quote = null;
      } else {
        output += character;
        if (character === quote) {
          if (sql[index + 1] === quote) {
            output += sql[index + 1];
            index += 1;
          } else {
            quote = null;
          }
        } else if (character === '\\' && quote === "'" && index + 1 < sql.length) {
          output += sql[index + 1];
          index += 1;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += character === '`' ? '"' : character;
    } else if (character === '?') {
      parameterIndex += 1;
      output += `$${parameterIndex}`;
    } else {
      output += character;
    }
  }
  return output;
}

function normalizeError(error) {
  if (error.code === '23505') error.code = 'ER_DUP_ENTRY';
  return error;
}

async function query(sql, params = [], connection = getPool()) {
  try {
    const result = await connection.query(toPostgresSql(sql), params);
    return result.rows;
  } catch (error) {
    throw normalizeError(error);
  }
}

async function get(sql, params = [], connection = getPool()) {
  const rows = await query(sql, params, connection);
  return rows[0];
}

async function all(sql, params = [], connection = getPool()) {
  return query(sql, params, connection);
}

async function run(sql, params = [], connection = getPool()) {
  let postgresSql = toPostgresSql(sql);
  if (/^\s*INSERT\s+INTO\s+(mitra|users|pelanggan|layanan|spk|spk_checklist|spk_foto|spk_laporan|transaksi|pembayaran|invoice_mitra|booking|audit_log|armada|booking_armada)\b/i.test(postgresSql) &&
      !/\bRETURNING\b/i.test(postgresSql)) {
    postgresSql = `${postgresSql.trim().replace(/;$/, '')} RETURNING id`;
  }
  try {
    const result = await connection.query(postgresSql, params);
    return {
      insertId: result.rows[0] && result.rows[0].id,
      affectedRows: result.rowCount,
      rowCount: result.rowCount
    };
  } catch (error) {
    throw normalizeError(error);
  }
}

async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw normalizeError(error);
  } finally {
    client.release();
  }
}

async function initialize(options = {}) {
  const schema = await fs.readFile(path.join(__dirname, 'schema-supabase.sql'), 'utf8');
  for (const statement of schema.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    await getPool().query(statement);
  }

  if (options.migrateLegacyPayments !== false) {
    await getPool().query(`
      INSERT INTO pembayaran (spk_id, nominal, metode, status, submitted_at, confirmed_at, catatan_admin)
      SELECT s.id, COALESCE(s.total, MIN(t.nominal)), 'Pembayaran lama', 'Dikonfirmasi',
             MIN(t.created_at), MIN(t.created_at),
             'Transaksi SPK tercatat sebelum fitur pembayaran online.'
      FROM transaksi t
      INNER JOIN spk s ON s.id = t.spk_id
      WHERE t.tipe = 'masuk' AND t.kategori = 'SPK' AND t.spk_id IS NOT NULL AND t.mitra_id IS NULL
      GROUP BY s.id, s.total
      ON CONFLICT (spk_id) DO NOTHING
    `);
  }
}

async function close() {
  if (pool) {
    const activePool = pool;
    pool = null;
    await activePool.end();
  }
}

function connect() {
  return getPool().connect();
}

module.exports = { query, get, all, run, transaction, initialize, close, connect, toPostgresSql };

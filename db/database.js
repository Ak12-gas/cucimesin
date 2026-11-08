const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'cucimesin',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  dateStrings: true
});

async function query(sql, params = [], connection = pool) {
  const [rows] = await connection.query(sql, params);
  return rows;
}

async function get(sql, params = [], connection = pool) {
  const rows = await query(sql, params, connection);
  return rows[0];
}

async function all(sql, params = [], connection = pool) {
  return query(sql, params, connection);
}

async function run(sql, params = [], connection = pool) {
  const [result] = await connection.query(sql, params);
  return result;
}

async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function initialize() {
  const schema = await fs.readFile(path.join(__dirname, 'schema-mysql.sql'), 'utf8');
  for (const statement of schema.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }

  const [bookingUserColumn] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking' AND COLUMN_NAME = 'user_id'
  `);
  if (!Number(bookingUserColumn[0].count)) {
    await pool.query('ALTER TABLE booking ADD COLUMN user_id INT UNSIGNED NULL AFTER id');
  }

  const [bookingUserIndex] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking' AND INDEX_NAME = 'idx_booking_user'
  `);
  if (!Number(bookingUserIndex[0].count)) {
    await pool.query('ALTER TABLE booking ADD INDEX idx_booking_user (user_id)');
  }

  const [bookingScheduleIndex] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking' AND INDEX_NAME = 'idx_booking_schedule'
  `);
  if (!Number(bookingScheduleIndex[0].count)) {
    await pool.query('ALTER TABLE booking ADD INDEX idx_booking_schedule (tanggal, waktu, status)');
  }

  const [bookingUserForeignKey] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking'
      AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME = 'users'
  `);
  if (!Number(bookingUserForeignKey[0].count)) {
    await pool.query(`
      ALTER TABLE booking
      ADD CONSTRAINT fk_booking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    `);
  }

  await pool.query(`
    INSERT IGNORE INTO pembayaran (spk_id, nominal, metode, status, submitted_at, confirmed_at, catatan_admin)
    SELECT s.id, COALESCE(s.total, MIN(t.nominal)), 'Pembayaran lama', 'Dikonfirmasi',
           MIN(t.created_at), MIN(t.created_at),
           'Transaksi SPK tercatat sebelum fitur pembayaran online.'
    FROM transaksi t
    INNER JOIN spk s ON s.id = t.spk_id
    WHERE t.tipe = 'masuk' AND t.kategori = 'SPK' AND t.spk_id IS NOT NULL AND t.mitra_id IS NULL
    GROUP BY s.id, s.total
  `);
}

async function close() {
  await pool.end();
}

module.exports = { query, get, all, run, transaction, initialize, close };

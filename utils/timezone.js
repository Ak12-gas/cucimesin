'use strict';

// Satu standar waktu untuk seluruh aplikasi: Asia/Jakarta (WIB, UTC+7).
// Semua timestamp yang disimpan ke DB adalah wall-clock WIB (tanpa offset),
// sehingga CURRENT_DATE/CURRENT_TIMESTAMP di Postgres juga menghasilkan WIB
// lewat opsi startup `-c timezone=...` di db/database.js.
const DEFAULT_TIME_ZONE = 'Asia/Jakarta';
const configured = String(process.env.APP_TIME_ZONE || DEFAULT_TIME_ZONE).trim();
const APP_TIME_ZONE = /^[A-Za-z_]+\/[A-Za-z_]+$|^UTC$/.test(configured) ? configured : DEFAULT_TIME_ZONE;

// Asia/Jakarta tidak punya DST, jadi offsetnya tetap +07:00.
const APP_OFFSET_SUFFIX = APP_TIME_ZONE === 'Asia/Jakarta' ? '+07:00' : 'Z';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

function toDate(value) {
  if (value instanceof Date) return value;
  if (value === undefined || value === null || value === '') return new Date();
  return new Date(value);
}

function parts(value = new Date()) {
  const date = toDate(value);
  const result = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  return result;
}

function toAppDate(value = new Date()) {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day}`;
}

function toAppDateTime(value = new Date()) {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Artikan timestamp "polos" dari DB sebagai wall-clock WIB, bukan timezone proses.
function parseAppDateTime(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(' ', 'T');
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);
  const date = new Date(hasOffset ? normalized : `${normalized}${APP_OFFSET_SUFFIX}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWibLong(value) {
  const date = parseAppDateTime(value);
  if (!date) return '-';
  const p = parts(date);
  const month = Number(p.month) - 1;
  return `${Number(p.day)} ${BULAN[month] || p.month} ${p.year}, ${p.hour}:${p.minute} WIB`;
}

// Dipakai untuk iterasi tanggal: hasilnya tetap dihitung dari tanggal WIB.
function addAppDays(value = new Date(), days = 0) {
  const [year, month, day] = toAppDate(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12));
}

function isValidAppDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

module.exports = {
  APP_TIME_ZONE,
  toAppDate,
  toAppDateTime,
  parseAppDateTime,
  formatWibLong,
  addAppDays,
  isValidAppDate
};

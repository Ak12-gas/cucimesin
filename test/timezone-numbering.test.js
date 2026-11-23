const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const timezone = require('../utils/timezone');
const { generateNoSPK, generateNoInvoice } = require('../utils/helper');

test('tanggal WIB tetap sama walaupun timezone proses berbeda', () => {
  const script = `
    const { toAppDate, toAppDateTime } = require('./utils/timezone');
    process.stdout.write(JSON.stringify({
      date: toAppDate(new Date('2026-11-23T18:30:00Z')),
      dateTime: toAppDateTime(new Date('2026-11-23T18:30:00Z'))
    }));
  `;
  const run = (TZ) => JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ },
    encoding: 'utf8'
  }));

  const utc = run('UTC');
  const newYork = run('America/New_York');
  const jakarta = run('Asia/Jakarta');

  assert.deepEqual(utc, newYork);
  assert.deepEqual(utc, jakarta);
  // 18:30 UTC = 01:30 WIB keesokan harinya.
  assert.equal(utc.date, '2026-11-24');
  assert.equal(utc.dateTime, '2026-11-24 01:30:00');
});

test('timestamp polos DB dibaca sebagai WIB, bukan timezone proses', () => {
  const parsed = timezone.parseAppDateTime('2026-11-23 00:30:00');
  assert.equal(parsed.toISOString(), '2026-11-22T17:30:00.000Z');
  assert.equal(timezone.formatWibLong('2026-11-23 00:30:00'), '23 November 2026, 00:30 WIB');
  assert.equal(timezone.formatWibLong(''), '-');
});

test('iterasi tanggal lintas bulan memakai WIB', () => {
  const start = timezone.parseAppDateTime('2026-11-30 12:00:00');
  assert.equal(timezone.toAppDate(timezone.addAppDays(start, 1)), '2026-12-01');
  assert.equal(timezone.toAppDate(timezone.addAppDays(start, -30)), '2026-10-31');
  assert.equal(timezone.isValidAppDate('2026-02-30'), false);
  assert.equal(timezone.isValidAppDate('2024-02-29'), true);
});

test('generator nomor memakai prefix WIB dan advisory lock per scope', async () => {
  const calls = [];
  const connection = { id: 'tx' };
  const db = {
    async get(sql, params, tx) {
      calls.push({ sql: sql.trim(), params, tx });
      if (sql.includes('pg_advisory')) return null;
      if (sql.includes('no_spk')) return { no_spk: 'SPK-202611-007' };
      if (sql.includes('no_invoice')) return { no_invoice: 'INV-3-202611-002' };
      return null;
    }
  };

  const month = timezone.toAppDate().slice(0, 7).replace('-', '');

  assert.equal(await generateNoSPK(db, connection), `SPK-${month}-008`);
  assert.equal(await generateNoInvoice(db, 3, connection), `INV-3-${month}-003`);

  assert.equal(calls[0].sql, 'SELECT pg_advisory_xact_lock(?)');
  assert.equal(calls[0].tx, connection);
  assert.equal(calls[1].params[0], `SPK-${month}-%`);
  assert.equal(calls[2].sql, 'SELECT pg_advisory_xact_lock(?)');
  assert.notEqual(calls[2].params[0], calls[0].params[0]);
});

test('generator nomor tanpa transaksi memakai session lock dan melepaskannya', async () => {
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push(sql.trim());
      if (sql.includes('pg_advisory')) return null;
      return null;
    }
  };

  assert.match(await generateNoSPK(db), /^SPK-\d{6}-001$/);
  assert.ok(calls.includes('SELECT pg_advisory_lock(?)'));
  assert.ok(calls.includes('SELECT pg_advisory_unlock(?)'));
});

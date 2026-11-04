// diagnose.js — jalankan dengan: node diagnose.js
// Script ini mencoba require() satu per satu untuk menemukan module mana
// yang sebenarnya menyebabkan ERR_REQUIRE_ASYNC_MODULE.

const steps = [
  ['express', () => require('express')],
  ['dotenv', () => require('dotenv')],
  ['../db/database (dari routes/)', () => require('./db/database')],
  ['../middleware/auth (dari routes/)', () => require('./middleware/auth')],
  ['mysql2/promise (dipakai db/database.js)', () => require('mysql2/promise')],
  ['bcryptjs', () => require('bcryptjs')],
  ['jsonwebtoken', () => require('jsonwebtoken')],
  ['./routes/pengaturan.js (utuh)', () => require('./routes/pengaturan')],
];

console.log('=== Mulai diagnosis ERR_REQUIRE_ASYNC_MODULE ===\n');

for (const [name, fn] of steps) {
  process.stdout.write(`Mencoba require: ${name} ... `);
  try {
    fn();
    console.log('OK');
  } catch (e) {
    console.log('GAGAL ❌');
    console.log('  -> Pesan error:', e.message);
    console.log('  -> Code:', e.code);
    if (e.code === 'ERR_REQUIRE_ASYNC_MODULE') {
      console.log('\n🎯 KETEMU! Module penyebabnya adalah: ' + name);
      console.log('   Ini yang perlu diperbaiki/di-downgrade/diganti importnya.');
    }
    break;
  }
}

console.log('\n=== Diagnosis selesai ===');

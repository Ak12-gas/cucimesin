const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pelanggan-portal.html'), 'utf8');

function extractFunctionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `fungsi ${name} tidak ditemukan`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(braceStart + 1, index);
  }
  throw new Error(`fungsi ${name} tidak memiliki penutup`);
}

const rowBody = extractFunctionBody('renderHistoryRow');
const downloadBody = extractFunctionBody('downloadSpkPdf');
const clickBody = extractFunctionBody('handleSpkDownloadClick');

const domStart = source.indexOf("window.addEventListener('DOMContentLoaded'");
assert.notEqual(domStart, -1, 'blok DOMContentLoaded tidak ditemukan');
const domBody = source.slice(domStart, source.indexOf('restoreSession();', domStart));

// Nilai no_spk yang bermusuhan: kutip, sudut, backtick, dan potongan kode JS.
// Kontraknya: hanya pernah menjadi data atribut/DOM, tidak pernah source handler.
const hostileNoSpk = [
  `');alert(1);//`,
  `" onmouseover="alert(1)`,
  `<img src=x onerror=alert(1)>`,
  '<script>alert("xss")</script>',
  'a`b${alert(1)}c',
  `SPK-1\\'); fetch('/api/spk/1/pdf');//`
];

test('portal pelanggan: nilai API tidak masuk ke inline event handler', () => {
  assert.doesNotMatch(rowBody, /onclick\s*=/);
  assert.doesNotMatch(rowBody, /downloadSpkPdf\s*\(/);
  assert.doesNotMatch(rowBody, /onclick[^"'\n]*\$\{/);
  assert.doesNotMatch(source, /onclick="downloadSpkPdf/);
  for (const field of ['row.id', 'row.no_spk']) {
    assert.doesNotMatch(rowBody, new RegExp(`onclick[^\\n]*\\$\\{[^}]*${field.replace('.', '\\.')}`));
  }
  for (const value of hostileNoSpk) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }
});

test('portal pelanggan: tombol unduh memakai atribut data-* yang di-escape', () => {
  assert.match(rowBody, /data-spk-download(?:\s|>)/);
  assert.match(rowBody, /data-spk-id="\$\{escapeHtml\(String\(row\.id\)\)\}"/);
  assert.match(rowBody, /data-spk-number="\$\{escapeHtml\(String\(row\.no_spk \|\| ''\)\)\}"/);
  assert.doesNotMatch(rowBody, /onclick="downloadSpkPdf/);
});

test('portal pelanggan: handler delegasi memvalidasi id dan meneruskan no_spk sebagai data', () => {
  assert.match(clickBody, /closest\?\.\('button\[data-spk-download\]'\)/);
  assert.match(clickBody, /Number\(button\.dataset\.spkId\)/);
  assert.match(clickBody, /Number\.isInteger\(id\)/);
  assert.match(clickBody, /id < 1/);
  assert.match(clickBody, /downloadSpkPdf\(id, button\.dataset\.spkNumber\)/);
  assert.doesNotMatch(clickBody, /eval\(|new Function|onclick\s*=|innerHTML/);
  assert.match(domBody, /\['homeHistoryList', 'riwayatHistoryList'\]\.forEach\(/);
  assert.match(domBody, /addEventListener\('click', handleSpkDownloadClick\)/);
});

test('portal pelanggan: alur unduh PDF tetap utuh dengan id tervalidasi', () => {
  assert.match(downloadBody, /const id = Number\(spkId\)/);
  assert.match(downloadBody, /Number\.isInteger\(id\)/);
  assert.match(downloadBody, /id < 1/);
  assert.match(downloadBody, /localStorage\.getItem\(TOKEN_KEY\)/);
  assert.match(downloadBody, /\/api\/spk\/\$\{id\}\/pdf/);
  assert.match(downloadBody, /Authorization/);
  assert.match(downloadBody, /signature !== '%PDF-'/);
  assert.match(downloadBody, /URL\.createObjectURL\(blob\)/);
  assert.match(downloadBody, /URL\.revokeObjectURL\(url\)/);
  assert.match(downloadBody, /a\.download =/);
  assert.match(downloadBody, /SPK-\$\{id\}/);
});

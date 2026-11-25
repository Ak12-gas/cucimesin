const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');

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

const renderBody = extractFunctionBody('renderTeknisiCards');
const editBody = extractFunctionBody('editTeknisi');

const listenerMarker = "document.getElementById('teknisiCardsContainer')?.addEventListener('click'";
const markerIndex = source.indexOf(listenerMarker);
assert.notEqual(markerIndex, -1, 'listener delegasi teknisi tidak ditemukan');
const listenerBody = source.slice(markerIndex, source.indexOf('  restoreAdminSession();', markerIndex));

test('admin teknisi: tidak ada nilai API yang diinterpolasi ke inline event handler', () => {
  assert.doesNotMatch(renderBody, /onclick\s*=\s*["'][^"']*\$\{/);
  assert.doesNotMatch(renderBody, /onclick="editTeknisi\(/);
  assert.doesNotMatch(renderBody, /onclick="hapusTeknisi\(/);
  assert.doesNotMatch(renderBody, /onclick[^"'\n]*\$\{[^}]*(row\.id|row\.nama|row\.email|row\.telepon|row\.aktif|initials)/);

  // Payload contoh: kutip, sudut, atribut event, dan potongan kode JS.
  // Kontraknya: nilai seperti ini hanya pernah menjadi data, tidak pernah
  // disisipkan sebagai source JS/HTML oleh template render kartu teknisi.
  const hostileValues = [
    `');alert(1);//`,
    `" onmouseover="alert(1)`,
    `<img src=x onerror=alert(1)>`,
    `<script>alert('xss')</script>`,
    'a`b\\c'
  ];
  for (const value of hostileValues) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }

  assert.doesNotMatch(renderBody, /editTeknisi\('\$\{/);
  assert.doesNotMatch(renderBody, /hapusTeknisi\(\$\{Number\(/);
});

test('admin teknisi: tombol memakai atribut data-* dengan id yang di-escape', () => {
  assert.match(renderBody, /data-teknisi-action="edit"\s+data-teknisi-id="\$\{escapeHtml\(String\(row\.id\)\)\}"/);
  assert.match(renderBody, /data-teknisi-action="delete"\s+data-teknisi-id="\$\{escapeHtml\(String\(row\.id\)\)\}"/);
  assert.match(renderBody, /\$\{escapeHtml\(initials\)\}/);
});

test('admin teknisi: handler delegasi memvalidasi id dan mengambil data dari row cache', () => {
  assert.match(listenerBody, /closest\?\.\('button\[data-teknisi-action\]'\)/);
  assert.match(listenerBody, /Number\(button\.dataset\.teknisiId\)/);
  assert.match(listenerBody, /Number\.isInteger\(id\)/);
  assert.match(listenerBody, /teknisiRows\.find\(\(item\) => Number\(item\.id\) === id\)/);
  assert.match(listenerBody, /editTeknisi\(id, row\.nama, row\.email, row\.telepon, row\.aktif\)/);
  assert.match(listenerBody, /hapusTeknisi\(id\)/);
  assert.doesNotMatch(listenerBody, /eval\(|new Function|onclick\s*=|innerHTML/);
});

test('admin teknisi: editTeknisi tetap mengisi form lewat DOM API tanpa interpolasi', () => {
  assert.match(source, /function editTeknisi\(id, nama, email, telepon, aktif\)/);
  for (const field of [
    'formTeknisiId',
    'formTeknisiNama',
    'formTeknisiEmail',
    'formTeknisiTelepon',
    'formTeknisiPassword',
    'formTeknisiStatus'
  ]) {
    assert.match(editBody, new RegExp(`getElementById\\('${field}'\\)\\.value\\s*=`), `${field} harus tetap terisi`);
  }
  assert.equal((editBody.match(/\.value\s*=/g) || []).length, 6);
  assert.doesNotMatch(editBody, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|onclick\s*=/);
  assert.doesNotMatch(editBody, /`|\$\{/);
});

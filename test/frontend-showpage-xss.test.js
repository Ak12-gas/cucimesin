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

const body = extractFunctionBody('showPage');
const callLines = source.split(/\r?\n/).filter((line) =>
  /showPage\('[^']*',\s*(?:this|orderButton),\s*'[^']*',\s*'[^']*'\)/.test(line)
);

// String bermusuhan yang harus tetap menjadi teks, bukan markup/script.
const hostileHtml = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  `'); alert(1);//`,
  'a`b${alert(1)}c'
];

test('showPage: pageTitle dan pageSub memakai textContent, bukan innerHTML', () => {
  assert.match(body, /getElementById\('pageTitle'\)\.textContent = title/);
  assert.match(body, /getElementById\('pageSub'\)\.textContent = sub/);
  assert.doesNotMatch(body, /innerHTML/);
  assert.doesNotMatch(source, /getElementById\('page(?:Title|Sub)'\)\.innerHTML/);
  assert.doesNotMatch(body, /insertAdjacentHTML|outerHTML|document\.write|createContextualFragment|eval\(|new Function/);
  assert.doesNotMatch(body, /\$\{[^}]*\b(?:title|sub)\b/);
});

test('showPage: HTML/JS bermusuhan dipaksa menjadi teks oleh sink textContent', () => {
  assert.ok(hostileHtml.length >= 2);
  for (const value of hostileHtml) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }
  assert.match(hostileHtml.join('|'), /<img src=x onerror=alert\(1\)>/);
  assert.match(hostileHtml.join('|'), /<script>alert\(1\)<\/script>/);

  // Kontrak statis: satu-satunya sink untuk title/sub adalah textContent.
  // Tidak ada API parser HTML yang bisa mengubah string di atas menjadi elemen.
  const sinks = body.match(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment)\b/g) || [];
  assert.deepEqual(sinks, []);
  assert.match(body, /getElementById\('pageTitle'\)\.textContent = title/);
  assert.match(body, /getElementById\('pageSub'\)\.textContent = sub/);
});

test('showPage: perilaku navigasi dan struktur target tidak berubah', () => {
  assert.match(body, /querySelectorAll\('\.page'\)\.forEach/);
  assert.match(body, /classList\.remove\('active'\)/);
  assert.match(body, /getElementById\('page-'\+id\)\.classList\.add\('active'\)/);
  assert.match(body, /querySelectorAll\('\.sb-nav button'\)\.forEach/);
  assert.match(body, /el\.classList\.add\('active'\)/);
  assert.match(source, /<h1 id="pageTitle">Dashboard Utama<\/h1>/);
  assert.match(source, /<div class="sub" id="pageSub">/);
});

test('showPage: seluruh pemanggil tetap memakai literal statis', () => {
  assert.equal(callLines.length, 10);
  assert.ok(callLines.every((line) => !/\$\{/.test(line)));
  assert.ok(callLines.every((line) => !/\+\s*(?:title|sub|data|value|response|row)\b/.test(line)));
  assert.ok(callLines.every((line) => /'[^']*',\s*'[^']*'\)/.test(line)));
});

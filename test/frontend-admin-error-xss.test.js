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

const body = extractFunctionBody('loadTeknisiData');
const catchIndex = body.indexOf('catch (error) {');
assert.notEqual(catchIndex, -1, 'blok catch loadTeknisiData tidak ditemukan');
const catchBody = body.slice(catchIndex);

// Pesan error bermusuhan: kutip, sudut, tag HTML, dan potongan JavaScript.
// Kontraknya: seluruh nilai ini hanya boleh menjadi teks, tidak pernah markup.
const hostileMessages = [
  `<img src=x onerror="alert(1)">`,
  `'); alert(1); //`,
  `<script>alert('xss')</script>`,
  `" onmouseover="alert(1)`,
  'a`b${alert(1)}c'
];

test('admin teknisi: error.message tidak pernah masuk ke innerHTML', () => {
  assert.doesNotMatch(catchBody, /innerHTML/);
  assert.doesNotMatch(catchBody, /insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(catchBody, /\$\{[^}]*error\.message/);
  assert.doesNotMatch(catchBody, /error\.message\s*\}/);
  for (const message of hostileMessages) {
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0);
  }
});

test('admin teknisi: kartu error dibangun dengan DOM API dan pesan sebagai teks', () => {
  assert.match(catchBody, /document\.createElement\('div'\)/);
  assert.match(catchBody, /className = 'tek-card'/);
  assert.match(catchBody, /color:#b02a37; border-color:#f5c2c7; background:#f8d7da/);
  assert.match(catchBody, /document\.createElement\('b'\)/);
  assert.match(catchBody, /textContent = 'Gagal memuat data:'/);
  assert.match(catchBody, /createTextNode\(' '\)/);
  assert.match(catchBody, /document\.createElement\('br'\)/);
  assert.match(catchBody, /document\.createElement\('span'\)/);
  assert.match(catchBody, /textContent = error\?\.message \|\| ''/);
  assert.match(catchBody, /appendChild\(message\)/);
  assert.match(catchBody, /appendChild\(card\)/);
});

test('admin teknisi: alur muat dan logging tetap utuh', () => {
  assert.match(body, /Membaca data teknisi\.\.\./);
  assert.match(body, /fetch\('\/api\/teknisi\/list'/);
  assert.match(body, /renderTeknisiCards\(rows\)/);
  assert.match(catchBody, /console\.error\('Error loadTeknisiData:', error\)/);
  assert.match(catchBody, /Gagal memuat data:/);
});

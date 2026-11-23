const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function extractFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `fungsi ${name} tidak ditemukan`);

  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) {
      return source.slice(braceStart + 1, index);
    }
  }
  throw new Error(`fungsi ${name} tidak memiliki penutup`);
}

const portals = ['pelanggan-portal.html', 'portal-mitra.html'];

for (const fileName of portals) {
  test(`${fileName}: forgot-password mengisi token lalu membuka form reset`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
    const body = extractFunctionBody(source, 'requestPasswordReset');

    const tokenIndex = body.indexOf("document.getElementById('resetToken').value = data.dev_token");
    const navigateIndex = body.indexOf("showAuth('auth-reset')");

    assert.notEqual(tokenIndex, -1, 'dev_token belum diisi ke field resetToken');
    assert.notEqual(navigateIndex, -1, 'tidak ada navigasi ke auth-reset setelah respons berhasil');
    assert.ok(tokenIndex < navigateIndex, 'navigasi terjadi sebelum dev_token diisi');
    assert.match(body, /setAuthMessage\('resetMessage'/, 'pesan sukses tidak diteruskan ke form reset');
  });
}

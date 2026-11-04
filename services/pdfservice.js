const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

let browserPromise = null;

function findSystemChrome(){
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }

  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function getBrowser() {
  if (!browserPromise) {
    const executablePath = findSystemChrome();
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      ...(executablePath ? { executablePath } : {})
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function formatRp(n) {
  return Number(n || 0).toLocaleString('id-ID');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTanggal(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d)) return dateStr;
  const bulan = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const jam = String(d.getHours()).padStart(2, '0');
  const menit = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}, ${jam}:${menit} WIB`;
}

function renderTemplate(templateName, vars) {
  const filePath = path.join(TEMPLATE_DIR, templateName);
  let html = fs.readFileSync(filePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), value ?? '');
  }
  return html;
}

function resolveFotoDataUrl(pathname) {
  if (!pathname) return null;
  const filename = path.basename(pathname);
  const abs = path.resolve(UPLOAD_DIR, filename);
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  const mimeType = mimeTypes[path.extname(filename).toLowerCase()];
  if (!mimeType || !fs.existsSync(abs)) return null;
  return `data:${mimeType};base64,${fs.readFileSync(abs).toString('base64')}`;
}

async function htmlToPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode().catch(() => undefined))));
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '12mm', bottom: '15mm', left: '12mm' }
    });
  } finally {
    await page.close();
  }
}

async function generateSPKPdf(spk) {
  const db = require('../db/database');
  const getSetting = async (key, fallback = '') => {
    const r = await db.get('SELECT value FROM pengaturan WHERE `key`=?', [key]);
    return r ? r.value : fallback;
  };

  const checklistHtml = (spk.checklist || []).map(item => `
    <li class="${item.selesai ? 'done' : ''}">
      <span class="box">${item.selesai ? '✓' : ''}</span>
      <span>${escapeHtml(item.item)}</span>
    </li>
  `).join('') || '<li><span class="box"></span><span>Tidak ada checklist</span></li>';

  let fotoSection = '';
  const fotoSebelum = (spk.foto || []).filter(f => f.tipe === 'sebelum');
  const fotoSesudah = (spk.foto || []).filter(f => f.tipe === 'sesudah');

  if (fotoSebelum.length || fotoSesudah.length) {
    const renderFoto = (foto, label) => {
      if (!foto.length) {
        return `<div class="photo-item"><div class="photo-placeholder"><span class="ic">📷</span><span>Belum ada foto</span></div><div class="label">${label}</div></div>`;
      }
      return foto.map((item, index) => {
        const url = resolveFotoDataUrl(item.path);
        const photoLabel = foto.length > 1 ? `${label} ${index + 1}` : label;
        return `<div class="photo-item">${url ? `<img src="${url}">` : `<div class="photo-placeholder">⚠</div>`}<div class="label">${photoLabel}</div></div>`;
      }).join('');
    };
    fotoSection = `
      <div class="section">
        <div class="section-title">Dokumentasi Pengerjaan</div>
        <div class="photo-grid">
          ${renderFoto(fotoSebelum, 'Sebelum Cuci')}
          ${renderFoto(fotoSesudah, 'Setelah Cuci')}
        </div>
      </div>`;
  }

  let catatanSection = '';
  if (spk.catatan) {
    catatanSection = `<div class="section"><div class="section-title">Catatan</div><div style="padding:10px;background:#f3f5f4;border-radius:6px;">${escapeHtml(spk.catatan)}</div></div>`;
  }
  if (spk.laporan?.laporan) {
    const teknisi = spk.laporan.teknisi_nama ? ` · ${escapeHtml(spk.laporan.teknisi_nama)}` : '';
    catatanSection += `<div class="section"><div class="section-title">Laporan Teknisi${teknisi}</div><div style="padding:10px;background:#f3f5f4;border-radius:6px;white-space:pre-wrap;">${escapeHtml(spk.laporan.laporan)}</div></div>`;
  }

  const notePembayaran = spk.status === 'Selesai'
    ? `<div class="status-bayar lunas"><span>✓</span> LUNAS — Terima kasih.</div>`
    : `<div class="status-bayar belum"><span>⚠</span> BELUM LUNAS — Bayar di kasir.</div>`;

  const vars = {
    NAMA_BISNIS:       escapeHtml(await getSetting('nama_bisnis', 'CuciMesin Carwash')),
    ALAMAT:            escapeHtml(await getSetting('alamat', 'Jl. Letda Sucipto, Tuban')),
    KONTAK:            escapeHtml(await getSetting('kontak', '0812-3456-7890')),
    WEBSITE:           escapeHtml(await getSetting('website', 'www.cucimesinmobil.id')),
    NO_SPK:            escapeHtml(spk.no_spk),
    TANGGAL:           escapeHtml(formatTanggal(spk.created_at)),
    STATUS:            escapeHtml(spk.status.toUpperCase()),
    STATUS_RAW:        escapeHtml(spk.status.replace(/\s/g, '')),
    PELANGGAN_NAMA:    escapeHtml(spk.pelanggan || '-'),
    KATEGORI:          escapeHtml(spk.kategori || 'Normal'),
    PELANGGAN_TELEPON: escapeHtml(spk.pelanggan_telepon || '-'),
    PELANGGAN_EMAIL:   escapeHtml(spk.pelanggan_email || '-'),
    PLAT_NOMOR:        escapeHtml(spk.plat_nomor || '-'),
    MERK_TIPE:         escapeHtml(spk.merk_tipe || '-'),
    TAHUN:             escapeHtml(spk.tahun || '-'),
    WARNA:             escapeHtml(spk.warna || '-'),
    TEKNISI:           escapeHtml(spk.teknisi_nama || '-'),
    WAKTU_MULAI:       escapeHtml(spk.waktu_mulai ? formatTanggal(spk.waktu_mulai) : '-'),
    WAKTU_SELESAI:     escapeHtml(spk.waktu_selesai ? formatTanggal(spk.waktu_selesai) : '-'),
    LAYANAN_NAMA:      escapeHtml(spk.layanan_nama || '-'),
    DURASI:            escapeHtml(spk.durasi_menit || 45),
    HARGA:             escapeHtml(formatRp(spk.harga)),
    DISKON:            escapeHtml(formatRp(spk.diskon)),
    SUBTOTAL:          escapeHtml(formatRp(spk.total)),
    TOTAL:             escapeHtml(formatRp(spk.total)),
    STATUS_BAYAR:      notePembayaran,
    CHECKLIST_ITEMS:   checklistHtml,
    FOTO_SECTION:      fotoSection,
    CATATAN_SECTION:   catatanSection,
    PRINTED_AT:        escapeHtml(formatTanggal(new Date().toISOString().slice(0, 19).replace('T', ' ')))
  };

  const html = renderTemplate('spk-pdf.html', vars);
  return htmlToPdf(html);
}

async function generateMitraInvoicePdf(invoice, mitra, items) {
  const db = require('../db/database');
  const getSetting = async (key, fallback = '') => {
    const row = await db.get('SELECT value FROM pengaturan WHERE `key`=?', [key]);
    return row ? row.value : fallback;
  };
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  const formatCurrency = (value) => `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
  const formatDate = (value) => {
    if (!value) return '-';
    const parts = String(value).slice(0, 10).split('-');
    if (parts.length !== 3) return escapeHtml(value);
    return escapeHtml(`${parts[2]}/${parts[1]}/${parts[0]}`);
  };
  const itemRows = items.map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td><strong>${escapeHtml(item.no_spk)}</strong><br><span class="muted">${escapeHtml(item.plat_nomor)} · ${escapeHtml(item.merk_tipe || 'Kendaraan')}</span></td>
      <td>${escapeHtml(item.layanan_nama || '-')}</td>
      <td>${formatDate(item.waktu_selesai || item.created_at)}</td>
      <td class="money">${formatCurrency(item.harga)}</td>
      <td class="money">${formatCurrency(item.diskon)}</td>
      <td class="money">${formatCurrency(item.total)}</td>
    </tr>
  `).join('');
  const company = escapeHtml(await getSetting('nama_bisnis', 'CuciMesin Carwash'));
  const address = escapeHtml(await getSetting('alamat', ''));
  const contact = escapeHtml(await getSetting('kontak', ''));
  const invoiceNumber = escapeHtml(invoice.no_invoice);
  const statusColor = invoice.status === 'Lunas' ? '#16803c' : '#a33a32';
  const html = `<!doctype html>
  <html lang="id"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#1d2733;font-size:11px;margin:0}
    .header{display:flex;justify-content:space-between;border-bottom:3px solid #1457a6;padding-bottom:16px;margin-bottom:22px}
    h1{font-size:23px;color:#1457a6;margin:0 0 8px}.muted{color:#687585}.number{text-align:right}
    .number strong{font-size:15px}.status{color:${statusColor};font-weight:bold;margin-top:6px}
    .grid{display:flex;justify-content:space-between;margin-bottom:22px;gap:30px}.block{width:50%}
    .label{font-size:9px;color:#687585;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px}
    .block strong{font-size:12px}.period{margin-top:8px}
    table{width:100%;border-collapse:collapse}th{background:#eef3f9;color:#27384d;text-align:left;font-size:9px;text-transform:uppercase}
    th,td{padding:9px 7px;border-bottom:1px solid #dce3eb;vertical-align:top}td{line-height:1.45}
    .money{text-align:right;white-space:nowrap}.totals{width:270px;margin:16px 0 0 auto}
    .totals div{display:flex;justify-content:space-between;padding:5px 0}.grand{font-size:14px;font-weight:bold;border-top:2px solid #1457a6;margin-top:5px;padding-top:10px!important}
    .note{margin-top:26px;padding:12px;background:#f3f6fa;border-radius:5px;color:#435165}
    footer{margin-top:36px;padding-top:10px;border-top:1px solid #dce3eb;color:#687585;font-size:9px}
  </style></head><body>
    <div class="header">
      <div><h1>${company}</h1><div class="muted">${address}${contact ? ` · ${contact}` : ''}</div></div>
      <div class="number"><strong>INVOICE</strong><br>${invoiceNumber}<div class="status">${escapeHtml(invoice.status)}</div></div>
    </div>
    <div class="grid">
      <div class="block"><div class="label">Ditagihkan kepada</div><strong>${escapeHtml(mitra.nama_showroom)}</strong><br>${escapeHtml(mitra.alamat || '')}<br>${escapeHtml(mitra.email || mitra.telepon || '')}</div>
      <div class="block"><div class="label">Periode pengerjaan</div><strong>${formatDate(invoice.periode_mulai)} – ${formatDate(invoice.periode_selesai)}</strong><div class="period"><span class="label">Tanggal invoice</span><br>${formatDate(invoice.created_at)}</div><div class="period"><span class="label">Jatuh tempo</span><br>${formatDate(invoice.jatuh_tempo)}</div></div>
    </div>
    <table><thead><tr><th>#</th><th>SPK / Kendaraan</th><th>Layanan</th><th>Selesai</th><th class="money">Harga</th><th class="money">Diskon</th><th class="money">Total</th></tr></thead>
      <tbody>${itemRows || '<tr><td colspan="7">Detail pekerjaan tidak tersedia.</td></tr>'}</tbody>
    </table>
    <div class="totals"><div><span>Jumlah unit</span><strong>${Number(invoice.total_unit || 0)}</strong></div><div><span>Subtotal</span><strong>${formatCurrency(invoice.subtotal)}</strong></div><div><span>Diskon</span><strong>− ${formatCurrency(invoice.diskon)}</strong></div><div class="grand"><span>Total tagihan</span><strong>${formatCurrency(invoice.total)}</strong></div></div>
    <div class="note">${invoice.status === 'Lunas' ? 'Invoice ini telah lunas dan diverifikasi.' : 'Silakan lakukan pembayaran sesuai prosedur kemitraan. Setelah transfer, laporkan pembayaran melalui portal mitra untuk diverifikasi.'}</div>
    <footer>Invoice ini diterbitkan secara elektronik oleh ${company}.</footer>
  </body></html>`;
  return htmlToPdf(html);
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { generateSPKPdf, generateMitraInvoicePdf, htmlToPdf, closeBrowser };
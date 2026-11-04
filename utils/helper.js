function toLocalDateString(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function toLocalDateTimeString(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19).replace('T', ' ');
}

async function generateNoSPK(db, connection) {
  const d = new Date();
  const prefix = `SPK-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
  const row = await db.get("SELECT no_spk FROM spk WHERE no_spk LIKE ? ORDER BY id DESC LIMIT 1", [prefix + '%'], connection);
  const n = row ? parseInt(row.no_spk.split('-').pop(), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

async function generateNoInvoice(db, mitraId, connection) {
  const d = new Date();
  const prefix = `INV-${mitraId}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
  const row = await db.get("SELECT no_invoice FROM invoice_mitra WHERE no_invoice LIKE ? ORDER BY id DESC LIMIT 1", [prefix + '%'], connection);
  const n = row ? parseInt(row.no_invoice.split('-').pop(), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

function defaultChecklist() {
  return [
    'Masking ECU & Kabel Elektrikal',
    'Check Kondisi Aki & Alternator',
    'Penyemprotan Chemical Khusus',
    'Bilas & Pengeringan Detail'
  ];
}

module.exports = { toLocalDateString, toLocalDateTimeString, generateNoSPK, generateNoInvoice, defaultChecklist };
import { db } from './db.js';
import { accessToken, googleConnected, getSetting, setSetting } from './google.js';

// Google Sheets mirror — the durable home of the data.
//
// SQLite stays the fast working copy; every change re-syncs its table to a
// "Team Pulse Data" spreadsheet in the connected Google account (created
// automatically, drive.file scope = the app only ever sees files it created).
// On a cold boot with an empty local database (ephemeral hosts), everything
// is restored FROM the sheet. Tables are tiny (~tens of rows), so each sync
// rewrites the whole tab — simple and drift-proof.
//
// Anonymity note (also in README): rows carry no timestamps, but Google keeps
// its own version history on the spreadsheet, which reveals *when* the sheet
// changed. Full-tab rewrites blur per-response timing, but an admin digging
// through revision history could approximate submission times. SQLite-only
// storage avoided that; the sheet trades it for durability + visibility.

const SPREADSHEET_NAME = 'Team Pulse Data';
export const MIRRORED_TABLES = ['responses', 'tokens', 'summaries', 'recipients', 'email_log', 'window_overrides'];

async function gapi(url, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Google API error (HTTP ${r.status})`);
  return d;
}

export async function ensureSpreadsheet() {
  if (!googleConnected()) return null;
  let id = getSetting('sheet_id');
  if (id) return id;
  const q = encodeURIComponent(`name='${SPREADSHEET_NAME}' and trashed=false`);
  const found = await gapi(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (found.files?.length) {
    id = found.files[0].id;
  } else {
    const created = await gapi('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      body: {
        properties: { title: SPREADSHEET_NAME },
        sheets: MIRRORED_TABLES.map((t) => ({ properties: { title: t } })),
      },
    });
    id = created.spreadsheetId;
  }
  setSetting('sheet_id', id);
  return id;
}

export function sheetUrl() {
  const id = getSetting('sheet_id');
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : null;
}

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function dumpTable(table) {
  const cols = columnsOf(table);
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  return [cols, ...rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))))];
}

async function syncTable(id, table) {
  const values = dumpTable(table);
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(table)}!A1:ZZ10000:clear`,
    { method: 'POST', body: {} }
  );
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(table)}!A1?valueInputOption=RAW`,
    { method: 'PUT', body: { values } }
  );
}

// Debounced write-through. queueSync('responses', 'tokens') after any write;
// failures are logged, never fatal — SQLite remains correct locally.
const pending = new Set();
let timer = null;
export function queueSync(...tables) {
  if (!googleConnected()) return;
  for (const t of tables) if (MIRRORED_TABLES.includes(t)) pending.add(t);
  clearTimeout(timer);
  timer = setTimeout(flush, 1500);
}

export async function flush() {
  if (!pending.size || !googleConnected()) return;
  const batch = [...pending];
  pending.clear();
  try {
    const id = await ensureSpreadsheet();
    if (!id) return;
    for (const t of batch) await syncTable(id, t);
  } catch (e) {
    console.warn('[sheets] mirror failed:', e.message);
    for (const t of batch) pending.add(t); // retry on next queue/interval
  }
}

export async function syncAll() {
  queueSync(...MIRRORED_TABLES);
  await flush();
}

// Cold-boot restore: only when the local database is completely empty, so a
// live local DB is never clobbered by an older sheet.
export async function restoreFromSheet() {
  if (!googleConnected()) return false;
  const localRows = MIRRORED_TABLES.reduce(
    (n, t) => n + db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0
  );
  if (localRows > 0) return false;
  const id = await ensureSpreadsheet();
  if (!id) return false;
  let restored = 0;
  for (const table of MIRRORED_TABLES) {
    let data;
    try {
      data = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(table)}!A1:ZZ10000`);
    } catch {
      continue; // tab missing — nothing to restore
    }
    const [header, ...rows] = data.values || [];
    if (!header || !rows.length) continue;
    const cols = columnsOf(table).filter((c) => header.includes(c));
    const ins = db.prepare(
      `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[header.indexOf(c)];
        return v === '' || v === undefined ? null : v;
      });
      try { ins.run(...vals); restored++; } catch (e) { console.warn(`[sheets] skipped a ${table} row: ${e.message}`); }
    }
  }
  console.log(`[sheets] restored ${restored} rows from "${SPREADSHEET_NAME}"`);
  return restored > 0;
}

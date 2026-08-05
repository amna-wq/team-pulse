import { db } from './db.js';
import { DEMO_MODE } from './cycle.js';
import { accessToken, googleConnected, getSetting, setSetting } from './google.js';
import { cycles, monthLabel, monthStats, detailRows, DETAIL_HEADERS, trendTable } from './monthly.js';

// Demo instances never touch the Sheet — in either direction. Fake seeded
// data must not leak into the shared spreadsheet, and a demo box must not
// clobber or restore production data. (The local HTML export still works.)
const mirrorEnabled = () => !DEMO_MODE;

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

// ---------- human-readable monthly tabs (with charts) ----------
//
// The raw table tabs above are the machine-readable backup that cold-boot
// restore reads. These monthly tabs are what a person actually opens: one tab
// per month ("Aug 2026"), every answer spelled out in words, a stats block at
// the top, and native Google charts drawn from that block.

async function spreadsheetMeta(id) {
  return gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets(properties(sheetId,title),charts(chartId))`);
}

async function batch(id, requests) {
  if (!requests.length) return;
  return gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    method: 'POST', body: { requests },
  });
}

// Layout of a month tab. Keeping these as constants because the chart ranges
// have to point at exactly the rows the writer produced.
const STATS_ROW = 2;             // "Averages out of 10" block header (0-indexed)
const AVG_ROWS = 6;              // one row per slider question

function monthValues(stats) {
  const v = [];
  v.push([`Team Pulse — ${stats.label}`]);
  v.push([]);
  v.push(['Averages out of 10', 'Score']);
  for (const a of stats.averages) v.push([a.label, a.avg]);
  v.push([]);
  v.push(['Biggest blocker', 'People']);
  for (const b of stats.blockers) v.push([b.label, b.count]);
  v.push([]);
  v.push(['Process to improve', 'People']);
  for (const p of stats.processes) v.push([p.label, p.count]);
  v.push([]);
  v.push(['What motivates the team', 'People']);
  for (const m of stats.motivations) v.push([m.label, m.count]);
  v.push([]);
  v.push(['Responses', stats.responses]);
  v.push(['Invited', stats.invited]);
  v.push(['Participation %', stats.participation]);
  v.push(['Written comments', stats.comments]);
  v.push(['Private concerns', stats.concerns]);
  v.push([]);
  v.push(['EVERY RESPONSE THIS MONTH (anonymous, order is randomised)']);
  v.push(DETAIL_HEADERS);
  for (const r of detailRows(stats.cycle)) v.push(r);
  return v;
}

// Rows where each tally block starts, derived from the same layout as above.
function blockOffsets(stats) {
  const avgStart = STATS_ROW + 1;
  const blockerHeader = avgStart + AVG_ROWS + 1;
  const processHeader = blockerHeader + 1 + stats.blockers.length + 1;
  const motivationHeader = processHeader + 1 + stats.processes.length + 1;
  return {
    avg: { start: avgStart, end: avgStart + stats.averages.length },
    blocker: { start: blockerHeader + 1, end: blockerHeader + 1 + stats.blockers.length },
    process: { start: processHeader + 1, end: processHeader + 1 + stats.processes.length },
    motivation: { start: motivationHeader + 1, end: motivationHeader + 1 + stats.motivations.length },
  };
}

const chartSpec = (title, sheetId, range, type, anchorRow, anchorCol) => ({
  addChart: {
    chart: {
      spec: {
        title,
        [type === 'PIE' ? 'pieChart' : 'basicChart']: type === 'PIE'
          ? {
              legendPosition: 'RIGHT_LEGEND',
              domain: { sourceRange: { sources: [{ sheetId, startRowIndex: range.start, endRowIndex: range.end, startColumnIndex: 0, endColumnIndex: 1 }] } },
              series: { sourceRange: { sources: [{ sheetId, startRowIndex: range.start, endRowIndex: range.end, startColumnIndex: 1, endColumnIndex: 2 }] } },
            }
          : {
              chartType: type,
              legendPosition: 'NO_LEGEND',
              axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
              domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: range.start, endRowIndex: range.end, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
              // BAR is horizontal, so its value axis is the bottom one; COLUMN
              // is vertical and uses the left. Sheets rejects the wrong pairing.
              series: [{
                series: { sourceRange: { sources: [{ sheetId, startRowIndex: range.start, endRowIndex: range.end, startColumnIndex: 1, endColumnIndex: 2 }] } },
                targetAxis: type === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
              }],
            },
      },
      position: {
        overlayPosition: {
          anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol },
          widthPixels: 460, heightPixels: 280,
        },
      },
    },
  },
});

async function syncMonthTabs(id) {
  const meta = await spreadsheetMeta(id);
  const bySheetTitle = new Map(meta.sheets.map((s) => [s.properties.title, s]));

  for (const cycle of cycles()) {
    const title = monthLabel(cycle); // "Aug 2026"
    let sheet = bySheetTitle.get(title);
    if (!sheet) {
      await batch(id, [{ addSheet: { properties: { title, index: 0 } } }]);
      const fresh = await spreadsheetMeta(id);
      sheet = fresh.sheets.find((s) => s.properties.title === title);
      bySheetTitle.set(title, sheet);
    }
    const stats = monthStats(cycle);
    const values = monthValues(stats);

    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(title)}!A1:ZZ10000:clear`, { method: 'POST', body: {} });
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(title)}!A1?valueInputOption=RAW`, { method: 'PUT', body: { values } });

    // Charts are drawn once per tab; re-syncing rewrites the numbers under them.
    if (!sheet.charts?.length) {
      const sheetId = sheet.properties.sheetId;
      const off = blockOffsets(stats);
      await batch(id, [
        chartSpec(`How the team is doing — ${title}`, sheetId, off.avg, 'COLUMN', STATS_ROW, 4),
        chartSpec(`Biggest blocker — ${title}`, sheetId, off.blocker, 'BAR', STATS_ROW + 15, 4),
        chartSpec(`What motivates the team — ${title}`, sheetId, off.motivation, 'PIE', STATS_ROW + 30, 4),
      ]);
    }
  }

  // A "Trends" tab across every month, with one line chart.
  const t = trendTable();
  if (t.rows.length) {
    let trend = bySheetTitle.get('Trends');
    if (!trend) {
      await batch(id, [{ addSheet: { properties: { title: 'Trends', index: 0 } } }]);
      const fresh = await spreadsheetMeta(id);
      trend = fresh.sheets.find((s) => s.properties.title === 'Trends');
    }
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Trends!A1:ZZ1000:clear`, { method: 'POST', body: {} });
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Trends!A1?valueInputOption=RAW`, {
      method: 'PUT', body: { values: [t.header, ...t.rows] },
    });
    if (!trend.charts?.length) {
      const sheetId = trend.properties.sheetId;
      const end = t.rows.length + 1;
      await batch(id, [{
        addChart: {
          chart: {
            spec: {
              title: 'Every question, month by month',
              basicChart: {
                chartType: 'LINE', legendPosition: 'BOTTOM_LEGEND',
                axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS', title: 'Average out of 10' }],
                headerCount: 1,
                domains: [{ domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: end, startColumnIndex: 0, endColumnIndex: 1 }] } } }],
                series: Array.from({ length: 6 }, (_, i) => ({
                  series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: end, startColumnIndex: i + 1, endColumnIndex: i + 2 }] } },
                  targetAxis: 'LEFT_AXIS',
                })),
              },
            },
            position: { overlayPosition: { anchorCell: { sheetId, rowIndex: end + 2, columnIndex: 0 }, widthPixels: 900, heightPixels: 420 } },
          },
        },
      }]);
    }
  }
}

// Debounced write-through. queueSync('responses', 'tokens') after any write;
// failures are logged, never fatal — SQLite remains correct locally.
const pending = new Set();
let timer = null;
export function queueSync(...tables) {
  if (!mirrorEnabled() || !googleConnected()) return;
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
    // Responses changing means the readable monthly tabs are stale too.
    if (batch.includes('responses') || batch.includes('tokens')) await syncMonthTabs(id);
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
  if (!mirrorEnabled() || !googleConnected()) return false;
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

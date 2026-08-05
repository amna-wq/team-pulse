import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cycles, monthLabel, monthStats, detailRows, DETAIL_HEADERS, trendTable } from './monthly.js';

// The copy that lives on the Mac itself.
//
// The Google Sheet is the shareable/durable home, but it only exists once
// Google is connected — and Google Drive for Desktop isn't installed, so the
// sheet never lands on this machine by itself. This writes the same data to a
// real folder: one CSV per month, a trends CSV, and a self-contained HTML
// dashboard with charts that opens straight in a browser. No dependencies.

export const EXPORT_DIR =
  process.env.LOCAL_EXPORT_DIR || path.join(os.homedir(), 'Team Pulse Data');

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function monthCsv(cycle) {
  const s = monthStats(cycle);
  const rows = [
    [`Team Pulse — ${s.label}`],
    [],
    ['Responses', s.responses],
    ['Invited', s.invited],
    ['Participation %', s.participation],
    ['Written comments', s.comments],
    ['Private concerns', s.concerns],
    [],
    ['Averages out of 10', 'Score'],
    ...s.averages.map((a) => [a.label, a.avg]),
    [],
    ['Biggest blocker', 'People'],
    ...s.blockers.map((b) => [b.label, b.count]),
    [],
    ['Process to improve', 'People'],
    ...s.processes.map((p) => [p.label, p.count]),
    [],
    ['What motivates the team', 'People'],
    ...s.motivations.map((m) => [m.label, m.count]),
    [],
    ['EVERY RESPONSE THIS MONTH (anonymous, order is randomised)'],
    DETAIL_HEADERS,
    ...detailRows(cycle),
  ];
  return toCsv(rows);
}

// ---- charts, hand-drawn as inline SVG so the file needs nothing external ----

const scoreColor = (v) => (v <= 3 ? '#d6453d' : v <= 6 ? '#e0862f' : v <= 8 ? '#6aa63c' : '#2b8a3e');

function barChart(items, { max, colorBy } = {}) {
  const top = max || Math.max(1, ...items.map((i) => i.value));
  return `<div class="bars">${items.map((i) => {
    const w = (100 * i.value) / top;
    const c = colorBy === 'score' ? scoreColor(i.value) : (i.value === top && top > 0 ? '#d6453d' : '#2563eb');
    return `<div class="bar-row">
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${c}"></span></span>
      <span class="bar-val" style="color:${c}">${i.value}</span>
    </div>`;
  }).join('')}</div>`;
}

function lineChart(trend) {
  const months = trend.rows.map((r) => r[0]);
  if (months.length < 2) return '<p class="muted">A trend line appears once there are two months of data.</p>';
  const W = 860, H = 300, P = 44;
  const x = (i) => P + (i * (W - 2 * P)) / (months.length - 1);
  const y = (v) => H - P - ((v - 1) * (H - 2 * P)) / 9;
  const palette = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
  const series = trend.header.slice(1, 7).map((label, s) => {
    const pts = trend.rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[s + 1]).toFixed(1)}`).join(' ');
    return `<path d="${pts}" fill="none" stroke="${palette[s]}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      trend.rows.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r[s + 1]).toFixed(1)}" r="3.5" fill="${palette[s]}"><title>${esc(label)} · ${esc(r[0])}: ${r[s + 1]}</title></circle>`).join('');
  }).join('');
  const grid = [2, 4, 6, 8, 10].map((v) =>
    `<line x1="${P}" y1="${y(v)}" x2="${W - P}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${P - 10}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}</text>`).join('');
  const xlab = months.map((m, i) => `<text x="${x(i)}" y="${H - P + 20}" text-anchor="middle" class="ax">${esc(m)}</text>`).join('');
  const legend = trend.header.slice(1, 7).map((l, i) =>
    `<span class="key"><i style="background:${palette[i]}"></i>${esc(l)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="line">${grid}${series}${xlab}</svg><div class="legend">${legend}</div>`;
}

function dashboardHtml() {
  const list = cycles();
  const trend = trendTable();
  const sections = list.map((c) => {
    const s = monthStats(c);
    const details = detailRows(c);
    return `<section class="card">
      <h2>${esc(s.label)}</h2>
      <div class="stat-row">
        ${[['Responses', s.responses], ['Invited', s.invited], ['Participation', s.participation + '%'],
           ['Comments', s.comments], ['Private concerns', s.concerns]]
          .map(([l, v]) => `<div class="stat"><div class="n">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')}
      </div>
      <h3>How the team is doing</h3>
      ${barChart(s.averages.map((a) => ({ label: a.label, value: a.avg })), { max: 10, colorBy: 'score' })}
      <div class="two">
        <div><h3>Biggest blocker</h3>${barChart(s.blockers.map((b) => ({ label: b.label, value: b.count })))}</div>
        <div><h3>What motivates the team</h3>${barChart(s.motivations.map((m) => ({ label: m.label, value: m.count })))}</div>
      </div>
      <h3>Process to improve</h3>
      ${barChart(s.processes.map((p) => ({ label: p.label, value: p.count })))}
      <details>
        <summary>Every response this month (${details.length}) — anonymous, order randomised</summary>
        <div class="tablewrap"><table>
          <thead><tr>${DETAIL_HEADERS.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${details.map((r) => `<tr>${r.map((c2) => `<td>${esc(c2)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </details>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Pulse — data on this Mac</title>
<style>
  :root{--ink:#111827;--ink2:#4b5563;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb}
  *{box-sizing:border-box}
  body{margin:0;background:#f4f8fd;color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{max-width:1000px;margin:0 auto;padding:28px 18px 70px}
  header.top{background:#10141f;border-bottom:3px solid #dc2626;border-radius:10px;padding:20px 24px;margin-bottom:18px}
  header.top h1{color:#fff;margin:0;font-size:22px}
  header.top p{color:#9ca3af;margin:5px 0 0;font-size:13px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;margin:18px 0;box-shadow:0 1px 3px rgba(17,24,39,.07)}
  h2{font-size:18px;margin:0 0 14px}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 8px}
  .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
  .stat{border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:10px;padding:12px;text-align:center}
  .stat .n{font-size:22px;font-weight:700}
  .stat .l{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .bars{display:flex;flex-direction:column;gap:6px}
  .bar-row{display:grid;grid-template-columns:minmax(140px,34%) 1fr auto;gap:10px;align-items:center}
  .bar-label{font-size:13px;color:var(--ink2)}
  .bar-track{background:#e4eafb;border-radius:4px;height:12px;overflow:hidden}
  .bar-fill{display:block;height:100%;border-radius:4px}
  .bar-val{font-weight:700;font-size:13px;min-width:34px;text-align:right}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:760px){.two{grid-template-columns:1fr}}
  svg.line{width:100%;height:auto}
  .ax{font-size:11px;fill:var(--muted)}
  .legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--ink2)}
  .key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
  details{margin-top:18px}
  summary{cursor:pointer;font-weight:600;font-size:13.5px;color:var(--accent)}
  .tablewrap{overflow:auto;max-height:460px;border:1px solid var(--line);border-radius:8px;margin-top:10px}
  table{border-collapse:collapse;font-size:12.5px;white-space:nowrap}
  th{position:sticky;top:0;background:#f9fafb;text-align:left;padding:8px 10px;border-bottom:2px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  td{padding:7px 10px;border-bottom:1px solid var(--line);max-width:280px;overflow:hidden;text-overflow:ellipsis}
  .muted{color:var(--muted);font-size:13px}
  footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
</style></head><body><main>
<header class="top">
  <h1>Team Pulse — the copy on this Mac</h1>
  <p>Written automatically by the app. Anonymous by design: no names, no timestamps, nothing traceable to a person.</p>
</header>
<section class="card"><h2>Trend across every month</h2>${lineChart(trend)}</section>
${sections || '<section class="card"><p class="muted">No responses recorded yet.</p></section>'}
<footer>Generated ${new Date().toLocaleString()} · re-written every time a response arrives</footer>
</main></body></html>`;
}

let timer = null;
let running = false;

export function writeLocalExport() {
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const months = cycles();
    for (const c of months) {
      fs.writeFileSync(path.join(EXPORT_DIR, `${monthLabel(c).replace(/ /g, '-')}.csv`), monthCsv(c));
    }
    const t = trendTable();
    fs.writeFileSync(path.join(EXPORT_DIR, 'Trends.csv'), toCsv([t.header, ...t.rows]));
    fs.writeFileSync(path.join(EXPORT_DIR, 'Team Pulse Dashboard.html'), dashboardHtml());
    return { dir: EXPORT_DIR, months: months.length };
  } catch (e) {
    console.warn('[local-export] failed:', e.message);
    return null;
  }
}

// Debounced, same rhythm as the Sheets mirror.
export function queueLocalExport() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (running) return;
    running = true;
    try { writeLocalExport(); } finally { running = false; }
  }, 1500);
}

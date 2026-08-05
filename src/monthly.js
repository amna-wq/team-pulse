import { db } from './db.js';
import { SLIDERS, BLOCKERS, PROCESSES, MOTIVATIONS, sliderKeys } from './questions.js';

// One month's report, built once and reused by both outputs: the Google Sheet
// monthly tabs and the local copy on the Mac.
//
// ANONYMITY: detail rows are ordered by a stable shuffle of the response ids,
// never by insertion order, so row position can't be read as submission order.
// Responses carry no author and no timestamp to begin with (see src/db.js).

export const monthLabel = (cycle) => {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
};

export function cycles() {
  return db.prepare('SELECT DISTINCT cycle FROM responses ORDER BY cycle DESC').all().map((r) => r.cycle);
}

const labelOf = (list, key) => list.find((i) => i.key === key)?.label || key || '';

// Deterministic shuffle: same input always gives the same order, so a re-sync
// doesn't reshuffle rows (which would look like edits in the sheet's history),
// yet the order still carries no information about who submitted when.
function stableShuffle(rows) {
  return rows
    .map((r) => {
      let h = 2166136261;
      const s = `${r.id}:${r.cycle}`;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return { r, k: h >>> 0 };
    })
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);
}

export const DETAIL_HEADERS = [
  '#',
  ...SLIDERS.map((s) => s.label),
  'Biggest blocker',
  'Blocker — other (write-in)',
  'Process to improve',
  'Process — other (write-in)',
  'What motivates them',
  'Why (their words)',
  'Open comment',
  'Private concern (management only)',
  'Concern urgent?',
  'Upward: start',
  'Upward: stop',
  'Upward: continue',
];

export function detailRows(cycle) {
  const rows = stableShuffle(db.prepare('SELECT * FROM responses WHERE cycle = ?').all(cycle));
  return rows.map((r, i) => [
    i + 1,
    ...sliderKeys.map((k) => r[k]),
    labelOf(BLOCKERS, r.blocker),
    r.blocker_other || '',
    labelOf(PROCESSES, r.process_improvement),
    r.process_other || '',
    labelOf(MOTIVATIONS, r.motivation),
    r.motivation_why || '',
    r.open_text || '',
    r.concern || '',
    r.concern_urgent ? 'URGENT' : '',
    r.upward_start || '',
    r.upward_stop || '',
    r.upward_continue || '',
  ]);
}

export function monthStats(cycle) {
  const rows = db.prepare('SELECT * FROM responses WHERE cycle = ?').all(cycle);
  const n = rows.length;
  const avg = (k) => (n ? rows.reduce((s, r) => s + r[k], 0) / n : 0);
  const tally = (field, list) => {
    const counts = Object.fromEntries(list.map((i) => [i.key, 0]));
    for (const r of rows) if (counts[r[field]] !== undefined) counts[r[field]]++;
    return list.map((i) => ({ label: i.label, count: counts[i.key] }));
  };
  const tok = db
    .prepare('SELECT COUNT(*) AS issued, COALESCE(SUM(used),0) AS used FROM tokens WHERE cycle = ?')
    .get(cycle) || { issued: 0, used: 0 };

  return {
    cycle,
    label: monthLabel(cycle),
    responses: n,
    invited: tok.issued,
    participation: tok.issued ? Math.round((100 * tok.used) / tok.issued) : 0,
    averages: SLIDERS.map((s) => ({ label: s.label, avg: Number(avg(s.key).toFixed(2)) })),
    blockers: tally('blocker', BLOCKERS),
    processes: tally('process_improvement', PROCESSES),
    motivations: tally('motivation', MOTIVATIONS),
    comments: rows.filter((r) => (r.open_text || '').trim()).length,
    concerns: rows.filter((r) => (r.concern || '').trim()).length,
  };
}

// Month-over-month trend for every question, used by the charts.
export function trendTable() {
  const cs = [...cycles()].reverse();
  return {
    header: ['Month', ...SLIDERS.map((s) => s.label), 'Responses'],
    rows: cs.map((c) => {
      const s = monthStats(c);
      return [s.label, ...s.averages.map((a) => a.avg), s.responses];
    }),
  };
}

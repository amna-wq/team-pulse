import { db } from './db.js';

export const DEMO_MODE = process.env.DEMO_MODE === 'true';

// A cycle is one calendar month, identified as "YYYY-MM".
export function currentCycle(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// The survey window opens automatically at 09:00 on the 27th of the month
// (same day the review-cycle emails go out) and locks 48 hours later.
export function windowFor(cycle) {
  const [y, m] = cycle.split('-').map(Number);
  const opens = new Date(y, m - 1, 27, 9, 0, 0);
  const closes = new Date(opens.getTime() + 48 * 3600 * 1000);
  return { opens, closes };
}

// An override may carry an expiry (`until`, ISO timestamp). A timed "open"
// override reopens the window until that moment and then falls back to the
// automatic schedule by itself — no one has to remember to close it, and the
// invite email prints the real deadline instead of the original one.
export function getOverride(cycle, now = new Date()) {
  const row = db.prepare('SELECT state, until FROM window_overrides WHERE cycle = ?').get(cycle);
  if (!row) return null;
  if (row.until) {
    const u = new Date(row.until);
    if (Number.isNaN(u.getTime()) || now >= u) return null; // malformed or expired → no override
  }
  return { state: row.state, until: row.until || null };
}

export function setOverride(cycle, state, until = null) {
  if (state === null) {
    db.prepare('DELETE FROM window_overrides WHERE cycle = ?').run(cycle);
  } else {
    db.prepare(
      `INSERT INTO window_overrides (cycle, state, until) VALUES (?, ?, ?)
       ON CONFLICT(cycle) DO UPDATE SET state = excluded.state, until = excluded.until`
    ).run(cycle, state, until);
  }
}

// Window state for the current cycle. Admin override wins; demo mode defaults
// to open (so the survey is demoable any day of the month); otherwise the
// automatic schedule decides.
export function windowState(now = new Date()) {
  const cycle = currentCycle(now);
  let { opens, closes } = windowFor(cycle);
  const override = getOverride(cycle, now);
  let open;
  let mode;
  if (override) {
    open = override.state === 'open';
    mode = 'override';
    if (open && override.until) closes = new Date(override.until);
  } else if (DEMO_MODE) {
    open = true;
    mode = 'demo';
  } else {
    open = now >= opens && now < closes;
    mode = 'auto';
  }
  return { cycle, open, mode, opens: opens.toISOString(), closes: closes.toISOString() };
}

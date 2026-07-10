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

export function getOverride(cycle) {
  const row = db.prepare('SELECT state FROM window_overrides WHERE cycle = ?').get(cycle);
  return row ? row.state : null;
}

export function setOverride(cycle, state) {
  if (state === null) {
    db.prepare('DELETE FROM window_overrides WHERE cycle = ?').run(cycle);
  } else {
    db.prepare(
      'INSERT INTO window_overrides (cycle, state) VALUES (?, ?) ON CONFLICT(cycle) DO UPDATE SET state = excluded.state'
    ).run(cycle, state);
  }
}

// Window state for the current cycle. Admin override wins; demo mode defaults
// to open (so the survey is demoable any day of the month); otherwise the
// automatic schedule decides.
export function windowState(now = new Date()) {
  const cycle = currentCycle(now);
  const { opens, closes } = windowFor(cycle);
  const override = getOverride(cycle);
  let open;
  let mode;
  if (override) {
    open = override === 'open';
    mode = 'override';
  } else if (DEMO_MODE) {
    open = true;
    mode = 'demo';
  } else {
    open = now >= opens && now < closes;
    mode = 'auto';
  }
  return { cycle, open, mode, opens: opens.toISOString(), closes: closes.toISOString() };
}

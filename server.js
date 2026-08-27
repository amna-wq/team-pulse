import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './src/db.js';
import { currentCycle, windowState, windowFor, setOverride, DEMO_MODE } from './src/cycle.js';
import { SLIDERS, BLOCKERS, PROCESSES, MOTIVATIONS, OPEN_TEXT_LABEL, sliderKeys, blockerKeys, processKeys, motivationKeys } from './src/questions.js';
import { createPeerRouter } from './src/phase2-peer-feedback.js';
import { sendInvites, mailConfigured, renderInviteEmail, baseUrl, gmailStatus, gmailExchangeCode, gmailDisconnect } from './src/mailer.js';
import { fetchTeamEmails, teamSource, sageConfigured } from './src/team.js';
import { queueSync as queueSheetSync, syncAll, flush, restoreFromSheet, ensureSpreadsheet, sheetUrl, MIRRORED_TABLES } from './src/sheets.js';
import { queueLocalExport, writeLocalExport, dashboardHtml, EXPORT_DIR } from './src/localexport.js';

// Every write goes to both homes: the Google Sheet (shareable, durable) and
// the folder on this Mac (works with or without Google connected).
function queueSync(...tables) {
  queueSheetSync(...tables);
  if (tables.includes('responses') || tables.includes('tokens')) queueLocalExport();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (DEMO_MODE ? 'demo-admin' : null);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Aggregates are hidden below this response count so a near-empty cycle can't
// expose an almost-individual view.
const MIN_RESPONSES_TO_SHOW = Number(process.env.MIN_RESPONSES_TO_SHOW || 5);
const MAX_TEXT = 4000;

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is required (or set DEMO_MODE=true). Refusing to start without one.');
  process.exit(1);
}

// Google sign-in for admins. Only these emails may enter; password stays as fallback.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'khalid@k-brands.com,amna@k-brands.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// Lightweight migrations (no-ops when the columns already exist).
for (const sql of [
  'ALTER TABLE tokens ADD COLUMN opened INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE recipients ADD COLUMN last_sent_at TEXT',
  'ALTER TABLE recipients ADD COLUMN last_error TEXT',
  'ALTER TABLE recipients ADD COLUMN name TEXT',
  'ALTER TABLE recipients ADD COLUMN name_source TEXT',
  'ALTER TABLE recipients ADD COLUMN role TEXT',
  'ALTER TABLE responses ADD COLUMN motivation TEXT',
  'ALTER TABLE responses ADD COLUMN motivation_why TEXT',
  'ALTER TABLE responses ADD COLUMN blocker_other TEXT',
  'ALTER TABLE responses ADD COLUMN process_other TEXT',
]) {
  try { db.exec(sql); } catch { /* column exists */ }
}

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function setSessionCookie(res) {
  const expires = Date.now() + 12 * 3600 * 1000;
  const payload = `admin.${expires}`;
  const cookie = `${payload}.${sign(payload)}`;
  res.setHeader(
    'Set-Cookie',
    `pulse_admin=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`
  );
}

function isAdmin(req) {
  const raw = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('pulse_admin='));
  if (!raw) return false;
  const parts = raw.slice('pulse_admin='.length).split('.');
  if (parts.length !== 3) return false;
  const [tag, expires, sig] = parts;
  const payload = `${tag}.${expires}`;
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return tag === 'admin' && Number(expires) > Date.now();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// Fisher-Yates. Comments are shuffled on every read so their display order
// never reflects submission order.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cycleAggregates(cycle) {
  const rows = db.prepare('SELECT * FROM responses WHERE cycle = ?').all(cycle);
  const count = rows.length;
  const averages = {};
  for (const k of sliderKeys) {
    averages[k] = count ? rows.reduce((s, r) => s + r[k], 0) / count : null;
  }
  const blockers = Object.fromEntries(blockerKeys.map((k) => [k, 0]));
  const processes = Object.fromEntries(processKeys.map((k) => [k, 0]));
  const motivations = Object.fromEntries(motivationKeys.map((k) => [k, 0]));
  for (const r of rows) {
    if (r.blocker in blockers) blockers[r.blocker]++;
    if (r.process_improvement in processes) processes[r.process_improvement]++;
    if (r.motivation in motivations) motivations[r.motivation]++;
  }
  const blockerOthers = rows.map((r) => r.blocker_other).filter((t) => t && t.trim());
  const processOthers = rows.map((r) => r.process_other).filter((t) => t && t.trim());
  const motivationNotes = rows
    .filter((r) => r.motivation_why && r.motivation_why.trim())
    .map((r) => ({ m: r.motivation, text: r.motivation_why }));
  const comments = rows.map((r) => r.open_text).filter((t) => t && t.trim());
  const concerns = rows
    .filter((r) => r.concern && r.concern.trim())
    .map((r) => ({ text: r.concern, urgent: !!r.concern_urgent }));
  const upward = {
    start: rows.map((r) => r.upward_start).filter((t) => t && t.trim()),
    stop: rows.map((r) => r.upward_stop).filter((t) => t && t.trim()),
    continue: rows.map((r) => r.upward_continue).filter((t) => t && t.trim()),
  };
  return { count, averages, blockers, processes, motivations, motivationNotes, blockerOthers, processOthers, comments, concerns, upward };
}

// ---------- public API ----------

app.get('/api/meta', (req, res) => {
  res.json({
    sliders: SLIDERS,
    blockers: BLOCKERS,
    processes: PROCESSES,
    motivations: MOTIVATIONS,
    openTextLabel: OPEN_TEXT_LABEL,
    demoMode: DEMO_MODE,
    peerModuleEnabled: process.env.MANAGEMENT_SPONSORED === 'true',
    googleClientId: GOOGLE_CLIENT_ID,
    window: windowState(),
  });
});

// Check a survey link before showing the form.
app.get('/api/survey/state', (req, res) => {
  const token = String(req.query.token || '');
  const win = windowState();
  if (!token) return res.json({ valid: false, window: win });
  const row = db.prepare('SELECT used, cycle FROM tokens WHERE token_hash = ?').get(sha256(token));
  // Aggregate-only open tracking: flip a flag on the token, never tied to a person.
  if (row && row.cycle === win.cycle) {
    db.prepare('UPDATE tokens SET opened = 1 WHERE token_hash = ?').run(sha256(token));
    queueSync('tokens');
  }
  res.json({
    valid: !!row && row.cycle === win.cycle,
    used: row ? !!row.used : false,
    window: win,
  });
});

app.post('/api/survey/submit', (req, res) => {
  const win = windowState();
  if (!win.open) return res.status(403).json({ error: 'The survey window is closed.' });

  const b = req.body || {};
  const token = String(b.token || '');
  if (!token) return res.status(400).json({ error: 'Missing survey link token.' });

  // Validate answers.
  const values = {};
  for (const k of sliderKeys) {
    const v = Number(b[k]);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      return res.status(400).json({ error: 'Every slider needs a value from 1 to 10.' });
    }
    values[k] = v;
  }
  if (!blockerKeys.includes(b.blocker)) return res.status(400).json({ error: 'Pick a blocker.' });
  if (!processKeys.includes(b.process_improvement)) {
    return res.status(400).json({ error: 'Pick a process to improve.' });
  }
  if (b.blocker === 'other' && (typeof b.blocker_other !== 'string' || !b.blocker_other.trim())) {
    return res.status(400).json({ error: 'You picked Other as your blocker — tell us what it was.' });
  }
  if (b.process_improvement === 'other' && (typeof b.process_other !== 'string' || !b.process_other.trim())) {
    return res.status(400).json({ error: 'You picked Other as the process — tell us which one.' });
  }
  if (!motivationKeys.includes(b.motivation)) {
    return res.status(400).json({ error: 'Pick what motivates you.' });
  }
  if (typeof b.motivation_why !== 'string' || !b.motivation_why.trim()) {
    return res.status(400).json({ error: 'Tell us a little more about what motivates you.' });
  }
  const clip = (t) => (typeof t === 'string' ? t.trim().slice(0, MAX_TEXT) : '');
  const openText = clip(b.open_text);
  const concern = clip(b.concern) || null;
  const concernUrgent = concern && b.concern_urgent ? 1 : 0;
  const upwardOptIn = !!b.upward_opt_in;
  const upStart = upwardOptIn ? clip(b.upward_start) || null : null;
  const upStop = upwardOptIn ? clip(b.upward_stop) || null : null;
  const upContinue = upwardOptIn ? clip(b.upward_continue) || null : null;

  // ANONYMITY-CRITICAL TRANSACTION: the token is only flipped to used; the
  // response row is inserted with no reference to it. These two writes are
  // the only place the two tables are touched together, and no identifier
  // crosses between them.
  db.exec('BEGIN');
  try {
    const upd = db
      .prepare('UPDATE tokens SET used = 1 WHERE token_hash = ? AND cycle = ? AND used = 0')
      .run(sha256(token), win.cycle);
    if (upd.changes !== 1) {
      db.exec('ROLLBACK');
      const existing = db.prepare('SELECT used FROM tokens WHERE token_hash = ?').get(sha256(token));
      if (existing && existing.used) {
        return res.status(409).json({ error: 'This link has already been used. Responses cannot be edited after submission.' });
      }
      return res.status(403).json({ error: 'This survey link is not valid for the current cycle.' });
    }
    db.prepare(
      `INSERT INTO responses
         (cycle, q_heard, q_equipped, q_workload, q_communication, q_meetings, q_safe,
          blocker, process_improvement, open_text, upward_start, upward_stop, upward_continue,
          concern, concern_urgent, motivation, motivation_why, blocker_other, process_other)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      win.cycle,
      values.q_heard, values.q_equipped, values.q_workload,
      values.q_communication, values.q_meetings, values.q_safe,
      b.blocker, b.process_improvement, openText, upStart, upStop, upContinue,
      concern, concernUrgent, b.motivation, clip(b.motivation_why),
      b.blocker === 'other' ? clip(b.blocker_other) : null,
      b.process_improvement === 'other' ? clip(b.process_other) : null
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Both the response row and the now-used token need mirroring. Missing
  // 'responses' here left new answers unsaved to the Sheet until the 5-minute
  // safety net happened to run.
  queueSync('responses', 'tokens');
  res.json({ ok: true });
});

// ---------- admin API ----------

app.post('/api/admin/login', (req, res) => {
  const given = String(req.body?.password || '');
  const a = sha256(given);
  const b2 = sha256(ADMIN_PASSWORD);
  if (!crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b2))) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => res.json({ admin: isAdmin(req) }));

// Google sign-in: the browser sends a Google ID token; we verify it with
// Google, then check the email against the allowlist.
app.post('/api/admin/google-login', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(400).json({ error: 'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID to .env (see README).' });
    }
    const credential = String(req.body?.credential || '');
    if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!r.ok) return res.status(401).json({ error: 'Google rejected the sign-in.' });
    const info = await r.json();
    if (info.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Sign-in token belongs to a different app.' });
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      return res.status(401).json({ error: 'Google account email is not verified.' });
    }
    const email = String(info.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: `${email} is not on the admin list.` });
    }
    setSessionCookie(res);
    res.json({ ok: true, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const win = windowState();
  const cycle = String(req.query.cycle || win.cycle);
  if (!/^\d{4}-\d{2}$/.test(cycle)) return res.status(400).json({ error: 'Bad cycle.' });

  const agg = cycleAggregates(cycle);
  const visible = agg.count >= MIN_RESPONSES_TO_SHOW;

  const tokens = db
    .prepare('SELECT COUNT(*) AS issued, COALESCE(SUM(used), 0) AS used, COALESCE(SUM(opened), 0) AS opened FROM tokens WHERE cycle = ?')
    .get(cycle);
  // Participation denominators use PEOPLE, not links — duplicate/extra links
  // (resends, tests) must never inflate "team size" on the dashboard.
  const teamSize = db.prepare('SELECT COUNT(*) AS n FROM recipients').get().n;

  // Trend: per-slider averages for every past cycle with enough responses.
  const cycles = db
    .prepare('SELECT DISTINCT cycle FROM responses ORDER BY cycle')
    .all()
    .map((r) => r.cycle);
  const trends = Object.fromEntries(sliderKeys.map((k) => [k, []]));
  for (const c of cycles) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE cycle = ?').get(c).n;
    if (n < MIN_RESPONSES_TO_SHOW) continue;
    for (const k of sliderKeys) {
      const avg = db.prepare(`SELECT AVG(${k}) AS a FROM responses WHERE cycle = ?`).get(c).a;
      trends[k].push({ cycle: c, avg, n });
    }
  }

  res.json({
    cycle,
    window: win,
    minResponsesToShow: MIN_RESPONSES_TO_SHOW,
    tokens,
    teamSize,
    count: agg.count,
    visible,
    averages: visible ? agg.averages : null,
    blockers: visible ? agg.blockers : null,
    processes: visible ? agg.processes : null,
    comments: visible ? shuffle(agg.comments) : null,
    motivations: visible ? agg.motivations : null,
    motivationNotes: visible ? shuffle(agg.motivationNotes) : null,
    blockerOthers: visible ? shuffle(agg.blockerOthers) : null,
    processOthers: visible ? shuffle(agg.processOthers) : null,
    concerns: visible
      ? [...shuffle(agg.concerns.filter((c) => c.urgent)), ...shuffle(agg.concerns.filter((c) => !c.urgent))]
      : null,
    upward: visible
      ? { start: shuffle(agg.upward.start), stop: shuffle(agg.upward.stop), continue: shuffle(agg.upward.continue) }
      : null,
    trends,
    cycles,
    demoMode: DEMO_MODE,
  });
});

app.post('/api/admin/tokens', requireAdmin, (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: 'Count must be 1-200.' });
  }
  const cycle = currentCycle();
  const insert = db.prepare('INSERT INTO tokens (token_hash, cycle) VALUES (?, ?)');
  const raw = [];
  for (let i = 0; i < count; i++) {
    const t = crypto.randomBytes(16).toString('base64url');
    insert.run(sha256(t), cycle);
    raw.push(t);
  }
  // Raw tokens are returned ONCE and never stored — only their hashes are.
  queueSync('tokens');
  res.json({ cycle, tokens: raw });
});

app.post('/api/admin/window', requireAdmin, (req, res) => {
  const state = req.body?.state;
  if (![null, 'open', 'closed'].includes(state)) {
    return res.status(400).json({ error: "state must be 'open', 'closed', or null (automatic)." });
  }
  setOverride(currentCycle(), state);
  queueSync('window_overrides');
  res.json({ ok: true, window: windowState() });
});

// ---------- email invites ----------

app.get('/api/admin/recipients', requireAdmin, (req, res) => {
  const cycle = currentCycle();
  const counts = db
    .prepare('SELECT COUNT(*) AS issued, COALESCE(SUM(opened), 0) AS opened, COALESCE(SUM(used), 0) AS used FROM tokens WHERE cycle = ?')
    .get(cycle);
  res.json({
    // Per-person: only delivery status. Opened/submitted stay aggregate-only by design.
    recipients: db.prepare('SELECT email, name, name_source, role, last_sent_at, last_error FROM recipients ORDER BY COALESCE(name, email)').all(),
    sageConfigured: sageConfigured(),
    counts,
    mailConfigured: mailConfigured(),
    gmail: gmailStatus(),
    autoEmail: process.env.AUTO_EMAIL === 'true',
    lastSend: db.prepare('SELECT * FROM email_log WHERE cycle = ?').get(cycle) || null,
    teamSyncedAt: db.prepare("SELECT value FROM settings WHERE key = 'team_synced_at'").get()?.value || null,
    teamSource: teamSource(),
    sheetUrl: sheetUrl(),
  });
});

// Refresh the recipient list from the BigQuery roster. Existing rows keep
// their delivery status; people who left the roster are removed.
// `people` is [{ email, name, role, nameSource }] from src/team.js. Names and
// roles refresh on every sync, so a rename at the source lands here with no
// manual step. Anyone missing from the source is dropped.
function syncTeamRoster(people) {
  const emails = people.map((p) => p.email);
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT INTO recipients (email, name, name_source, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name, name_source = excluded.name_source, role = excluded.role`
    );
    for (const p of people) ins.run(p.email, p.name, p.nameSource, p.role);
    const del = db.prepare(
      `DELETE FROM recipients WHERE email NOT IN (${emails.map(() => '?').join(',')})`
    );
    del.run(...emails);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('team_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

app.post('/api/admin/recipients-sync', requireAdmin, async (req, res) => {
  try {
    const people = await fetchTeamEmails();
    syncTeamRoster(people);
    queueSync('recipients');
    res.json({ ok: true, count: people.length, source: teamSource() });
  } catch (e) {
    // 400, not 502 — a proxy would replace a 5xx body and hide the real reason
    // the directory sync failed (bad Sage key, bq not logged in, …).
    res.status(400).json({ error: e.message });
  }
});

// One-time Gmail connection: the browser's Google popup hands us a code, we
// swap it for a refresh token so the 27th can send without anyone present.
app.post('/api/admin/gmail-connect', requireAdmin, async (req, res) => {
  try {
    const { user } = await gmailExchangeCode(String(req.body?.code || ''));
    // Data mirror: make sure the "Team Pulse Data" spreadsheet exists and
    // push everything to it right away.
    let sheet = null;
    try {
      await ensureSpreadsheet();
      await syncAll();
      sheet = sheetUrl();
    } catch (e) {
      console.warn('[sheets] initial sync failed:', e.message);
    }
    res.json({ ok: true, user, sheetUrl: sheet });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/gmail-disconnect', requireAdmin, (req, res) => {
  gmailDisconnect();
  res.json({ ok: true });
});

// Record per-recipient delivery status after a send (delivery only, no tokens).
function recordSendResults(results) {
  const upd = db.prepare('UPDATE recipients SET last_sent_at = ?, last_error = ? WHERE email = ?');
  const now = new Date().toISOString();
  for (const r of results || []) upd.run(r.ok ? now : null, r.ok ? null : r.error || 'send failed', r.email);
}


app.post('/api/admin/email-test', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  try {
    const result = await sendInvites([email]);
    queueSync('tokens');
    // 400, not 502: a proxy (Cloudflare) replaces 5xx bodies with its own error
    // page, which would hide the actual reason the send failed.
    if (result.failed.length) return res.status(400).json({ error: `Send failed: ${result.failed[0].error}` });
    res.json({ ok: true, sent: result.sent });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/email-send', requireAdmin, async (req, res) => {
  const cycle = currentCycle();
  const already = db.prepare('SELECT * FROM email_log WHERE cycle = ?').get(cycle);
  if (already && !req.body?.force) {
    return res.status(409).json({
      error: `Invites for ${cycle} already went out on ${new Date(already.sent_at).toLocaleString()} (${already.sent_count} sent). Re-sending would give people second links.`,
    });
  }
  const emails = db.prepare('SELECT email FROM recipients').all().map((r) => r.email);
  if (!emails.length) return res.status(400).json({ error: 'No recipients saved yet.' });
  try {
    const result = await sendInvites(emails);
    recordSendResults(result.results);
    db.prepare(
      'INSERT INTO email_log (cycle, sent_at, sent_count) VALUES (?, ?, ?) ON CONFLICT(cycle) DO UPDATE SET sent_at = excluded.sent_at, sent_count = excluded.sent_count'
    ).run(cycle, new Date().toISOString(), result.sent);
    queueSync('tokens', 'email_log', 'recipients');
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rendered preview of the invite email (fake link, nothing minted).
app.get('/admin/email-preview', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  const { closes } = windowState();
  res.send(renderInviteEmail({ link: `${baseUrl()}/s/example-preview-link`, closes }));
});

// Auto-send: when the monthly window opens, invites go out once per cycle.
// Requires AUTO_EMAIL=true + a connected email (Gmail or SMTP); never runs in
// demo mode (the demo window is always "open" and would spam the roster).
//
// POSTMORTEM 2026-08-27 — the team received up to 3 copies of the first real
// invite. Two stacked bugs, both fixed below; do not simplify these away:
//  (a) the boot timer and the cron endpoint ran this function CONCURRENTLY,
//      and both passed the "already sent?" check before either recorded the
//      send → in-process lock + the INSERT-first atomic claim;
//  (b) the sent-record only reached the Sheet on a lazy debounce, and the
//      container was reaped before it flushed, so the next cold start
//      restored "never sent" and sent again → the claim is flushed to the
//      Sheet BEFORE any email goes out, and per-recipient last_sent_at
//      stamps cap the blast radius of any future failure to one copy each.
let emailTickBusy = false;
async function autoEmailTick() {
  if (process.env.AUTO_EMAIL !== 'true' || DEMO_MODE || !mailConfigured()) return;
  if (emailTickBusy) return;
  emailTickBusy = true;
  try {
    const win = windowState();
    if (!win.open) return;

    // Atomically claim this cycle. Exactly one invocation ever wins the
    // INSERT; everyone else sees changes === 0 and may only top up people
    // who verifiably never got their copy.
    const claimed = db.prepare(
      'INSERT OR IGNORE INTO email_log (cycle, sent_at, sent_count) VALUES (?, ?, 0)'
    ).run(win.cycle, new Date().toISOString()).changes > 0;

    const opensIso = new Date(win.opens).toISOString();
    const pendingEmails = () => db.prepare(
      'SELECT email FROM recipients WHERE last_sent_at IS NULL OR last_sent_at < ?'
    ).all(opensIso).map((r) => r.email);

    if (!claimed && !pendingEmails().length) return;

    // Make the claim durable BEFORE emailing: a cold boot restoring the
    // Sheet must see it, or it would send the whole roster again.
    queueSync('email_log');
    await flush();

    if (claimed) {
      // Freshen the roster right before the send, so joiners/leavers are
      // up to date. If the source is unreachable, use the stored list.
      try {
        syncTeamRoster(await fetchTeamEmails());
      } catch (e) {
        console.warn('[auto-email] roster sync failed, using stored list:', e.message);
      }
    }

    const emails = pendingEmails();
    if (!emails.length) return;
    const result = await sendInvites(emails);
    recordSendResults(result.results);
    db.prepare('UPDATE email_log SET sent_count = sent_count + ? WHERE cycle = ?')
      .run(result.sent, win.cycle);
    queueSync('tokens', 'email_log', 'recipients');
    await flush(); // durable before the cron request returns and the instance can be reaped
    console.log(`[auto-email] ${win.cycle}: sent ${result.sent} invites${result.failed.length ? `, ${result.failed.length} failed` : ''}`);
  } finally {
    emailTickBusy = false;
  }
}
// On a cron-managed host (Cloud Run + Cloud Scheduler) the endpoint is the
// ONLY trigger — internal timers on a scale-to-zero host are exactly what
// caused the triple-send. Self-hosted (no CRON_SECRET) keeps the timers.
if (!process.env.CRON_SECRET) {
  setInterval(() => autoEmailTick().catch((e) => console.error('[auto-email]', e.message)), 10 * 60 * 1000);
  setTimeout(() => autoEmailTick().catch((e) => console.error('[auto-email]', e.message)), 5000);
}

// Keep the roster current without anyone pressing a button: refresh it on
// startup (and hourly), on top of the refresh right before each send.
async function rosterRefresh() {
  try {
    syncTeamRoster(await fetchTeamEmails());
    queueSync('recipients');
  } catch (e) {
    console.warn('[roster] refresh failed, keeping stored list:', e.message);
  }
}
setTimeout(rosterRefresh, 3000);
setInterval(rosterRefresh, 60 * 60 * 1000);

// Scale-to-zero hosting (Cloud Run) parks the container between requests, so
// the in-process timers above cannot be trusted to fire on the 27th. Cloud
// Scheduler pings this endpoint instead; it does the same work, guarded by a
// shared secret. Set CRON_SECRET to enable it.
app.post('/api/cron/tick', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(404).json({ error: 'Cron endpoint is disabled (CRON_SECRET unset).' });
  const given = String(req.get('X-Cron-Secret') || '');
  if (given.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(401).json({ error: 'Bad cron secret.' });
  }
  await rosterRefresh();
  await autoEmailTick();
  res.json({ ok: true, ranAt: new Date().toISOString() });
});

// Phase 2 — peer feedback module, gated behind MANAGEMENT_SPONSORED.
app.use('/api/peer-feedback', createPeerRouter({ requireAdmin }));

// ---------- pages ----------

app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));
app.get('/p/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'peer.html')));
// Pages that don't declare their own icon (e.g. the raw email preview) fall
// back to /favicon.ico — answer it instead of 404ing on every such visit.
app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📊</text></svg>');
});

app.get('/thanks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'thanks.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/invites', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-invites.html')));

// The full multi-month report, rendered live from the database — the same page
// that gets written to the Mac, served inside the admin. It's a page, not an
// API, so an unauthenticated hit goes to the sign-in screen rather than a 401.
app.get('/admin/report', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  res.type('html').send(dashboardHtml({ inApp: true }));
});

// Data mirror: on a cold boot with an empty local DB (ephemeral hosting),
// restore everything from the Google Sheet before serving. A safety-net
// re-sync every 5 minutes catches any write path that missed a hook.
try {
  await restoreFromSheet();
} catch (e) {
  console.warn('[sheets] restore skipped:', e.message);
}
setInterval(() => queueSync(...MIRRORED_TABLES), 5 * 60 * 1000);

// The local copy is written on every boot too, so it exists even if nothing
// has been submitted since the app last started.
const boot = writeLocalExport();
if (boot) console.log(`[local-export] ${boot.months} month file(s) written to ${boot.dir}`);

app.listen(PORT, () => {
  console.log(`Team Pulse listening on http://localhost:${PORT}${DEMO_MODE ? ' (DEMO MODE — fake data, window forced open)' : ''}`);
});

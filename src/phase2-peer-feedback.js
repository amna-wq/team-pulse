import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from './db.js';
import { currentCycle, windowState } from './cycle.js';

// PHASE 2 — structured peer feedback. Start/stop/continue in WORDS about
// working with each colleague (including management), delivered PRIVATELY:
// the manager reads a per-person view and passes it to that individual.
// It never reaches the team summary or the Pulse dashboard.
//
// Gated behind MANAGEMENT_SPONSORED: enable only after leadership formally
// sponsors a 360 process, in writing. See README "Phase 2".
//
// Deliberate design constraints (do not "improve" these):
// - Text only. There are no numeric fields in peer_feedback, so per-person
//   scores, rankings or "most annoying" leaderboards are structurally
//   impossible to build on top of this data.
// - Giver is anonymous: rows store no author and no timestamp, and giver
//   tokens follow the same hash + used-flag model as the Pulse survey.
// - Reading is per-person and admin-only (the delivery channel), never a
//   cross-person comparison view.

const MANAGEMENT_SPONSORED = process.env.MANAGEMENT_SPONSORED === 'true';
const MAX_TEXT = 2000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clip = (t) => (typeof t === 'string' ? t.trim().slice(0, MAX_TEXT) : '');

export function createPeerRouter({ requireAdmin }) {
  const r = Router();

  r.use((req, res, next) => {
    if (!MANAGEMENT_SPONSORED) {
      return res.status(403).json({
        error:
          'Peer feedback module is disabled. It requires formal leadership sponsorship of a 360 process (MANAGEMENT_SPONSORED=true).',
      });
    }
    next();
  });

  // --- giver flow (token-gated, anonymous) ---

  r.get('/state', (req, res) => {
    const token = String(req.query.token || '');
    const win = windowState();
    const row = token
      ? db.prepare('SELECT used, cycle FROM peer_tokens WHERE token_hash = ?').get(sha256(token))
      : null;
    const people = db.prepare('SELECT id, name FROM peer_people WHERE active = 1 ORDER BY name').all();
    res.json({
      valid: !!row && row.cycle === win.cycle,
      used: row ? !!row.used : false,
      window: win,
      people,
    });
  });

  r.post('/submit', (req, res) => {
    const win = windowState();
    if (!win.open) return res.status(403).json({ error: 'The feedback window is closed.' });
    const token = String(req.body?.token || '');
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];

    const valid = new Set(
      db.prepare('SELECT id FROM peer_people WHERE active = 1').all().map((p) => p.id)
    );
    const rows = entries
      .map((e) => ({
        about_id: Number(e.about_id),
        start: clip(e.start),
        stop: clip(e.stop),
        continue: clip(e.continue),
      }))
      .filter((e) => valid.has(e.about_id) && (e.start || e.stop || e.continue));
    if (!rows.length) return res.status(400).json({ error: 'Write feedback for at least one colleague.' });

    // Same anonymity-critical shape as the Pulse submit: flip the token,
    // insert rows with no reference to it.
    db.exec('BEGIN');
    try {
      const upd = db
        .prepare('UPDATE peer_tokens SET used = 1 WHERE token_hash = ? AND cycle = ? AND used = 0')
        .run(sha256(token), win.cycle);
      if (upd.changes !== 1) {
        db.exec('ROLLBACK');
        return res.status(403).json({ error: 'This link is not valid (already used, or from a previous cycle).' });
      }
      const ins = db.prepare(
        'INSERT INTO peer_feedback (cycle, about_id, fb_start, fb_stop, fb_continue) VALUES (?, ?, ?, ?, ?)'
      );
      for (const e of rows) ins.run(win.cycle, e.about_id, e.start || null, e.stop || null, e.continue || null);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true });
  });

  // --- admin/delivery flow ---

  r.get('/roster', requireAdmin, (req, res) => {
    res.json({
      people: db.prepare('SELECT id, name, active FROM peer_people ORDER BY name').all(),
    });
  });

  r.post('/roster', requireAdmin, (req, res) => {
    const names = [...new Set(
      String(req.body?.names || '')
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean)
    )];
    if (!names.length || names.length > 100) {
      return res.status(400).json({ error: 'Provide 1-100 names, one per line.' });
    }
    const upsert = db.prepare(
      'INSERT INTO peer_people (name, active) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET active = 1'
    );
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE peer_people SET active = 0').run();
      for (const n of names) upsert.run(n.slice(0, 80));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, count: names.length });
  });

  r.post('/tokens', requireAdmin, (req, res) => {
    const count = Number(req.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      return res.status(400).json({ error: 'Count must be 1-200.' });
    }
    const cycle = currentCycle();
    const insert = db.prepare('INSERT INTO peer_tokens (token_hash, cycle) VALUES (?, ?)');
    const raw = [];
    for (let i = 0; i < count; i++) {
      const t = crypto.randomBytes(16).toString('base64url');
      insert.run(sha256(t), cycle);
      raw.push(t);
    }
    res.json({ cycle, tokens: raw });
  });

  // The delivery view: everything written ABOUT one person in one cycle.
  // The manager reads this and shares it privately with that person.
  r.get('/about/:id', requireAdmin, (req, res) => {
    const person = db.prepare('SELECT id, name FROM peer_people WHERE id = ?').get(Number(req.params.id));
    if (!person) return res.status(404).json({ error: 'Unknown person.' });
    const cycle = String(req.query.cycle || currentCycle());
    const rows = db
      .prepare('SELECT fb_start, fb_stop, fb_continue FROM peer_feedback WHERE about_id = ? AND cycle = ?')
      .all(person.id, cycle);
    res.json({
      person: person.name,
      cycle,
      start: rows.map((x) => x.fb_start).filter(Boolean),
      stop: rows.map((x) => x.fb_stop).filter(Boolean),
      continue: rows.map((x) => x.fb_continue).filter(Boolean),
    });
  });

  return r;
}

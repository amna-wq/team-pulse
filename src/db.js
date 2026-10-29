import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'pulse.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- ANONYMITY BY SCHEMA (hard rule — do not "improve" this):
  --
  -- 1. tokens stores ONLY a hash of each single-use link and a used flag.
  --    There is deliberately no used_at timestamp, no email, no name, no
  --    issued_to column. Nothing records WHO a token went to or WHEN it
  --    was redeemed.
  --
  -- 2. responses has NO reference to tokens, NO user column, and NO
  --    timestamp — only the cycle month. Even with full database access
  --    it is impossible to join an answer back to a person, or to
  --    correlate submission times against token usage.
  --
  -- 3. There is no per-person table anywhere in this app. The app cannot
  --    answer "who said this" or "who scored what" because that data is
  --    never written.

  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    cycle TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY,
    cycle TEXT NOT NULL,
    q_heard INTEGER NOT NULL CHECK (q_heard BETWEEN 1 AND 10),
    q_equipped INTEGER NOT NULL CHECK (q_equipped BETWEEN 1 AND 10),
    q_workload INTEGER NOT NULL CHECK (q_workload BETWEEN 1 AND 10),
    q_communication INTEGER NOT NULL CHECK (q_communication BETWEEN 1 AND 10),
    q_meetings INTEGER NOT NULL CHECK (q_meetings BETWEEN 1 AND 10),
    q_safe INTEGER NOT NULL CHECK (q_safe BETWEEN 1 AND 10),
    blocker TEXT NOT NULL,
    process_improvement TEXT NOT NULL,
    open_text TEXT NOT NULL DEFAULT '',
    upward_start TEXT,
    upward_stop TEXT,
    upward_continue TEXT,
    -- Private Concerns channel: can be about anyone or anything. Shown ONLY
    -- on the admin dashboard (Khalid + Amna), never on the team summary.
    -- Same anonymity as everything else: no author, no timestamp.
    concern TEXT,
    concern_urgent INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS summaries (
    cycle TEXT PRIMARY KEY,
    theme1 TEXT NOT NULL DEFAULT '',
    theme2 TEXT NOT NULL DEFAULT '',
    theme3 TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 0,
    published_at TEXT
  );

  -- Admin override for the survey window ('open' | 'closed'); absence = automatic
  -- schedule. until (ISO, optional) makes it a timed override that expires by itself.
  CREATE TABLE IF NOT EXISTS window_overrides (
    cycle TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    until TEXT
  );

  -- Email roster for monthly invites. ANONYMITY NOTE: this stores WHO gets
  -- invited, and the tokens table stores hashed links — but the raw token is
  -- generated, emailed, and discarded in one step (src/mailer.js). No table
  -- links an email address to a token or to a response.
  -- name/name_source come from the live Sage HR directory when it is
  -- configured; otherwise the name is derived from the address.
  CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE
  );

  -- One row per cycle once invites have gone out (stops double-sending).
  CREATE TABLE IF NOT EXISTS email_log (
    cycle TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL,
    sent_count INTEGER NOT NULL
  );

  -- Small key-value store (currently: the connected Gmail account's OAuth
  -- refresh token, so invites can send from an admin's own mailbox).
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- ===== PHASE 2: peer feedback (only served when MANAGEMENT_SPONSORED=true) =====
  -- This is the ONE place a person roster exists, and it belongs to the peer
  -- module only: Pulse survey responses never reference it. Feedback is text
  -- only (start/stop/continue) — no numeric fields exist, so scores, rankings
  -- and leaderboards of people are structurally impossible. Rows store no
  -- author and no timestamp: the giver stays anonymous, same model as Pulse.
  -- Delivery rule (enforced in the API): feedback about a person is visible
  -- only via the manager's per-person view, to be passed privately to that
  -- person. It never appears on the team summary or the Pulse dashboard.

  CREATE TABLE IF NOT EXISTS peer_people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS peer_tokens (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    cycle TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS peer_feedback (
    id INTEGER PRIMARY KEY,
    cycle TEXT NOT NULL,
    about_id INTEGER NOT NULL REFERENCES peer_people(id),
    fb_start TEXT,
    fb_stop TEXT,
    fb_continue TEXT
  );
`);

// Migration for databases created before the Concerns channel existed.
const respCols = db.prepare('PRAGMA table_info(responses)').all().map((c) => c.name);
if (!respCols.includes('concern')) {
  db.exec(`
    ALTER TABLE responses ADD COLUMN concern TEXT;
    ALTER TABLE responses ADD COLUMN concern_urgent INTEGER NOT NULL DEFAULT 0;
  `);
}

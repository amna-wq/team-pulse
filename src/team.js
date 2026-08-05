import { execFile } from 'node:child_process';

// Team list source of truth: Sage HR (live employee directory). Configure
// SAGEHR_SUBDOMAIN + SAGEHR_API_KEY in .env (Sage HR → Settings →
// Integrations → API access). Until those are set, we fall back to the
// BigQuery roster — which can go stale, so Sage is strongly preferred.

const { SAGEHR_SUBDOMAIN, SAGEHR_API_KEY } = process.env;
const BQ_PROJECT = process.env.BQ_PROJECT || 'newdatonproject';

export const sageConfigured = () => !!(SAGEHR_SUBDOMAIN && SAGEHR_API_KEY);

// TEAM_EMAILS entries are separated by ";" or newlines, and each one may be a
// bare address or the full form:  Full Name <email@host> | Job title
// Bare space/comma-separated lists still parse, so older .env files keep working.
const ENTRY_RX = /^\s*(?:(.*?)\s*<\s*([^>]+?)\s*>|([^|<>]+?))\s*(?:\|\s*(.*?))?\s*$/;
const manualList = () =>
  (process.env.TEAM_EMAILS || '')
    .split(/[;\n]+/)
    .flatMap((chunk) => (chunk.includes('<') ? [chunk] : chunk.split(/[\s,]+/)))
    .map((entry) => {
      const m = ENTRY_RX.exec(entry);
      if (!m) return null;
      const email = String(m[2] || m[3] || '').trim().toLowerCase();
      if (!EMAIL_RX.test(email)) return null;
      const name = (m[1] || '').trim();
      const role = (m[4] || '').trim();
      return { email, name, role };
    })
    .filter(Boolean);

export const teamSource = () =>
  sageConfigured() ? 'sagehr' : manualList().length ? 'manual' : 'bigquery';

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Only Sage HR knows real names. For every other source we derive a display
// name from the address ("muhammad.faiz@…" -> "Muhammad Faiz") and mark it
// derived, so the UI never passes a guess off as directory data.
export function nameFromEmail(email) {
  return String(email).split('@')[0]
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function fetchFromSage() {
  const base = `https://${SAGEHR_SUBDOMAIN}.sage.hr/api/employees`;
  const byEmail = new Map();
  let page = 1;
  let totalPages = 1;
  do {
    const r = await fetch(`${base}?page=${page}`, {
      headers: { 'X-Auth-Token': SAGEHR_API_KEY, Accept: 'application/json' },
    });
    if (r.status === 401) throw new Error('Sage HR rejected the API key (401) — regenerate it under Settings → Integrations → API access.');
    if (!r.ok) throw new Error(`Sage HR error (HTTP ${r.status}).`);
    const body = await r.json();
    for (const emp of body.data || []) {
      const email = String(emp.email || emp.work_email || '').trim().toLowerCase();
      if (!EMAIL_RX.test(email)) continue;
      const full = String(
        emp.full_name || [emp.first_name, emp.last_name].filter(Boolean).join(' ')
      ).trim();
      const role = String(emp.position?.name || emp.position || emp.job_title || '').trim();
      byEmail.set(email, { email, name: full || nameFromEmail(email), role, fromDirectory: !!full });
    }
    totalPages = body.meta?.total_pages || 1;
    page++;
  } while (page <= totalPages);
  if (!byEmail.size) throw new Error('Sage HR returned no employee emails.');
  return [...byEmail.values()];
}

// Fallback only — the BusinessOS roster table can lag behind reality.
const BQ_QUERY = `
  SELECT DISTINCT LOWER(email) AS email
  FROM \`newdatonproject.agent_config.team_roster\`
  WHERE REGEXP_CONTAINS(email, r'^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')
`;

function fetchFromBQ() {
  return new Promise((resolve, reject) => {
    execFile(
      'bq',
      ['query', `--project_id=${BQ_PROJECT}`, '--quiet', '--nouse_legacy_sql', '--format=json', '--max_rows=500', process.env.BQ_TEAM_QUERY || BQ_QUERY],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`BigQuery fallback failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        try {
          const rows = JSON.parse(stdout.trim());
          const emails = [...new Set(rows.map((r) => (r.email || '').trim().toLowerCase()).filter((e) => EMAIL_RX.test(e)))];
          if (!emails.length) return reject(new Error('BigQuery roster returned no emails.'));
          resolve(emails);
        } catch {
          reject(new Error('Could not parse BigQuery output — is the bq CLI logged in?'));
        }
      }
    );
  });
}

// Always returns [{ email, name, role, nameSource }]. nameSource records where
// the name actually came from — 'sagehr', 'roster' (typed into TEAM_EMAILS), or
// 'derived' (guessed from the address) — so the UI never passes a guess off as
// confirmed directory data.
export async function fetchTeamEmails() {
  if (sageConfigured()) {
    return (await fetchFromSage()).map((p) => ({
      email: p.email,
      name: p.name,
      role: p.role || '',
      nameSource: p.fromDirectory ? 'sagehr' : 'derived',
    }));
  }
  const manual = manualList();
  const rows = manual.length
    ? manual
    : [...new Set(await fetchFromBQ())].map((email) => ({ email, name: '', role: '' }));
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.email) && seen.add(r.email)).map((r) => ({
    email: r.email,
    name: r.name || nameFromEmail(r.email),
    role: r.role || '',
    nameSource: r.name ? 'roster' : 'derived',
  }));
}

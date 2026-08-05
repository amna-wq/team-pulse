import { execFile } from 'node:child_process';

// Team list source of truth: Sage HR (live employee directory). Configure
// SAGEHR_SUBDOMAIN + SAGEHR_API_KEY in .env (Sage HR → Settings →
// Integrations → API access). Until those are set, we fall back to the
// BigQuery roster — which can go stale, so Sage is strongly preferred.

const { SAGEHR_SUBDOMAIN, SAGEHR_API_KEY } = process.env;
const BQ_PROJECT = process.env.BQ_PROJECT || 'newdatonproject';

export const sageConfigured = () => !!(SAGEHR_SUBDOMAIN && SAGEHR_API_KEY);
const manualList = () =>
  (process.env.TEAM_EMAILS || '')
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RX.test(e));
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
      byEmail.set(email, { email, name: full || nameFromEmail(email), fromDirectory: !!full });
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

// Always returns [{ email, name, fromDirectory }] — Sage HR is the only
// source that supplies real names; the others get a derived one.
export async function fetchTeamEmails() {
  if (sageConfigured()) return fetchFromSage();
  const derive = (emails) =>
    [...new Set(emails)].map((email) => ({ email, name: nameFromEmail(email), fromDirectory: false }));
  const manual = manualList();
  if (manual.length) return derive(manual);
  return derive(await fetchFromBQ());
}

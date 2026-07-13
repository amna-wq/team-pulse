import { db } from './db.js';

// Shared Google OAuth plumbing for Gmail (invites) and Sheets (data mirror).
// The refresh token comes from the one-time "Connect Google" click on the
// dashboard; on ephemeral hosts (HF Spaces etc.) set GOOGLE_REFRESH_TOKEN as
// an env secret instead, since the local settings table dies with the disk.
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
export const delSetting = (k) => db.prepare('DELETE FROM settings WHERE key = ?').run(k);

export const googleAvailable = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
export const refreshTokenValue = () => GOOGLE_REFRESH_TOKEN || getSetting('gmail_refresh_token');
export const googleConnected = () => googleAvailable() && !!refreshTokenValue();

let cache = { token: null, exp: 0 };
export const clearTokenCache = () => { cache = { token: null, exp: 0 }; };

export async function accessToken() {
  if (cache.token && Date.now() < cache.exp - 60_000) return cache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshTokenValue(),
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Google session expired (${d.error_description || d.error}) — reconnect Google on the dashboard.`);
  cache = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return cache.token;
}

export async function exchangeCode(code) {
  if (!googleAvailable()) {
    throw new Error('Add GOOGLE_CLIENT_SECRET to .env first (same Google Cloud credentials page as the client ID).');
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Google rejected the connection: ${d.error_description || d.error}`);
  if (!d.refresh_token) {
    throw new Error('Google did not return a long-lived token. Remove Team Pulse at myaccount.google.com/permissions and connect again.');
  }
  let email = null;
  if (d.id_token) {
    try {
      email = JSON.parse(Buffer.from(d.id_token.split('.')[1], 'base64url').toString()).email || null;
    } catch { /* cosmetic only */ }
  }
  setSetting('gmail_refresh_token', d.refresh_token);
  if (email) setSetting('gmail_user', email);
  clearTokenCache();
  return { user: email };
}

export function disconnect() {
  delSetting('gmail_refresh_token');
  delSetting('gmail_user');
  clearTokenCache();
}

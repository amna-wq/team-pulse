import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { db } from './db.js';
import { currentCycle, windowState } from './cycle.js';

// Two ways to send, checked in this order:
//  1. Connected Gmail (recommended — zero mail-server access needed): an admin
//     clicks "Connect Gmail" once; we keep an OAuth refresh token (gmail.send
//     scope only) and send through their own account via the Gmail API.
//  2. Classic SMTP via .env, for whenever a real sending account exists.
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL,
        GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const delSetting = (k) => db.prepare('DELETE FROM settings WHERE key = ?').run(k);

export function smtpConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}
export function gmailAvailable() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}
export function gmailStatus() {
  return {
    available: gmailAvailable(),
    connected: gmailAvailable() && !!getSetting('gmail_refresh_token'),
    user: getSetting('gmail_user') || null,
  };
}
export function mailConfigured() {
  return smtpConfigured() || gmailStatus().connected;
}

// --- Gmail OAuth plumbing ---

let gmailTok = { token: null, exp: 0 };

export async function gmailExchangeCode(code) {
  if (!gmailAvailable()) {
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
  gmailTok = { token: null, exp: 0 };
  return { user: email };
}

export function gmailDisconnect() {
  delSetting('gmail_refresh_token');
  delSetting('gmail_user');
  gmailTok = { token: null, exp: 0 };
}

async function gmailAccessToken() {
  if (gmailTok.token && Date.now() < gmailTok.exp - 60_000) return gmailTok.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: getSetting('gmail_refresh_token'),
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Gmail session expired (${d.error_description || d.error}) — reconnect Gmail on the dashboard.`);
  gmailTok = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return gmailTok.token;
}

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function buildMime({ from, to, subject, text, html }) {
  const boundary = 'tp-' + crypto.randomBytes(8).toString('hex');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function gmailSend(msg) {
  const token = await gmailAccessToken();
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(buildMime(msg)) }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error?.message || `Gmail send failed (HTTP ${r.status})`);
  }
}

// --- SMTP fallback ---

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

function fromAddress() {
  if (MAIL_FROM) return MAIL_FROM;
  const g = gmailStatus();
  if (g.connected && g.user) return `Team Pulse <${g.user}>`;
  return SMTP_USER;
}

async function deliver(msg) {
  if (gmailStatus().connected) return gmailSend(msg);
  if (smtpConfigured()) {
    return getTransporter().sendMail({ from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
  }
  throw new Error('Email is not connected yet. Click "Connect Gmail" on the dashboard (or set SMTP_* in .env).');
}

export function baseUrl() {
  return (APP_URL || 'http://localhost:8080').replace(/\/$/, '');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Mint a fresh single-use token. The raw value exists only in the email we
// are about to send; the DB keeps the hash.
function mintToken(cycle) {
  const t = crypto.randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO tokens (token_hash, cycle) VALUES (?, ?)').run(sha256(t), cycle);
  return t;
}

// Cute animated HTML email. Email-client reality: layout is table-based with
// inline styles (works everywhere); the floating emoji + fade-in animations
// run in Apple Mail / iOS Mail and degrade to a static (still cute) email in
// Gmail and Outlook, which ignore <style> keyframes.
export function renderInviteEmail({ link, closes }) {
  const closesText = closes
    ? new Date(closes).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'long' })
    : null;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @keyframes tp-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
  @keyframes tp-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @keyframes tp-wiggle { 0%,100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }
  .tp-bob { animation: tp-bob 3s ease-in-out infinite; display: inline-block; }
  .tp-card { animation: tp-rise .7s cubic-bezier(.22,1,.36,1) both; }
  .tp-card2 { animation: tp-rise .7s cubic-bezier(.22,1,.36,1) .15s both; }
  .tp-btn:hover { filter: brightness(1.08); }
  .tp-badge { animation: tp-wiggle 2.6s ease-in-out infinite; display: inline-block; }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f8f6f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f6f2;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

    <tr><td align="center" style="padding-bottom:18px;">
      <span class="tp-bob" style="font-size:44px;">📮</span>
      <h1 style="margin:10px 0 0;font-family:'Baloo 2','Trebuchet MS',Arial,sans-serif;font-size:27px;color:#34323b;">
        Your monthly pulse is open!
      </h1>
      <p style="margin:6px 0 0;font-family:'Nunito',Arial,sans-serif;font-size:15px;color:#6d6b78;">
        3 minutes · totally anonymous · closes in 48 hours
      </p>
    </td></tr>

    <tr><td class="tp-card" style="background-color:#fffefc;border:1px solid #e6e5ef;border-radius:22px;padding:28px;box-shadow:0 10px 30px rgba(84,87,214,0.08);">
      <p style="margin:0 0 14px;font-family:'Nunito',Arial,sans-serif;font-size:16px;line-height:1.6;color:#34323b;">
        Hey! 👋 It's that time of the month — tell us how work <em>actually</em> feels right now.
        Workload, meetings, tools, anything bothering you. Management reads every single word.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;background-color:#edeafb;border-radius:14px;width:100%;">
        <tr><td style="padding:12px 16px;font-family:'Nunito',Arial,sans-serif;font-size:13.5px;line-height:1.55;color:#4a4860;">
          🔒 <strong>This link is yours alone and 100% anonymous.</strong> Once you submit, it's only
          marked "used" — nothing connects it to your answers. Ever.
        </td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:8px auto 6px;">
        <tr><td align="center" style="border-radius:999px;background:linear-gradient(135deg,#8a8df2,#5457d6);background-color:#5457d6;">
          <a class="tp-btn" href="${link}" style="display:inline-block;padding:14px 34px;font-family:'Baloo 2','Trebuchet MS',Arial,sans-serif;font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">
            Take the pulse&nbsp;&nbsp;→
          </a>
        </td></tr>
      </table>
      ${closesText ? `<p style="margin:12px 0 0;text-align:center;font-family:'Nunito',Arial,sans-serif;font-size:13px;color:#9a97a6;">
        <span class="tp-badge">⏰</span> Closes ${closesText}
      </p>` : ''}
    </td></tr>

    <tr><td class="tp-card2" style="padding-top:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" align="center" style="background-color:#e2eefc;border-radius:16px;padding:12px 6px;font-family:'Nunito',Arial,sans-serif;font-size:12.5px;color:#4a4860;">🎯<br><strong>6 sliders</strong></td>
          <td width="8">&nbsp;</td>
          <td width="33%" align="center" style="background-color:#dcf3e7;border-radius:16px;padding:12px 6px;font-family:'Nunito',Arial,sans-serif;font-size:12.5px;color:#4a4860;">💬<br><strong>Say anything</strong></td>
          <td width="8">&nbsp;</td>
          <td width="33%" align="center" style="background-color:#ffeadb;border-radius:16px;padding:12px 6px;font-family:'Nunito',Arial,sans-serif;font-size:12.5px;color:#4a4860;">🕵️<br><strong>Zero tracking</strong></td>
        </tr>
      </table>
    </td></tr>

    <tr><td align="center" style="padding-top:20px;font-family:'Nunito',Arial,sans-serif;font-size:12px;color:#9a97a6;line-height:1.6;">
      Team Pulse · anonymous by design<br>
      Your voice shapes next month's one committed action ✊
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

function inviteText(link, closes) {
  return `Your monthly Team Pulse is open!\n\n3 minutes, totally anonymous. This single-use link is yours alone — once submitted it is only marked "used", nothing connects it to your answers.\n\nTake the pulse: ${link}\n${closes ? `\nCloses: ${new Date(closes).toLocaleString()}` : ''}`;
}

// Send one invite per address. The token→email pairing lives only inside this
// loop and is gone when it finishes — deliberately not logged, not stored.
// Per-email results carry ONLY delivery status (sent/failed), never the token.
export async function sendInvites(emails) {
  const cycle = currentCycle();
  const { closes } = windowState();
  const failed = [];
  const results = [];
  let sent = 0;
  for (const email of emails) {
    const raw = mintToken(cycle);
    const link = `${baseUrl()}/s/${raw}`;
    try {
      await deliver({
        from: fromAddress(),
        to: email,
        subject: '📮 Your monthly Team Pulse is open (3 min, anonymous)',
        html: renderInviteEmail({ link, closes }),
        text: inviteText(link, closes),
      });
      sent++;
      results.push({ email, ok: true });
    } catch (e) {
      // The email never went out, so retire its token — keeps "links sent" honest.
      db.prepare('DELETE FROM tokens WHERE token_hash = ? AND used = 0').run(sha256(raw));
      failed.push({ email, error: e.message });
      results.push({ email, ok: false, error: e.message });
    }
  }
  return { sent, failed, results };
}

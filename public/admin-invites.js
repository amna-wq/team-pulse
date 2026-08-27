const $ = (id) => document.getElementById(id);
let meta, data;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function init() {
  meta = await api('/api/meta');
  if (meta.demoMode) $('demo-banner').classList.remove('hidden');
  const { admin } = await api('/api/admin/session');
  if (!admin) { location.href = '/admin'; return; }
  $('email-test').addEventListener('click', sendTestEmail);
  $('email-preview').addEventListener('click', () => window.open('/admin/email-preview', '_blank'));
  $('rcpt-filter').addEventListener('input', renderRecipients);
  render();
}

async function render() {
  data = await api('/api/admin/recipients');
  $('test-email').value = $('test-email').value || 'amna@k-brands.com';
  renderSetup();
  renderTiles();
  renderRecipients();
}

// ---- delivery setup: how sending is wired up ----

function setupRow({ state, title, detail, action }) {
  return `<div class="setup-row">
    <span class="setup-dot ${state}"></span>
    <div class="setup-text">
      <div class="setup-title">${title}</div>
      <div class="setup-detail">${detail}</div>
    </div>
    <div class="setup-action">${action || ''}</div>
  </div>`;
}

function renderSetup() {
  const d = data;
  const rows = [];

  // a) can we send at all?
  if (d.mailConfigured && d.gmail.connected) {
    rows.push(setupRow({
      state: 'ok', title: 'Email sending is live',
      detail: `Invites send from ${esc(d.gmail.user || 'your connected Gmail')} — no mail-server access needed.`,
      action: '<button class="btn-sm secondary" id="gmail-disconnect">Disconnect</button>',
    }));
  } else if (d.mailConfigured) {
    rows.push(setupRow({ state: 'ok', title: 'Email sending is live', detail: 'Sending over SMTP.' }));
  } else if (d.gmail.available) {
    rows.push(setupRow({
      state: 'bad', title: 'Email is not connected yet',
      detail: 'Connect once and invites send themselves from your own Google account.',
      action: '<button id="gmail-connect">Connect Google</button>',
    }));
  } else {
    rows.push(setupRow({
      state: 'bad', title: 'Email is not connected yet',
      detail: 'One value is missing: paste <code>GOOGLE_CLIENT_SECRET</code> into <code>.env</code>, restart the app, then connect.',
    }));
  }

  $('setup-rows').innerHTML = rows.join('');
  const dis = $('gmail-disconnect');
  if (dis) dis.addEventListener('click', disconnectGmail);
  const con = $('gmail-connect');
  if (con) con.addEventListener('click', connectGoogle);
}

// ---- 2. this month at a glance ----

function renderTiles() {
  const c = data.counts;
  // Percentages are of PEOPLE (roster), not of links — duplicates/tests
  // would otherwise skew them.
  const team = data.recipients.length || c.issued;
  const openPct = team ? Math.min(100, Math.round((100 * c.opened) / team)) : 0;
  const usedPct = team ? Math.min(100, Math.round((100 * c.used) / team)) : 0;
  const pctColor = (p) => (p >= 70 ? '#2b8a3e' : p >= 40 ? '#e0862f' : '#d6453d');
  // Tokens can exist without an email_log row (seeded demo data, manual mints),
  // so never claim "nothing sent" while links are outstanding.
  const sentNote = data.lastSend
    ? `last send ${new Date(data.lastSend.sent_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : c.issued ? 'no email send logged this month'
    : 'nothing sent this month yet';

  $('invite-tiles').innerHTML = `
    <div class="tile" style="border-top-color:var(--navy-2)">
      <div class="label">Links sent</div>
      <div class="value" data-count="${c.issued}">0</div>
      <div class="note">${sentNote}</div></div>
    <div class="tile" style="border-top-color:${c.issued ? pctColor(openPct) : 'var(--baseline)'}">
      <div class="label">Opened</div>
      <div class="value" style="color:${c.issued ? pctColor(openPct) : 'var(--ink)'}" data-count="${c.opened}">0</div>
      <div class="note">${c.issued ? openPct + '% of the team' : 'waiting on the first send'}</div></div>
    <div class="tile" style="border-top-color:${c.issued ? pctColor(usedPct) : 'var(--baseline)'}">
      <div class="label">Submitted</div>
      <div class="value" style="color:${c.issued ? pctColor(usedPct) : 'var(--ink)'}" data-count="${c.used}">0</div>
      <div class="note">${c.issued ? usedPct + '% of the team completed the survey' : '—'}</div></div>`;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of document.querySelectorAll('#invite-tiles [data-count]')) {
    const target = Number(el.dataset.count);
    if (reduced || target === 0) { el.textContent = target; continue; }
    const t0 = performance.now(), dur = 700;
    const tick = (t2) => {
      const p = Math.min(1, (t2 - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ---- 3. recipients ----
// Per-person shows DELIVERY only (sent / failed). Whether someone opened or
// submitted stays aggregate-only — that's the anonymity promise.

function renderRecipients() {
  const all = data.recipients;
  const q = $('rcpt-filter').value.trim().toLowerCase();
  const list = q
    ? all.filter((r) => `${r.name || ''} ${r.role || ''} ${r.email}`.toLowerCase().includes(q))
    : all;

  const failed = all.filter((r) => r.last_error).length;
  const sent = all.filter((r) => !r.last_error && r.last_sent_at).length;
  $('rcpt-count').textContent = all.length
    ? `· ${all.length} people${sent ? ` · ${sent} sent` : ''}${failed ? ` · ${failed} failed` : ''}`
    : '';

  if (!all.length) {
    $('recipient-status').innerHTML =
      '<p class="hint">No team loaded yet — the roster syncs itself on startup and before every monthly send.</p>';
    return;
  }
  if (!list.length) {
    $('recipient-status').innerHTML = `<p class="hint">Nobody matches “${esc(q)}”.</p>`;
    return;
  }

  const cell = (r) => {
    if (r.last_error) return `<span class="chip bad" title="${esc(r.last_error)}">Failed</span>`;
    if (r.last_sent_at) {
      const when = new Date(r.last_sent_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `<span class="chip ok">Sent ${when}</span>`;
    }
    return '<span class="chip idle">Not sent yet</span>';
  };

  const initials = (n) => n.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  $('recipient-status').innerHTML = `<div class="table-scroll">
    <table class="status-table">
      <thead><tr><th>Name</th><th>Role</th><th>Email</th><th style="width:150px">Invite</th></tr></thead>
      <tbody>${list.map((r) => {
        const name = r.name || r.email.split('@')[0];
        return `<tr>
          <td><div class="person">
            <span class="avatar-i">${esc(initials(name))}</span>
            <span>${esc(name)}${r.name_source === 'derived'
              ? ' <span class="hint" style="display:inline" title="No name on file — derived from the email address">(derived)</span>'
              : ''}</span>
          </div></td>
          <td class="mono-cell">${esc(r.role || '—')}</td>
          <td class="mono-cell">${esc(r.email)}</td>
          <td>${cell(r)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` +
    (failed ? `<div class="banner err" style="margin-bottom:0">${failed} invite${failed > 1 ? 's' : ''} failed to send — hover a “Failed” chip for the reason.</div>` : '');
}

// ---- google connect / disconnect ----

function connectGoogle() {
  if (!window.google?.accounts?.oauth2) return emailMsg('Google script not loaded — check your connection and refresh.', true);
  google.accounts.oauth2.initCodeClient({
    client_id: meta.googleClientId,
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file openid email',
    ux_mode: 'popup',
    callback: async (resp) => {
      if (!resp.code) return emailMsg('Google connection was cancelled.', true);
      try {
        const r = await api('/api/admin/gmail-connect', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: resp.code }),
        });
        emailMsg(`Google connected${r.user ? ' as ' + r.user : ''} — invites send themselves and results mirror to your Sheet.`);
        render();
      } catch (e) {
        emailMsg(e.message, true);
      }
    },
  }).requestCode();
}

async function disconnectGmail() {
  await api('/api/admin/gmail-disconnect', { method: 'POST' });
  render();
}

// ---- test send ----

function emailMsg(text, isErr) {
  const m = $('email-msg');
  m.textContent = text;
  m.className = 'banner ' + (isErr ? 'err' : 'info');
  m.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function sendTestEmail() {
  const btn = $('email-test');
  const to = $('test-email').value.trim();
  if (!to) return emailMsg('Type an address to send the test to.', true);
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('/api/admin/email-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: to }),
    });
    emailMsg(`Test invite sent to ${to} — check the inbox.`);
    render();
  } catch (e) {
    emailMsg(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send test';
  }
}

init();

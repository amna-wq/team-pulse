const $ = (id) => document.getElementById(id);
let meta;

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
  $('team-sync').addEventListener('click', syncTeam);
  $('email-test').addEventListener('click', sendTestEmail);
  renderEmail();
}

// ---- invites ----

async function renderEmail() {
  const d = await api('/api/admin/recipients');
  $('test-email').value = $('test-email').value || 'amna@k-brands.com';
  const srcLabel = d.teamSource === 'sagehr' ? 'Sage HR' : 'BigQuery roster (stale fallback — add SAGEHR_SUBDOMAIN + SAGEHR_API_KEY to .env for the live directory)';
  $('team-sync-note').textContent =
    `${d.recipients.length ? d.recipients.length + ' people · ' : ''}source: ${srcLabel}` +
    (d.teamSyncedAt ? ` · synced ${new Date(d.teamSyncedAt).toLocaleString()}` : '') +
    ' · auto-refreshes before every monthly send';

  const bits = [];
  if (d.mailConfigured) {
    bits.push(d.gmail.connected
      ? `✅ Email is live — sending from ${d.gmail.user || 'the connected Gmail'}.`
      : '✅ Email is live (SMTP).');
  } else if (!d.gmail.available) {
    bits.push('⚠️ One value missing: paste GOOGLE_CLIENT_SECRET into .env (same Google Cloud page where the client ID came from), restart, then click Connect Gmail.');
  } else {
    bits.push('⚠️ Almost there — click "Connect Gmail" once and invites will send themselves from your own account. No mail-server access needed.');
  }
  bits.push(d.autoEmail
    ? 'Invites go out automatically when the window opens on the 27th.'
    : '⚠️ Auto-send is OFF. Set AUTO_EMAIL=true in .env so the 27th happens by itself.');
  if (d.lastSend) bits.push(`This month: ${d.lastSend.sent_count} invites sent ${new Date(d.lastSend.sent_at).toLocaleString()}.`);
  $('mail-status').textContent = bits.join(' ');

  // Counts row first — the disconnect button appends into it below.
  const c = d.counts;
  $('invite-counts').innerHTML = c.issued
    ? `<span class="pill">📤 ${c.issued} links sent</span>
       <span class="pill">👀 ${c.opened} opened</span>
       <span class="pill open">✅ ${c.used} submitted</span>
       <span class="hint" style="align-self:center">opened and submitted are totals only, never per person</span>`
    : '<span class="hint">No links sent this month yet.</span>';

  // Gmail connect / disconnect controls. Connected: small filled button on
  // the right of the counts row. Not connected: big call-to-action.
  const area = $('gmail-area');
  const oldDisconnect = document.getElementById('gmail-disconnect');
  if (oldDisconnect) oldDisconnect.remove();
  if (d.gmail.connected) {
    area.innerHTML = '';
    const btn = document.createElement('button');
    btn.id = 'gmail-disconnect';
    btn.className = 'btn-sm push-right';
    btn.textContent = 'Disconnect Gmail';
    btn.title = d.gmail.user ? `Connected as ${d.gmail.user}` : 'Connected';
    if (d.sheetUrl) {
      const a = document.createElement('a');
      a.href = d.sheetUrl;
      a.target = '_blank';
      a.textContent = '📊 Results sheet';
      a.style.cssText = 'align-self:center;font-weight:700;margin-left:auto';
      btn.classList.remove('push-right');
      $('invite-counts').appendChild(a);
    }
    btn.addEventListener('click', async () => {
      await api('/api/admin/gmail-disconnect', { method: 'POST' });
      renderEmail();
    });
    $('invite-counts').appendChild(btn);
  } else if (d.gmail.available) {
    area.innerHTML = '<button id="gmail-connect">🔗 Connect Google — sends invites + saves results to your Sheet</button>';
    area.querySelector('#gmail-connect').addEventListener('click', () => {
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
            emailMsg(`Google connected${r.user ? ' as ' + r.user : ''} — invites send themselves, results mirror to your Sheet. 🎉`);
            renderEmail();
          } catch (e) {
            emailMsg(e.message, true);
          }
        },
      }).requestCode();
    });
  } else {
    area.innerHTML = '';
  }

  $('recipient-status').innerHTML = d.recipients.length
    ? `<table class="status-table">
        <thead><tr><th>Team member</th><th>Invite</th></tr></thead>
        <tbody>${d.recipients.map((r) => `
          <tr>
            <td>${esc(r.email)}</td>
            <td>${r.last_error
              ? `<span class="status-bad">⚠️ failed: ${esc(r.last_error)}</span>`
              : r.last_sent_at
                ? `<span class="status-ok">✅ sent ${new Date(r.last_sent_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>`
                : '<span class="hint">not sent yet</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>`
    : '<p class="hint">No team loaded yet — hit "Sync team from BigQuery".</p>';
}

async function syncTeam() {
  const btn = $('team-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const { count } = await api('/api/admin/recipients-sync', { method: 'POST' });
    emailMsg(`Synced ${count} people. ✨`);
    renderEmail();
  } catch (e) {
    emailMsg(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Sync team';
  }
}

function emailMsg(text, isErr) {
  const m = $('email-msg');
  m.textContent = text;
  m.className = 'banner ' + (isErr ? 'err' : 'info');
}


async function sendTestEmail() {
  try {
    await api('/api/admin/email-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('test-email').value }),
    });
    emailMsg(`Test invite sent to ${$('test-email').value}. Check the inbox! 📬`);
  } catch (e) {
    emailMsg(e.message, true);
  }
}



init();

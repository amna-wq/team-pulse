const $ = (id) => document.getElementById(id);
let meta, data;

const monthName = (cycle) => {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
};

// score color: low reads red, middle amber, high green (matches the survey sliders)
const scoreColor = (v) => (v <= 3 ? '#d6453d' : v <= 6 ? '#e0862f' : v <= 8 ? '#6aa63c' : '#2b8a3e');

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function init() {
  meta = await api('/api/meta');
  if (meta.demoMode) $('demo-banner').classList.remove('hidden');
  const { admin } = await api('/api/admin/session');
  if (admin) return showDash();
  document.body.classList.add('login-mode');
  $('login').classList.remove('hidden');
  $('login-btn').addEventListener('click', passwordLogin);
  $('pw').addEventListener('keydown', (e) => e.key === 'Enter' && passwordLogin());
  initGoogleButton();
}

// ---- sign in ----

function initGoogleButton(attempt = 0) {
  if (!meta.googleClientId) {
    $('gsi-unavailable').textContent = 'Google sign-in is not configured yet (GOOGLE_CLIENT_ID missing in .env). Use the password fallback below.';
    $('gsi-unavailable').classList.remove('hidden');
    return;
  }
  if (!window.google?.accounts?.id) {
    if (attempt < 20) return void setTimeout(() => initGoogleButton(attempt + 1), 250);
    $('gsi-unavailable').textContent = 'Google sign-in script did not load. Check your connection or use the password fallback.';
    $('gsi-unavailable').classList.remove('hidden');
    return;
  }
  google.accounts.id.initialize({
    client_id: meta.googleClientId,
    callback: async ({ credential }) => {
      try {
        await api('/api/admin/google-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential }),
        });
        $('login').classList.add('hidden');
        showDash();
      } catch (e) {
        $('login-err').textContent = e.message;
        $('login-err').classList.remove('hidden');
      }
    },
  });
  google.accounts.id.renderButton($('gsi-btn'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
}

async function passwordLogin() {
  try {
    await api('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }),
    });
    $('login').classList.add('hidden');
    showDash();
  } catch (e) {
    $('login-err').textContent = e.message;
    $('login-err').classList.remove('hidden');
  }
}

// ---- dashboard ----

async function showDash(cycle) {
  document.body.classList.remove('login-mode');
  data = await api('/api/admin/overview' + (cycle ? `?cycle=${cycle}` : ''));
  $('dash').classList.remove('hidden');
  renderHeader();
  renderTiles();
  renderResults();
  renderSummaryView();
  renderEmail();
  wireOnce();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  $('cycle-select').addEventListener('change', (e) => showDash(e.target.value));
  $('team-sync').addEventListener('click', syncTeam);
  $('email-test').addEventListener('click', sendTestEmail);
}

function renderHeader() {
  const sel = $('cycle-select');
  const all = [...new Set([...data.cycles, data.window.cycle])].sort().reverse();
  sel.innerHTML = all.map((c) => `<option value="${c}" ${c === data.cycle ? 'selected' : ''}>${monthName(c)}</option>`).join('');

  const w = data.window;
  const pill = $('window-pill');
  pill.textContent = w.open ? 'Survey open' : 'Survey closed';
  pill.classList.toggle('open', w.open);
  const opens = new Date(w.opens);
  $('window-detail').textContent = w.open
    ? `closes ${new Date(w.closes).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
    : `automatic: opens the 27th at 9:00 for 48 hours (next: ${opens.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})`;
}

function renderTiles() {
  const t = data.tokens;
  const pct = t.issued ? Math.round((100 * t.used) / t.issued) : null;
  $('tiles').innerHTML = `
    <div class="tile"><div class="label">Responses · ${monthName(data.cycle)}</div>
      <div class="value" data-count="${data.count}">0</div>
      <div class="note">shown only when ≥ ${data.minResponsesToShow} (anonymity floor)</div></div>
    <div class="tile"><div class="label">Participation</div>
      <div class="value"><span data-count="${t.used}">0</span><span style="font-size:16px;color:var(--muted)"> / ${t.issued}</span></div>
      <div class="note">${pct == null ? 'no links sent yet' : pct + '% submitted · ' + t.opened + ' opened their link'}</div></div>
    <div class="tile"><div class="label">Months of data</div>
      <div class="value" data-count="${data.cycles.length}">0</div>
      <div class="note">trend history</div></div>`;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const el of document.querySelectorAll('#tiles [data-count]')) {
    const target = Number(el.dataset.count);
    if (reduced || target === 0) { el.textContent = target; continue; }
    const t0 = performance.now(), dur = 750;
    const tick = (t2) => {
      const p = Math.min(1, (t2 - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ---- charts ----

function hbar(label, value, max, valText, deltaHtml = '', color = '') {
  const style = `width:${max ? (100 * value) / max : 0}%${color ? `;background:${color}` : ''}`;
  return `<div class="hbar-row">
    <div class="hbar-label">${label}</div>
    <div class="hbar-track"><div class="hbar-fill" style="${style}"></div></div>
    <div class="hbar-val">${valText}${deltaHtml}</div>
  </div>`;
}

function renderResults() {
  const few = data.count < data.minResponsesToShow;
  $('too-few').classList.toggle('hidden', !few);
  $('results').classList.toggle('hidden', few);
  if (few) {
    $('too-few-msg').textContent =
      `${monthName(data.cycle)} has ${data.count} response(s). Aggregates unlock at ` +
      `${data.minResponsesToShow} to protect anonymity. With fewer, averages get close to individual answers.`;
    return;
  }

  // Average per slider, score-colored, with delta vs previous month.
  $('avg-bars').innerHTML = meta.sliders.map((s) => {
    const avg = data.averages[s.key];
    const t = data.trends[s.key];
    const idx = t.findIndex((p) => p.cycle === data.cycle);
    const prev = idx > 0 ? t[idx - 1].avg : null;
    let delta = '';
    if (prev != null) {
      const d = avg - prev;
      if (Math.abs(d) >= 0.05) {
        delta = `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(1)}</span>`;
      }
    }
    return hbar(s.label, avg, 10, avg.toFixed(1), delta, scoreColor(avg));
  }).join('');

  $('sparks').innerHTML = meta.sliders.map((s) => sparkCard(s)).join('');
  attachSparkTips();

  const dist = (counts, items, mount) => {
    const max = Math.max(1, ...Object.values(counts));
    $(mount).innerHTML = items
      .map((i) => ({ ...i, n: counts[i.key] || 0 }))
      .sort((a, b) => b.n - a.n)
      .map((i) => hbar(i.label, i.n, max, String(i.n)))
      .join('');
  };
  dist(data.blockers, meta.blockers, 'blocker-bars');
  dist(data.processes, meta.processes, 'process-bars');
  const others = (list) => (list || []).map((c) => `<div class="comment">${esc(c)}</div>`).join('');
  if ((data.blockerOthers || []).length) {
    $('blocker-bars').insertAdjacentHTML('beforeend',
      `<h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:12px 0 4px">"Other" write-ins</h2>${others(data.blockerOthers)}`);
  }
  if ((data.processOthers || []).length) {
    $('process-bars').insertAdjacentHTML('beforeend',
      `<h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:12px 0 4px">"Other" write-ins</h2>${others(data.processOthers)}`);
  }
  if (data.motivations) {
    dist(data.motivations, meta.motivations, 'motivation-bars');
    const notes = data.motivationNotes || [];
    const groups = meta.motivations
      .map((m) => ({
        label: m.label,
        items: notes.filter((n) => n.m === m.key).map((n) => n.text),
      }))
      .filter((g) => g.items.length);
    $('motivation-notes').innerHTML = groups.length
      ? groups.map((g) => `
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 4px">${esc(g.label)} · ${g.items.length}</h2>
          ${g.items.map((c) => `<div class="comment">${esc(c)}</div>`).join('')}`).join('')
      : '<p class="hint">No explanations this month.</p>';
  }

  $('comments').innerHTML = data.comments.length
    ? data.comments.map((c) => `<div class="comment">${esc(c)}</div>`).join('')
    : '<p class="hint">No written comments this month.</p>';

  $('concerns').innerHTML = data.concerns.length
    ? data.concerns.map((c) =>
        `<div class="comment${c.urgent ? ' urgent' : ''}">${c.urgent ? '<span class="pill urgent-pill">URGENT</span> ' : ''}${esc(c.text)}</div>`
      ).join('')
    : '<p class="hint">No private concerns this month.</p>';

  const up = data.upward;
  const upSection = (title, list) => list.length
    ? `<h2 style="font-size:15px;margin-top:16px">${title}</h2>` + list.map((c) => `<div class="comment">${esc(c)}</div>`).join('')
    : '';
  const upHtml = upSection('Start', up.start) + upSection('Stop', up.stop) + upSection('Continue', up.continue);
  $('upward').innerHTML = upHtml || '<p class="hint">No upward feedback submitted this month.</p>';
}

function sparkCard(s) {
  const pts = data.trends[s.key];
  const now = data.averages[s.key];
  if (pts.length < 2) {
    return `<div class="spark"><div class="label">${s.label}</div>
      <div class="now">${now.toFixed(1)}</div>
      <p class="hint" style="margin:4px 0 0">Trend appears after two months of data.</p></div>`;
  }
  const W = 200, H = 48, PAD = 6;
  const x = (i) => PAD + (i * (W - 2 * PAD)) / (pts.length - 1);
  const y = (v) => H - PAD - ((v - 1) * (H - 2 * PAD)) / 9;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const c = scoreColor(last.avg);
  const circles = pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p.avg).toFixed(1)}" r="9" fill="transparent"
       data-tip="${monthName(p.cycle)}: ${p.avg.toFixed(1)} (${p.n} responses)"/>`).join('');
  return `<div class="spark"><div class="label">${s.label}</div>
    <svg viewBox="0 0 ${W} ${H}" aria-label="${s.label} trend">
      <line x1="${PAD}" y1="${y(5.5).toFixed(1)}" x2="${W - PAD}" y2="${y(5.5).toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
      <path d="${path}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="6" fill="#ffffff"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="4" fill="${c}"/>
      ${circles}
    </svg>
    <div class="now" style="color:${c}">${last.avg.toFixed(1)} <span class="hint" style="display:inline">avg in ${monthName(last.cycle)}</span></div>
  </div>`;
}

let tipEl;
function attachSparkTips() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'viz-tip hidden';
    document.body.appendChild(tipEl);
  }
  for (const c of document.querySelectorAll('.spark circle[data-tip]')) {
    c.addEventListener('mouseenter', (e) => {
      tipEl.textContent = e.target.dataset.tip;
      const r = e.target.getBoundingClientRect();
      tipEl.style.left = r.x + r.width / 2 + 'px';
      tipEl.style.top = r.y + 'px';
      tipEl.classList.remove('hidden');
    });
    c.addEventListener('mouseleave', () => tipEl.classList.add('hidden'));
  }
}

// ---- auto-published summary (read-only) ----

function renderSummaryView() {
  const s = data.summary;
  if (!s || !s.published) {
    $('summary-view').innerHTML = `<p class="hint">Nothing published for ${monthName(data.cycle)} yet. It happens automatically when the window closes (needs at least ${data.minResponsesToShow} responses).</p>`;
    return;
  }
  const themes = [s.theme1, s.theme2, s.theme3].filter((t) => t && t.trim());
  $('summary-view').innerHTML =
    `<div class="banner info">Published ${new Date(s.published_at).toLocaleString()}</div>` +
    themes.map((t, i) => `<div class="comment"><strong>Theme ${i + 1}.</strong> ${esc(t)}</div>`).join('') +
    (s.action ? `<div class="comment"><strong>Action.</strong> ${esc(s.action)}</div>` : '');
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

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();

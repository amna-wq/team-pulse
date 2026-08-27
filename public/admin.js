const $ = (id) => document.getElementById(id);
let meta, data;

const monthName = (cycle) => {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
};

// score color: low reads red, middle amber, high green (matches the survey sliders)
const scoreColor = (v) => (v <= 3 ? '#d6453d' : v <= 6 ? '#e0862f' : v <= 8 ? '#6aa63c' : '#2b8a3e');

// severity color for problem counts: the leading problem reads red, close
// runners-up amber, the rest blue; zero-vote rows fade to gray
const severityColor = (n, top) =>
  n === 0 ? '#c3cad6' : n === top ? '#d6453d' : n >= top / 2 ? '#e0862f' : '#2563eb';

// what-motivates-you is semantic, not ranked: intrinsic reads green,
// transactional amber/blue, "no idea" is the red flag
const MOTIVATION_COLORS = { work: '#2b8a3e', benefits: '#2563eb', salary: '#e0862f', no_idea: '#d6453d' };

// participation health
const pctColor = (p) => (p >= 70 ? '#2b8a3e' : p >= 40 ? '#e0862f' : '#d6453d');

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
  initGoogleButton();
}

// ---- sign in ----

function initGoogleButton(attempt = 0) {
  if (!meta.googleClientId) {
    $('gsi-unavailable').textContent = 'Google sign-in is not configured yet (GOOGLE_CLIENT_ID missing in .env). Ask Amna to check the setup.';
    $('gsi-unavailable').classList.remove('hidden');
    return;
  }
  if (!window.google?.accounts?.id) {
    if (attempt < 20) return void setTimeout(() => initGoogleButton(attempt + 1), 250);
    $('gsi-unavailable').textContent = 'Google sign-in script did not load. Check your connection and refresh.';
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

// ---- dashboard ----

async function showDash(cycle) {
  document.body.classList.remove('login-mode');
  document.body.classList.add('dash-mode');
  data = await api('/api/admin/overview' + (cycle ? `?cycle=${cycle}` : ''));
  $('dash').classList.remove('hidden');
  renderHeader();
  renderTiles();
  renderResults();
  wireOnce();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  $('cycle-select').addEventListener('change', (e) => showDash(e.target.value));
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
  // People, not links: extra links (resends/tests) never inflate the team size.
  const team = data.teamSize || t.issued;
  const pct = team ? Math.min(100, Math.round((100 * t.used) / team)) : null;
  const respColor = data.count >= data.minResponsesToShow ? '#2b8a3e' : '#e0862f';
  const partColor = pct == null ? 'var(--ink)' : pctColor(pct);
  $('tiles').innerHTML = `
    <div class="tile" style="border-top-color:${respColor}"><div class="label">Responses · ${monthName(data.cycle)}</div>
      <div class="value" style="color:${respColor}" data-count="${data.count}">0</div>
      <div class="note">shown only when ≥ ${data.minResponsesToShow} (anonymity floor)</div></div>
    <div class="tile" style="border-top-color:${pct == null ? 'var(--navy-2)' : partColor}"><div class="label">Participation</div>
      <div class="value" style="color:${partColor}"><span data-count="${t.used}">0</span><span style="font-size:16px;color:var(--muted)"> / ${team} people</span></div>
      <div class="note">${!t.issued ? 'no links sent yet' : `<span style="color:${partColor};font-weight:600">${pct}% of the team submitted</span>`}</div></div>
    <div class="tile" style="border-top-color:var(--navy-2)"><div class="label">Months of data</div>
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
    <div class="hbar-val"${color ? ` style="color:${color}"` : ''}>${valText}${deltaHtml}</div>
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

  const dist = (counts, items, mount, colorOf) => {
    const rows = items
      .map((i) => ({ ...i, n: counts[i.key] || 0 }))
      .sort((a, b) => b.n - a.n);
    const max = Math.max(1, ...rows.map((r) => r.n));
    $(mount).innerHTML = rows.map((i) => hbar(i.label, i.n, max, String(i.n), '', colorOf(i, max))).join('');
  };
  dist(data.blockers, meta.blockers, 'blocker-bars', (i, top) => severityColor(i.n, top));
  dist(data.processes, meta.processes, 'process-bars', (i, top) => severityColor(i.n, top));
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
    dist(data.motivations, meta.motivations, 'motivation-bars',
      (i) => (i.n === 0 ? '#c3cad6' : MOTIVATION_COLORS[i.key] || '#2563eb'));
    const notes = data.motivationNotes || [];
    const groups = meta.motivations
      .map((m) => ({
        label: m.label,
        color: MOTIVATION_COLORS[m.key] || '#2563eb',
        items: notes.filter((n) => n.m === m.key).map((n) => n.text),
      }))
      .filter((g) => g.items.length);
    $('motivation-notes').innerHTML = groups.length
      ? groups.map((g) => `
          <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${g.color};margin:14px 0 4px">${esc(g.label)} · ${g.items.length}</h2>
          ${g.items.map((c) => `<div class="comment" style="border-left-color:${g.color}">${esc(c)}</div>`).join('')}`).join('')
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
    return `<div class="spark" style="border-left:3px solid ${scoreColor(now)}"><div class="label">${s.label}</div>
      <div class="now" style="color:${scoreColor(now)}">${now.toFixed(1)}</div>
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
  return `<div class="spark" style="border-left:3px solid ${c}"><div class="label">${s.label}</div>
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

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();

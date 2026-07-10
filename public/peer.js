const token = decodeURIComponent(location.pathname.split('/p/')[1] || '');
const $ = (id) => document.getElementById(id);
let people = [];

async function init() {
  const res = await fetch('/api/peer-feedback/state?token=' + encodeURIComponent(token));
  const gate = $('gate');
  if (res.status === 403) {
    gate.innerHTML = '<h2>Not enabled</h2><p>The peer feedback module is not active.</p>';
    return;
  }
  const state = await res.json();
  if (!token || !state.valid) {
    gate.innerHTML = '<h2>This link isn\'t valid</h2><p>Peer feedback links are single-use and only work for the current cycle. Ask the admin for a fresh link.</p>';
    return;
  }
  if (state.used) {
    gate.innerHTML = '<h2>Already submitted</h2><p>This link has already been used. Feedback is final — that\'s part of the anonymity promise.</p>';
    return;
  }
  if (!state.window.open) {
    gate.innerHTML = '<h2>The feedback window is closed</h2><p>It follows the same monthly window as the Pulse survey.</p>';
    return;
  }
  people = state.people;
  if (!people.length) {
    gate.innerHTML = '<h2>No roster yet</h2><p>The admin hasn\'t set up the list of colleagues.</p>';
    return;
  }
  gate.classList.add('hidden');
  $('people').innerHTML = people.map((p) => `
    <div class="card" data-id="${p.id}">
      <h2>${esc(p.name)}</h2>
      <label class="q">Start — what should ${esc(p.name)} start doing?</label>
      <textarea data-k="start" style="min-height:64px"></textarea>
      <label class="q">Stop — what should ${esc(p.name)} stop doing?</label>
      <textarea data-k="stop" style="min-height:64px"></textarea>
      <label class="q">Continue — what is ${esc(p.name)} doing well?</label>
      <textarea data-k="continue" style="min-height:64px"></textarea>
    </div>`).join('');
  $('peer-form').classList.remove('hidden');
  $('peer-form').addEventListener('submit', submit);
}

async function submit(e) {
  e.preventDefault();
  const entries = [...document.querySelectorAll('#people .card')].map((card) => {
    const get = (k) => card.querySelector(`textarea[data-k="${k}"]`).value;
    return { about_id: Number(card.dataset.id), start: get('start'), stop: get('stop'), continue: get('continue') };
  }).filter((x) => x.start.trim() || x.stop.trim() || x.continue.trim());

  const err = $('submit-err');
  err.classList.add('hidden');
  if (!entries.length) {
    err.textContent = 'Write something for at least one colleague before submitting.';
    err.classList.remove('hidden');
    return;
  }
  $('submit-btn').disabled = true;
  const res = await fetch('/api/peer-feedback/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, entries }),
  });
  if (res.ok) {
    $('peer-form').classList.add('hidden');
    $('done').classList.remove('hidden');
    window.scrollTo(0, 0);
    if (typeof confettiBurst === 'function') confettiBurst();
  } else {
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Something went wrong — please try again.';
    err.classList.remove('hidden');
    $('submit-btn').disabled = false;
  }
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();

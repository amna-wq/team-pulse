const token = decodeURIComponent(location.pathname.split('/s/')[1] || '');
const $ = (id) => document.getElementById(id);

let meta;

async function init() {
  meta = await (await fetch('/api/meta')).json();
  if (meta.demoMode) $('demo-banner').classList.remove('hidden');

  const state = await (await fetch('/api/survey/state?token=' + encodeURIComponent(token))).json();
  const gate = $('gate');

  if (!token || !state.valid) {
    gate.innerHTML = '<h2>This link isn\'t valid</h2><p>Survey links are single-use and only work for the current month. Ask the survey admin for a fresh link.</p>';
    return;
  }
  if (state.used) {
    gate.innerHTML = '<h2>Already submitted</h2><p>This link has already been used. Responses are final and can\'t be edited or viewed. That\'s part of the anonymity promise.</p>';
    return;
  }
  if (!state.window.open) {
    const opens = new Date(state.window.opens);
    gate.innerHTML = `<h2>The survey is closed right now</h2><p>It opens automatically in the last week of each month and stays open for 48 hours. Next window: <strong>${opens.toLocaleString()}</strong>.</p>`;
    return;
  }

  gate.classList.add('hidden');
  buildForm();
  $('survey').classList.remove('hidden');
}

// score color: low reads red, middle amber, high green
const scoreColor = (v) => (v <= 3 ? '#d6453d' : v <= 6 ? '#e0862f' : v <= 8 ? '#6aa63c' : '#2b8a3e');

function paint(input, bubble) {
  const v = Number(input.value);
  // Chip stays in the calm blue theme; the chip text carries the score color.
  input.style.setProperty('--pct', `${((v - 1) / 9) * 100}%`);
  bubble.style.color = scoreColor(v);
  bubble.textContent = v;
}

function buildForm() {
  const wrap = $('sliders');
  for (const s of meta.sliders) {
    const div = document.createElement('div');
    div.className = 'slider-q';
    div.innerHTML = `
      <label class="q" for="${s.key}">${s.label}</label>
      <div class="slider-row">
        <input type="range" id="${s.key}" min="1" max="10" step="1" value="5">
        <div class="slider-val" id="${s.key}_val">5</div>
      </div>
      <div class="range-ends"><span>1 · strongly disagree</span><span>10 · strongly agree</span></div>`;
    wrap.appendChild(div);
    const input = div.querySelector('input');
    const bubble = div.querySelector('.slider-val');
    paint(input, bubble);
    input.addEventListener('input', () => {
      paint(input, bubble);
      bubble.classList.remove('pop');
      void bubble.offsetWidth; // restart the pop animation
      bubble.classList.add('pop');
    });
  }
  const fill = (sel, items, placeholder) => {
    sel.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
      items.map((i) => `<option value="${i.key}">${i.label}</option>`).join('');
  };
  fill($('blocker'), meta.blockers, 'Choose one…');
  fill($('process'), meta.processes, 'Choose one…');
  fill($('motivation'), meta.motivations, 'Choose one…');
  $('motivation').addEventListener('change', () => {
    const labels = {
      salary: 'Fair enough — what would make it about more than the paycheck?',
      benefits: 'Nice — which benefits matter most, and what\u2019s missing?',
      work: 'Love that — what part of the work keeps you going?',
      no_idea: 'Honest answer — what would give you a reason?',
    };
    $('motivation-why-label').textContent = labels[$('motivation').value] || 'Tell us more — what\u2019s behind that answer?';
    $('motivation-why-wrap').classList.remove('hidden');
  });
  $('open_text_label').textContent = meta.openTextLabel;

  $('upward_opt_in').addEventListener('change', (e) => {
    $('upward').classList.toggle('hidden', !e.target.checked);
  });

  $('survey').addEventListener('submit', submit);
}

async function submit(e) {
  e.preventDefault();
  const err = $('submit-err');
  err.classList.add('hidden');

  const body = { token, upward_opt_in: $('upward_opt_in').checked };
  for (const s of meta.sliders) body[s.key] = Number($(s.key).value);
  body.blocker = $('blocker').value;
  body.process_improvement = $('process').value;
  body.motivation = $('motivation').value;
  body.motivation_why = $('motivation_why').value;
  body.open_text = $('open_text').value;
  body.concern = $('concern').value;
  body.concern_urgent = $('concern_urgent').checked;
  body.upward_start = $('up_start').value;
  body.upward_stop = $('up_stop').value;
  body.upward_continue = $('up_continue').value;

  if (!body.blocker || !body.process_improvement || !body.motivation) {
    err.textContent = 'Please answer all three dropdown questions.';
    err.classList.remove('hidden');
    return;
  }
  if (!body.motivation_why.trim()) {
    err.textContent = 'Please add a line about what motivates you — it matters.';
    err.classList.remove('hidden');
    $('motivation-why-wrap').classList.remove('hidden');
    $('motivation_why').focus();
    return;
  }

  $('submit-btn').disabled = true;
  const res = await fetch('/api/survey/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    $('survey').classList.add('hidden');
    $('done').classList.remove('hidden');
    window.scrollTo(0, 0);
    if (typeof confettiBurst === 'function') confettiBurst();
  } else {
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Something went wrong. Please try again.';
    err.classList.remove('hidden');
    $('submit-btn').disabled = false;
  }
}

init();

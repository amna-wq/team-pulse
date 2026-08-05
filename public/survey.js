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

// The word that appears next to the number as you drag — the slider should
// feel like it's answering back, not just moving.
const scoreWord = (v) =>
  v <= 2 ? 'Really rough' : v <= 4 ? 'Not great' : v <= 6 ? 'So-so'
  : v <= 8 ? 'Pretty good' : 'Excellent';

function paint(input, bubble, verdict) {
  const v = Number(input.value);
  const c = scoreColor(v);
  // Chip stays in the calm blue theme; the chip text carries the score color.
  input.style.setProperty('--pct', `${((v - 1) / 9) * 100}%`);
  input.style.setProperty('--sc', c);
  bubble.style.color = c;
  bubble.textContent = v;
  if (verdict) {
    verdict.textContent = input.dataset.touched ? scoreWord(v) : 'Drag to answer';
    verdict.style.color = input.dataset.touched ? c : '';
    verdict.classList.toggle('untouched', !input.dataset.touched);
  }
}

// ---- live progress: how much of the survey is actually answered ----
// Sliders start at 5, so they only count once the person has moved (or
// keyboard-adjusted) them — otherwise the meter would open at 60% for free.
const REQUIRED = ['q_heard', 'q_equipped', 'q_workload', 'q_communication', 'q_meetings', 'q_safe'];

function answeredCount() {
  let done = 0;
  for (const key of REQUIRED) if ($(key)?.dataset.touched) done++;
  if ($('blocker').value) done++;
  if ($('process').value) done++;
  if ($('motivation').value) done++;
  if ($('motivation_why').value.trim()) done++;
  return done;
}

function updateProgress() {
  const total = REQUIRED.length + 4;
  const done = answeredCount();
  const pct = Math.round((100 * done) / total);
  const dock = $('dock');
  const complete = done === total;
  $('dock-fill').style.width = pct + '%';
  $('dock-count').textContent = complete ? 'All answered — you can submit' : `${done} of ${total} answered`;
  dock.classList.toggle('complete', complete);
  const btn = $('submit-btn');
  btn.textContent = complete ? 'SUBMIT' : `SUBMIT · ${total - done} left`;
  btn.classList.toggle('ready', complete);
  // Mark answered questions so the page shows its own state at a glance.
  for (const [el, ok] of [
    [$('blocker'), !!$('blocker').value],
    [$('process'), !!$('process').value],
    [$('motivation'), !!$('motivation').value],
    [$('motivation_why'), !!$('motivation_why').value.trim()],
  ]) el.classList.toggle('answered', ok);
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
      <div class="range-ends">
        <span>1 · strongly disagree</span>
        <span class="slider-verdict untouched">Drag to answer</span>
        <span>10 · strongly agree</span>
      </div>`;
    wrap.appendChild(div);
    const input = div.querySelector('input');
    const bubble = div.querySelector('.slider-val');
    const verdict = div.querySelector('.slider-verdict');
    paint(input, bubble, verdict);
    input.addEventListener('input', () => {
      input.dataset.touched = '1';
      div.classList.add('answered');
      paint(input, bubble, verdict);
      bubble.classList.remove('pop');
      void bubble.offsetWidth; // restart the pop animation
      bubble.classList.add('pop');
      updateProgress();
    });
  }
  const fill = (sel, items, placeholder) => {
    sel.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
      items.map((i) => `<option value="${i.key}">${i.label}</option>`).join('');
  };
  fill($('blocker'), meta.blockers, 'Choose one…');
  fill($('process'), meta.processes, 'Choose one…');
  fill($('motivation'), meta.motivations, 'Choose one…');
  $('blocker').addEventListener('change', () =>
    $('blocker-other-wrap').classList.toggle('hidden', $('blocker').value !== 'other'));
  $('process').addEventListener('change', () =>
    $('process-other-wrap').classList.toggle('hidden', $('process').value !== 'other'));
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

  // Anything that can change completeness re-renders the progress dock.
  for (const id of ['blocker', 'process', 'motivation']) {
    $(id).addEventListener('change', updateProgress);
  }
  $('motivation_why').addEventListener('input', updateProgress);

  // The dock only makes sense once the questions are on screen.
  const dock = $('dock');
  const io = new IntersectionObserver(
    ([e]) => dock.classList.toggle('on', e.isIntersecting || e.boundingClientRect.top < 0),
    { threshold: 0 }
  );
  io.observe($('sliders'));
  dock.addEventListener('click', () => {
    const next = [...document.querySelectorAll('#survey .slider-q:not(.answered), #survey select:not(.answered)')][0];
    (next || $('submit-btn')).scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  updateProgress();
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
  body.blocker_other = $('blocker_other').value;
  body.process_other = $('process_other').value;
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
  if (body.blocker === 'other' && !body.blocker_other.trim()) {
    err.textContent = 'You picked Other as your blocker — a few words about it, please.';
    err.classList.remove('hidden');
    $('blocker_other').focus();
    return;
  }
  if (body.process_improvement === 'other' && !body.process_other.trim()) {
    err.textContent = 'You picked Other as the process — name it, please.';
    err.classList.remove('hidden');
    $('process_other').focus();
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
    playSendOff();
  } else {
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Something went wrong. Please try again.';
    err.classList.remove('hidden');
    $('submit-btn').disabled = false;
  }
}

// A short "sealed and sent, anonymously" moment, then the thank-you page.
// Deliberately minimal: one ring, one checkmark, two lines of text.
function playSendOff() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return void (window.location.href = '/thanks');

  const o = document.createElement('div');
  o.className = 'sendoff';
  o.innerHTML = `
    <div class="sendoff-inner">
      <svg class="sendoff-mark" viewBox="0 0 52 52" aria-hidden="true">
        <circle class="so-ring" cx="26" cy="26" r="23" fill="none" stroke-width="2.5"/>
        <path class="so-tick" d="M15 26.5 L22.5 34 L37 19" fill="none" stroke-width="3.2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="sendoff-title">Sealed anonymously</div>
      <div class="sendoff-sub">Your answers are in — with nothing attached to your name.</div>
    </div>`;
  document.body.appendChild(o);
  requestAnimationFrame(() => o.classList.add('on'));
  setTimeout(() => o.classList.add('leaving'), 1850);
  setTimeout(() => { window.location.href = '/thanks'; }, 2250);
}

init();

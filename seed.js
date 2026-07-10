// Demo seed: wipes the database and fills 4 past months + the current month
// with plausible fake responses, so the dashboard is demoable with zero real
// data. Run: npm run seed   (or npm run demo to seed + start in demo mode)

import crypto from 'node:crypto';
import { db } from './src/db.js';
import { currentCycle } from './src/cycle.js';
import { blockerKeys, processKeys } from './src/questions.js';

// Deterministic PRNG so the demo looks the same on every reseed.
let seedState = 42;
function rand() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const maybe = (p, fn) => (rand() < p ? fn() : null);

// Slider score around a center, clamped 1-10.
const around = (center) => Math.max(1, Math.min(10, Math.round(center + (rand() - 0.5) * 4)));

function pastCycles(n) {
  const out = [];
  const now = new Date();
  for (let i = n; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const COMMENTS = [
  'Too many status meetings that could be a message. Half my mornings are gone before I start real work.',
  'Priorities changed three times this month. Hard to finish anything when the target keeps moving.',
  'The shared drive is a mess, I can never find the latest version of anything.',
  'Honestly a decent month, the new checklist helped a lot.',
  'I spend a lot of time waiting on approvals. Even small things need sign-off.',
  'Workload spikes at month end are brutal. The rest of the month is fine.',
  'Would love clearer ownership — sometimes two people do the same task, sometimes nobody does.',
  'Tools keep logging me out and 2FA takes forever. Small thing but it adds up every single day.',
  'Communication between the ops side and the marketing side is basically nonexistent.',
  'New dashboard is great, saves me an hour a week easily.',
  'It would help to know what the company goals are this quarter. I find out things from customers.',
  'Onboarding docs are out of date, I still ask people the same questions the docs should answer.',
  '',
  '',
  '',
];

const CONCERNS = [
  { text: 'I sometimes feel my ideas get dismissed in meetings until someone more senior repeats them.', urgent: 0 },
  { text: 'One colleague keeps making "jokes" about where I am from. I laugh along but it bothers me.', urgent: 1 },
  { text: 'I feel like deadlines are set without asking the people who actually do the work.', urgent: 0 },
  { text: null, urgent: 0 },
  { text: null, urgent: 0 },
  { text: null, urgent: 0 },
  { text: null, urgent: 0 },
];

const UP_START = [
  'Share a short weekly note on what leadership is focused on.',
  'Give us a heads-up before big priority changes instead of after.',
  'Start doing skip-level 1:1s once a quarter.',
];
const UP_STOP = [
  'Stop scheduling meetings without agendas.',
  'Stop assigning urgent tasks at 5pm.',
  'Stop changing the plan mid-sprint unless it is truly urgent.',
];
const UP_CONTINUE = [
  'Continue the monthly all-hands, it is genuinely useful.',
  'Keep being responsive on Slack, it helps a lot.',
  'Continue giving public credit when a project lands.',
];

// Month "mood" drifts so the trend lines have a story: workload dips then
// recovers, meetings slowly improve.
const MOODS = [
  { heard: 6.5, equipped: 7.0, workload: 6.0, comm: 5.5, meetings: 4.5, safe: 6.5 },
  { heard: 6.5, equipped: 7.0, workload: 5.0, comm: 5.5, meetings: 4.8, safe: 6.8 },
  { heard: 7.0, equipped: 7.2, workload: 4.5, comm: 6.0, meetings: 5.2, safe: 7.0 },
  { heard: 7.2, equipped: 7.5, workload: 5.5, comm: 6.5, meetings: 5.8, safe: 7.2 },
  { heard: 7.4, equipped: 7.6, workload: 6.2, comm: 6.8, meetings: 6.2, safe: 7.4 },
];

db.exec(`DELETE FROM responses; DELETE FROM tokens; DELETE FROM summaries; DELETE FROM window_overrides;
         DELETE FROM peer_feedback; DELETE FROM peer_tokens; DELETE FROM peer_people;`);

const insertResp = db.prepare(
  `INSERT INTO responses
     (cycle, q_heard, q_equipped, q_workload, q_communication, q_meetings, q_safe,
      blocker, process_improvement, open_text, upward_start, upward_stop, upward_continue,
      concern, concern_urgent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertToken = db.prepare('INSERT INTO tokens (token_hash, cycle) VALUES (?, ?)');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const TEAM_SIZE = 18;
const cycles = [...pastCycles(4), currentCycle()];

cycles.forEach((cycle, ci) => {
  const mood = MOODS[ci];
  const isCurrent = cycle === currentCycle();
  const n = isCurrent ? randInt(7, 10) : randInt(13, 16);

  // Tokens: full team issued; "used" matches the number of responses.
  const demoTokens = [];
  for (let i = 0; i < TEAM_SIZE; i++) {
    const t = crypto.randomBytes(16).toString('base64url');
    insertToken.run(sha256(t), cycle);
    demoTokens.push(t);
  }
  db.prepare(`UPDATE tokens SET used = 1 WHERE id IN (SELECT id FROM tokens WHERE cycle = ? LIMIT ${n})`).run(cycle);

  for (let i = 0; i < n; i++) {
    const optIn = rand() < 0.4;
    const concern = pick(CONCERNS);
    insertResp.run(
      cycle,
      around(mood.heard), around(mood.equipped), around(mood.workload),
      around(mood.comm), around(mood.meetings), around(mood.safe),
      pick(blockerKeys), pick(processKeys), pick(COMMENTS),
      optIn ? maybe(0.8, () => pick(UP_START)) : null,
      optIn ? maybe(0.7, () => pick(UP_STOP)) : null,
      optIn ? maybe(0.7, () => pick(UP_CONTINUE)) : null,
      concern.text, concern.text ? concern.urgent : 0
    );
  }

  if (isCurrent) {
    // Leave a few unused demo links so the survey itself is demoable.
    const unused = demoTokens.slice(n, n + 3);
    console.log(`Demo survey links for ${cycle} (unused, valid while window is open):`);
    for (const t of unused) console.log(`  http://localhost:${process.env.PORT || 8080}/s/${t}`);
  }
});

// A published summary for the most recent COMPLETE month, so /summary has content.
const prevCycle = cycles[cycles.length - 2];
db.prepare(
  `INSERT INTO summaries (cycle, theme1, theme2, theme3, action, published, published_at)
   VALUES (?, ?, ?, ?, ?, 1, ?)`
).run(
  prevCycle,
  'Meetings are the weakest area again (avg ~5.8/10) — too many without agendas, and several people say mornings are lost to status updates.',
  'Priorities changing mid-month is the most-cited blocker; planning & prioritization is the process most people want improved.',
  'Positive signal: "I have what I need to do my job well" keeps trending up since the tooling fixes.',
  'This month we will introduce a no-meeting Wednesday morning and require an agenda on every recurring invite; we will review whether it helped in next month\'s pulse.',
  new Date().toISOString()
);

// Peer feedback (Phase 2) demo roster + a little sample feedback, so the
// module is demoable if MANAGEMENT_SPONSORED=true is set. Fake names only.
const PEOPLE = ['Alex', 'Bilal', 'Chris', 'Dana', 'Farah', 'Omar'];
const insPerson = db.prepare('INSERT INTO peer_people (name) VALUES (?)');
for (const p of PEOPLE) insPerson.run(p);
const insFb = db.prepare(
  'INSERT INTO peer_feedback (cycle, about_id, fb_start, fb_stop, fb_continue) VALUES (?, ?, ?, ?, ?)'
);
const cur = currentCycle();
insFb.run(cur, 1, 'Start sharing your plans before the deadline week.', null, 'Your code reviews are genuinely helpful — keep the examples.');
insFb.run(cur, 1, null, 'Please stop rescheduling our 1:1 last minute.', null);
insFb.run(cur, 2, 'Start speaking up in planning — your instincts are usually right.', null, 'Keep helping the new folks, it does not go unnoticed.');

const total = db.prepare('SELECT COUNT(*) AS n FROM responses').get().n;
console.log(`Seeded ${cycles.length} cycles, ${total} fake responses, 1 published summary (${prevCycle}).`);
console.log('Start the demo with: DEMO_MODE=true ADMIN_PASSWORD=demo-admin node server.js');

import { SLIDERS, BLOCKERS, PROCESSES } from './questions.js';

const STOPWORDS = new Set(
  `a an and are as at be been but by for from has have i if in is it its me my not of on or our so
   that the their them they this to too us we with you your was were will would could should just
   really very much more most some any all no yes than then there here what when who how also get
   got can cant dont im its lot bit still even out about up down over under after before while do
   does did doing feel feels felt think know like need needs want make makes making one two week
   month time day days things thing way people team work working`
    .split(/\s+/)
    .filter(Boolean)
);

function labelFor(list, key) {
  const item = list.find((x) => x.key === key);
  return item ? item.label : key;
}

// Heuristic "top 3 themes" draft from a cycle's aggregate data. This is a
// starting point for management to edit — it never quotes an individual
// response back verbatim, only aggregate signals and common words.
export function draftThemes({ averages, blockers, processes, comments, count }) {
  const themes = [];

  // Theme 1: the weakest slider.
  const scored = SLIDERS.filter((s) => averages[s.key] != null).map((s) => ({
    label: s.label,
    avg: averages[s.key],
  }));
  scored.sort((a, b) => a.avg - b.avg);
  if (scored.length) {
    const worst = scored[0];
    themes.push(`Lowest-scoring area: "${worst.label}" (average ${worst.avg.toFixed(1)}/10 across ${count} responses).`);
  }

  // Theme 2: the most-picked blocker + most-picked process.
  const topBlocker = Object.entries(blockers).sort((a, b) => b[1] - a[1])[0];
  const topProcess = Object.entries(processes).sort((a, b) => b[1] - a[1])[0];
  if (topBlocker && topBlocker[1] > 0) {
    let t = `Most common blocker this month: ${labelFor(BLOCKERS, topBlocker[0])} (${topBlocker[1]} of ${count}).`;
    if (topProcess && topProcess[1] > 0) {
      t += ` Process most people want improved: ${labelFor(PROCESSES, topProcess[0])}.`;
    }
    themes.push(t);
  }

  // Theme 3: recurring words in the open comments (only words used by 2+ people).
  const wordDocs = new Map();
  for (const c of comments) {
    const seen = new Set();
    for (const w of (c || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) {
      if (STOPWORDS.has(w) || seen.has(w)) continue;
      seen.add(w);
      wordDocs.set(w, (wordDocs.get(w) || 0) + 1);
    }
  }
  const recurring = [...wordDocs.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, n]) => `"${w}" (${n})`);
  if (recurring.length) {
    themes.push(`Recurring words in comments: ${recurring.join(', ')}. Read the comments for context before finalizing this theme.`);
  }

  while (themes.length < 3) themes.push('');
  return themes.slice(0, 3);
}

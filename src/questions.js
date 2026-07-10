// Single source of truth for survey content. The frontend fetches this via /api/meta
// so labels are never duplicated.

export const SLIDERS = [
  { key: 'q_heard', label: 'I feel heard at work' },
  { key: 'q_equipped', label: 'I have what I need to do my job well' },
  { key: 'q_workload', label: 'My workload is sustainable' },
  { key: 'q_communication', label: 'Communication in the team is clear' },
  { key: 'q_meetings', label: 'Meetings are a good use of my time' },
  { key: 'q_safe', label: 'I feel comfortable raising problems' },
];

export const BLOCKERS = [
  { key: 'unclear_tasks', label: 'Unclear tasks' },
  { key: 'too_many_meetings', label: 'Too many meetings' },
  { key: 'tool_problems', label: 'Tool problems' },
  { key: 'waiting_on_others', label: 'Waiting on others' },
  { key: 'workload', label: 'Workload' },
  { key: 'other', label: 'Other' },
];

export const PROCESSES = [
  { key: 'planning', label: 'Planning & prioritization' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'handoffs', label: 'Handoffs between people' },
  { key: 'reporting', label: 'Reporting & status updates' },
  { key: 'documentation', label: 'Documentation & onboarding' },
  { key: 'tools', label: 'Tools & automation' },
  { key: 'other', label: 'Other' },
];

export const OPEN_TEXT_LABEL =
  'Anything bothering you — company, process, workload, anything. Management reads every word.';

export const sliderKeys = SLIDERS.map((s) => s.key);
export const blockerKeys = BLOCKERS.map((b) => b.key);
export const processKeys = PROCESSES.map((p) => p.key);

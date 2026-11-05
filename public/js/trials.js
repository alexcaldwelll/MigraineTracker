// Tracked trials: the person starts one suggestion, the app counts the days,
// then compares headache days before and during. Pure: no DOM, no storage.
// Dates are 'YYYY-MM-DD' in the person's own time zone.
import { shiftDate } from './dates.js';
import { headacheDaySet } from './headache.js';

const DAY_MS = 86400000;
const LABELS = { sleep: 'Sleep', food: 'Food', tag: 'Food', type: 'Food', habit: 'Habit', caffeine: 'Caffeine', logging: 'Logging' };
export const CAVEAT = "One trial can't prove cause, because other things change from week to week too.";

const dayNumber = date => Math.round(Date.parse(date + 'T00:00:00Z') / DAY_MS);
const perWeek = (count, length) => Math.round(count / length * 7 * 10) / 10;
const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const activeTrial = trials => (trials || []).find(t=> t && t.status === 'active') || null;

// The saved row for a new trial, or null while another one is running.
export function startTrial(tryNext, today, trials = []){
  if(activeTrial(trials)) return null;
  const days = Math.max(1, Math.round(Number(tryNext?.days)) || 14);
  const { title, action, why, confidence, factor_key } = tryNext || {};
  return {
    suggestion: { title, action, why, confidence, days, factor_key: factor_key ?? null },
    start_date: today,
    end_date: shiftDate(today, days - 1),
    status: 'active',
    result: null,
  };
}

export function trialLength(trial){
  return dayNumber(trial.end_date) - dayNumber(trial.start_date) + 1;
}

// Day 1 is the start date. After the end it stays at the last day.
export function trialDay(trial, today){
  const total = trialLength(trial);
  const day = dayNumber(today) - dayNumber(trial.start_date) + 1;
  return { day: Math.min(Math.max(day, 1), total), total };
}

export const trialEnded = (trial, today) => today > trial.end_date;

// An active trial whose end date has passed and still needs its review saved.
export const dueTrial = (trials, today) => (trials || []).find(t=> t && t.status === 'active' && trialEnded(t, today)) || null;

export function trialLabel(trial){
  const kind = String(trial?.suggestion?.factor_key ?? '').split(':')[0];
  return `${LABELS[kind] || 'Your'} trial`;
}

function span(days, from, length){
  const dates = Array.from({ length }, (_, i)=> shiftDate(from, i));
  const set = new Set(dates);
  return { dates, logged: days.some(d=> set.has(d.date) && d.entries.length > 0) };
}

// Headache days per week during the trial's dates and across the same number
// of days just before the start. A period with nothing logged is null, not 0.
// Counts ride along so the screen can show them.
export function reviewTrial(trial, days){
  const length = trialLength(trial);
  const headaches = headacheDaySet(days);
  const count = from => span(days, from, length).dates.filter(d=> headaches.has(d)).length;
  const beforeStart = shiftDate(trial.start_date, -length);
  const beforeSpan = span(days, beforeStart, length);
  const duringSpan = span(days, trial.start_date, length);
  const beforeDays = beforeSpan.logged || count(beforeStart) > 0 ? count(beforeStart) : null;
  const duringDays = duringSpan.logged || count(trial.start_date) > 0 ? count(trial.start_date) : null;
  const before = beforeDays == null ? null : perWeek(beforeDays, length);
  const during = duringDays == null ? null : perWeek(duringDays, length);
  return { before, during, length, beforeDays, duringDays, summary: summarize({ before, during, length, beforeDays, duringDays }) };
}

function summarize({ before, during, length, beforeDays, duringDays }){
  const span = `${countOf(length, 'day')}`;
  let text;
  if(before == null && during == null){
    text = `Nothing was logged before or during this trial, so there is nothing to compare against.`;
  }else if(before == null){
    text = `Nothing was logged in the ${span} before this trial, so there is nothing to compare against. During it you had headaches on ${countOf(duringDays, 'day')} (${during} a week).`;
  }else if(during == null){
    text = `Nothing was logged during this trial, so there is nothing to compare it with. In the ${span} before it you had headaches on ${countOf(beforeDays, 'day')} (${before} a week).`;
  }else{
    const counts = `During the trial: headaches on ${countOf(duringDays, 'day')} of ${length} (${during} a week). Before it: ${countOf(beforeDays, 'day')} of ${length} (${before} a week).`;
    const verdict = during < before ? 'Headache days were fewer during the trial.'
      : during === before ? 'Headache days stayed about the same.'
      : 'Headache days were not fewer during the trial.';
    text = `${verdict} ${counts}`;
  }
  return `${text} ${CAVEAT}`;
}

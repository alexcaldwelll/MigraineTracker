// The pattern engine: what came before headaches, compared with headache-free
// stretches, and a rule-based suggestion that always gives the person something
// to do. Pure, so the browser and the Netlify function can both import it: no
// DOM, no network, and no import of data.js or ui.js. All times are local.
//
// Lookbacks. Each headache entry is one attack, so one attack across midnight
// counts once. Its start is start_at, otherwise date plus time. A lookback is
// the 48 hours before that start: anything logged at or after the start is out.
// A blank time counts as 12:00, for attacks and exposures alike.
//
// Control windows. Walking forward from the first logged date, two consecutive
// calendar dates form a control window when:
//   - neither date is a headache day (every date any headache touches),
//   - at least one of them has an entry, because a stretch the person never
//     logged is unknown rather than headache-free,
//   - both dates are over, so today never counts.
// A window that qualifies uses up both dates, so windows never overlap. A date
// that does not qualify moves the walk on by one. A control window can sit just
// before a headache and so overlap a lookback. That shrinks gaps, which errs the
// honest way, and keeping those windows matters for frequent headaches.
//
// A log with no such window. controlTotal is 0, no control count is invented,
// and every factor is an early guess because nothing shows it is any rarer on
// headache-free stretches. Daily coffee would otherwise look like a trigger.
//
// Missing data. Denominators are always every lookback and every control window.
// A window with no food or sleep logged counts as "not seen", so gaps can only
// understate a factor, and `gaps` reports them. A factor seen in no lookback is
// left out, since it can say nothing about headaches.
import { localDate, shiftDate } from './dates.js';
import { TAG_LABELS, triggerLabel, visibleItems } from './food-items.js';
import { headacheDaySet, isHeadacheEntry } from './headache.js';

const HOUR = 3600000;
const LOOKBACK_MS = 48 * HOUR;
const BLANK_TIME = '12:00';

// Confidence thresholds, for samples that are usually under 20 attacks, where
// one or two matches happen by chance. confidenceFor applies them.
//   early guess: everything else, including anything seen once or twice.
//   moderate:    seen in at least 3 lookbacks, and at least 40% of them.
//   strong:      seen in at least 5 lookbacks, and at least 60% of them.
// Against control windows, a gap under 15 points is no real difference, so the
// result is an early guess. Strong also needs a gap of 30 points or more and at
// least 10 control windows, since a handful of windows gives a coarse rate.
const CONFIDENCE = ['early guess', 'moderate', 'strong'];
const MODERATE = { hits: 3, rate: 0.4 };
const STRONG = { hits: 5, rate: 0.6 };
const SOME_GAP = 0.15;
const CLEAR_GAP = 0.30;
const STRONG_MIN_CONTROLS = 10;

const rate = (hits, total) => (total ? hits / total : 0);
const gapFromControl = (hits, total, control) => rate(hits, total) - rate(control.hits, control.total);

// hits of total lookbacks. `control` is { hits, total } for the control windows.
// Leave it out to judge the counts alone. gapFromControl is the only comparison
// with the control rate, and confidence and suggestions both go through it.
export function confidenceFor(hits, total, control){
  const seen = rate(hits, total);
  let level = 0;
  if(hits >= MODERATE.hits && seen >= MODERATE.rate) level = 1;
  if(hits >= STRONG.hits && seen >= STRONG.rate) level = 2;
  if(control){
    const gap = gapFromControl(hits, total, control);
    if(!control.total || gap < SOME_GAP) level = 0;
    else if(gap < CLEAR_GAP || control.total < STRONG_MIN_CONTROLS) level = Math.min(level, 1);
  }
  return CONFIDENCE[level];
}

const FOOD_TYPE_LABELS = {
  meat_fish:'Meat and fish', dairy:'Dairy', grains:'Grains', fruit_veg:'Fruit and vegetables',
  legumes_nuts:'Legumes and nuts', sweets_snacks:'Sweets and snacks', drinks:'Drinks', other:'Other foods',
};
const SLEEP_BANDS = [
  { key:'sleep:under_6', label:'Under 6 hours of sleep', below: 6 },
  { key:'sleep:6_to_7', label:'6 to 7 hours of sleep', below: 7 },
  { key:'sleep:7_plus', label:'7+ hours of sleep', below: Infinity },
];
// A food item with one of these names would be a macro by another route.
const MACRO_WORDS = new Set(['protein','proteins','carb','carbs','carbohydrate','carbohydrates','fat','fats']);

const atLocal = (date, time) => {
  const hhmm = /^\d{2}:\d{2}/.test(String(time ?? '')) ? time.slice(0, 5) : BLANK_TIME;
  return new Date(`${date}T${hhmm}:00`).getTime();
};

function attackStart(entry, date){
  const stamped = entry.start_at ? new Date(entry.start_at).getTime() : NaN;
  return Number.isNaN(stamped) ? atLocal(date, entry.time) : stamped;
}

const hasHours = hours => hours != null && hours !== '' && Number(hours) > 0;

// Not sorted into items yet, so it says nothing about what was eaten. An entry
// the AI finished with no items is done, not unsplit.
const isUnsplit = entry => entry.split_status === 'pending'
  || (entry.split_status !== 'done' && !(Array.isArray(entry.items) && entry.items.length));

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// [key, label] for each food factor in a food entry. Waiting entries count for
// nothing, like everywhere else food is totalled.
function foodFactors(entry){
  if(entry.split_status === 'pending') return [];
  const found = [];
  for(const item of visibleItems(entry.items)){
    const name = String(item.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if(name && !MACRO_WORDS.has(name)) found.push([`food:${name}`, capitalize(name)]);
    if(FOOD_TYPE_LABELS[item.food_type]) found.push([`type:${item.food_type}`, FOOD_TYPE_LABELS[item.food_type]]);
    for(const tag of Array.isArray(item.tags) ? item.tags : []){
      if(TAG_LABELS[tag]) found.push([`tag:${tag}`, triggerLabel(tag)]);
    }
  }
  return found;
}

// A nap joins the night, so one day has one sleep total and one band. It is
// placed at the time of that day's first sleep entry.
function sleepExposure(date, entries){
  const nights = entries.filter(e=> e.type === 'sleep' && hasHours(e.hours));
  if(!nights.length) return null;
  const hours = nights.reduce((sum, e)=> sum + Number(e.hours), 0);
  const band = SLEEP_BANDS.find(b=> hours < b.below);
  return { at: Math.min(...nights.map(e=> atLocal(date, e.time))), factors: [[band.key, band.label]] };
}

// date -> [{ at, factors: [[key, label]] }]
function exposuresByDate(days){
  const byDate = new Map();
  const add = (date, exposure)=>{
    if(!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(exposure);
  };
  for(const { date, entries } of days){
    for(const entry of entries){
      if(entry.type === 'food') add(date, { at: atLocal(date, entry.time), factors: foodFactors(entry) });
    }
    const sleep = sleepExposure(date, entries);
    if(sleep) add(date, sleep);
  }
  return byDate;
}

function lookbackKeys(start, exposures, labels){
  const keys = new Set();
  const startDate = localDate(new Date(start));
  // Three days back, not two, so a clock change cannot lose an hour of the 48.
  for(let back = 0; back <= 3; back++){
    for(const { at, factors } of exposures.get(shiftDate(startDate, -back)) || []){
      if(at < start - LOOKBACK_MS || at >= start) continue;
      for(const [key, label] of factors){ keys.add(key); labels.set(key, label); }
    }
  }
  return keys;
}

function controlWindows(loggedDates, headacheDays, now){
  const today = localDate(now);
  const windows = [];
  let date = [...loggedDates].sort()[0];
  while(date){
    const next = shiftDate(date, 1);
    if(next >= today) break;
    const clean = !headacheDays.has(date) && !headacheDays.has(next);
    if(clean && (loggedDates.has(date) || loggedDates.has(next))){
      windows.push([date, next]);
      date = shiftDate(next, 1);
    }else{
      date = next;
    }
  }
  return windows;
}

function controlKeys(span, exposures){
  const keys = new Set();
  for(const date of span){
    for(const { factors } of exposures.get(date) || []) for(const [key] of factors) keys.add(key);
  }
  return keys;
}

function tally(keySets){
  const counts = new Map();
  for(const keys of keySets) for(const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}

// Sleep first on a tie because it is the gentlest change, then the narrowest food.
const KIND_ORDER = ['sleep', 'food', 'tag', 'type'];
const kindOf = key => key.slice(0, key.indexOf(':'));
const factorGap = f => gapFromControl(f.beforeHeadache, f.headacheTotal, { hits: f.controlHits, total: f.controlTotal });

function byEvidence(a, b){
  return CONFIDENCE.indexOf(b.confidence) - CONFIDENCE.indexOf(a.confidence)
    || factorGap(b) - factorGap(a)
    || b.beforeHeadache - a.beforeHeadache
    || KIND_ORDER.indexOf(kindOf(a.key)) - KIND_ORDER.indexOf(kindOf(b.key))
    || a.key.localeCompare(b.key);
}

function buildFactors(lookbacks, controls, labels){
  const before = tally(lookbacks), inControl = tally(controls);
  const factors = [...before].map(([key, beforeHeadache])=>{
    const controlHits = inControl.get(key) || 0;
    return {
      key, label: labels.get(key), beforeHeadache, headacheTotal: lookbacks.length, controlHits, controlTotal: controls.length,
      confidence: confidenceFor(beforeHeadache, lookbacks.length, { hits: controlHits, total: controls.length }),
    };
  });
  return factors.sort(byEvidence);
}

// Sorted period start Dates: the first day with a 'period' entry after a gap of
// 20+ days from the previous one.
export function findCycleDays(days){
  const periodDates = days.filter(d=> d.entries.some(e=>e.type==='period')).map(d=>d.date).sort();
  const starts = [];
  let last = null;
  periodDates.forEach(dateStr=>{
    const d = new Date(dateStr+'T00:00:00');
    if(!last || (d - last)/86400000 > 20){ starts.push(d); }
    last = d;
  });
  return starts;
}

export function cycleDayFor(dateStr, periodStarts){
  const d = new Date(dateStr+'T00:00:00');
  let best = null;
  periodStarts.forEach(start=>{
    const diff = Math.round((d - start)/86400000);
    if(diff >= -7 && diff <= 35){
      if(best===null || Math.abs(diff) < Math.abs(best)) best = diff;
    }
  });
  return best;
}

// { periodStarts, byCycleDay }. Keys look like "-2" and "+1"; day 0 is "+0".
export function headacheDaysByCycleDay(days){
  const periodStarts = findCycleDays(days);
  const byCycleDay = {};
  for(const date of headacheDaySet(days)){
    const cd = cycleDayFor(date, periodStarts);
    if(cd===null) continue;
    const key = cd<0 ? String(cd) : '+'+cd;
    byCycleDay[key] = (byCycleDay[key]||0)+1;
  }
  return { periodStarts, byCycleDay };
}

// Null with no period data. nearPeriod covers days -2 to +3 around a period start.
function cycleStats(days){
  const { periodStarts, byCycleDay } = headacheDaysByCycleDay(days);
  if(!periodStarts.length) return null;
  const counts = Object.entries(byCycleDay);
  return {
    periodStarts: periodStarts.length, byCycleDay,
    counted: counts.reduce((sum, [, n])=> sum + n, 0),
    nearPeriod: counts.reduce((sum, [day, n])=> sum + (parseInt(day) >= -2 && parseInt(day) <= 3 ? n : 0), 0),
  };
}

function acuteDaysInLast30(days, now){
  const today = localDate(now), oldest = shiftDate(today, -29);
  return days.filter(d=> d.date >= oldest && d.date <= today
    && d.entries.some(e=> e.type === 'meds' && e.category === 'acute')).length;
}

function logGaps(loggedDays){
  const gaps = { missingSleepDays: 0, missingFoodDays: 0, unsplitFoodEntries: 0 };
  for(const { entries } of loggedDays){
    if(!entries.some(e=> e.type === 'sleep' && hasHours(e.hours))) gaps.missingSleepDays++;
    if(!entries.some(e=> e.type === 'food')) gaps.missingFoodDays++;
    gaps.unsplitFoodEntries += entries.filter(e=> e.type === 'food' && isUnsplit(e)).length;
  }
  return gaps;
}

// `days` is [{ date, entries }]. See the top of this file for the windows.
export function buildStats(days, { now = new Date() } = {}){
  const headacheDays = headacheDaySet(days);
  const logged = days.filter(d=> d.entries.length);
  const exposures = exposuresByDate(days);
  const labels = new Map();
  const lookbacks = days.flatMap(({ date, entries })=> entries.filter(isHeadacheEntry)
    .map(entry=> lookbackKeys(attackStart(entry, date), exposures, labels)));
  const controls = controlWindows(new Set(logged.map(d=> d.date)), headacheDays, now)
    .map(span=> controlKeys(span, exposures));
  return {
    attacks: lookbacks.length,
    headacheDays: headacheDays.size,
    loggedDays: logged.length,
    factors: buildFactors(lookbacks, controls, labels),
    cycle: cycleStats(days),
    acuteMedDays30: acuteDaysInLast30(days, now),
    gaps: logGaps(logged),
  };
}

// Food suggestions run 2 to 4 weeks: the wider the change, the longer it needs
// to show, since it is harder to keep to and takes in more meals.
const TRIAL_DAYS = { sleep: 14, food: 14, tag: 21, type: 28, habit: 14, logging: 14 };
const forWeeks = days => `Do this for the next ${days / 7} weeks`;
const MIN_HITS_TO_SUGGEST = 2;
const MIN_ATTACKS_FOR_HABIT = 3;
const MAX_WATCHING = 3;
const ACUTE_FLAG_DAYS = 8;        // the same line as the medication flag in insights.js
const CYCLE_NOTE_MIN_DAYS = 3;
const CYCLE_NOTE_MIN_SHARE = 0.5;

const SLEEP_TITLE = 'Aim for 7+ hours of sleep';
// More sleep cannot answer 7+ hours, "other" names nothing, and giving up all
// drinks is neither narrow nor safe. These stay in `factors` for Claude to read.
const NOT_SUGGESTED = new Set(['sleep:7_plus', 'type:drinks', 'type:other']);

const HABITS = [
  { factor_key:'habit:steady_sleep', title:'Keep a steady sleep schedule' },
  { factor_key:'habit:regular_meals', title:'Eat at regular times' },
  { factor_key:'habit:water', title:'Drink water through the day' },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const inSentence = label => (/^[A-Z]+$/.test(label) ? label : label.toLowerCase());
const sameTitle = title => String(title ?? '').trim().toLowerCase();

function evidence(f){
  const before = `${f.label} came before ${f.beforeHeadache} of ${f.headacheTotal} headaches`;
  return f.controlTotal
    ? `${before}, compared with ${f.controlHits} of ${f.controlTotal} headache-free stretches.`
    : `${before}, with no headache-free stretches to compare with yet.`;
}

function factorTrial(f){
  const kind = kindOf(f.key), days = TRIAL_DAYS[kind];
  const title = kind === 'sleep' ? SLEEP_TITLE : `Skip ${inSentence(f.label)} for ${days / 7} weeks`;
  return { title, action: forWeeks(days), why: evidence(f), confidence: f.confidence, days, factor_key: f.key };
}

const worthSuggesting = f => !NOT_SUGGESTED.has(f.key)
  && f.beforeHeadache >= MIN_HITS_TO_SUGGEST && factorGap(f) >= SOME_GAP;

// True for a suggestion a completed trial already showed no improvement from.
function notHelpedBefore(pastTrials){
  const keys = new Set(), titles = new Set();
  for(const trial of pastTrials || []){
    if(!trial || trial.status !== 'completed' || !trial.suggestion || !trial.result) continue;
    const { before, during } = trial.result;
    if(!Number.isFinite(before) || !Number.isFinite(during) || during < before) continue;
    if(trial.suggestion.factor_key) keys.add(trial.suggestion.factor_key);
    if(trial.suggestion.title) titles.add(sameTitle(trial.suggestion.title));
  }
  return suggestion => keys.has(suggestion.factor_key) || titles.has(sameTitle(suggestion.title));
}

// One trial per title, best evidence first: both short-sleep bands ask for the
// same change, so they are one suggestion.
function factorTrials(stats, ruledOut){
  const seen = new Set();
  return stats.factors.filter(worthSuggesting).map(factorTrial).filter(trial=>{
    if(ruledOut(trial) || seen.has(trial.title)) return false;
    seen.add(trial.title);
    return true;
  });
}

const loggingTrial = (title, why) => ({
  title, action: forWeeks(TRIAL_DAYS.logging), why, confidence: 'early guess', days: TRIAL_DAYS.logging, factor_key: null,
});

function missingMost(stats){
  const { loggedDays, gaps } = stats;
  const missing = [];
  if(gaps.missingSleepDays * 2 > loggedDays) missing.push('sleep');
  if(gaps.missingFoodDays * 2 > loggedDays) missing.push('food');
  return missing;
}

function fallbackTrial(stats, ruledOut){
  if(!stats.loggedDays){
    return loggingTrial('Log your sleep, food and any headaches every day', 'Nothing is logged yet, so there is nothing to compare. Two weeks of days gives a first picture.');
  }
  if(!stats.attacks){
    return loggingTrial('Keep logging your sleep and food', 'No headaches are logged yet, so there is nothing to compare. These days become the headache-free side of the comparison.');
  }
  const missing = missingMost(stats);
  if(missing.length){
    const what = missing.join(' and ');
    return loggingTrial(`Log your ${what} every day`, `Most logged days have no ${what}, so it can't be compared with your headaches yet.`);
  }
  const headaches = plural(stats.attacks, 'headache');
  if(stats.attacks >= MIN_ATTACKS_FOR_HABIT){
    const habit = HABITS.find(h=> !ruledOut(h));
    if(habit){
      return { ...habit, action: forWeeks(TRIAL_DAYS.habit), days: TRIAL_DAYS.habit, confidence: 'early guess',
        why: `Nothing stands out across your ${headaches}, so this is a low-risk thing to test.` };
    }
  }
  return loggingTrial('Keep logging your sleep, food and headaches', `Nothing stands out across your ${headaches} yet. More logged days make the comparison clearer.`);
}

function keepLoggingNote({ gaps }){
  const { missingSleepDays, missingFoodDays, unsplitFoodEntries } = gaps;
  const biggest = Math.max(missingSleepDays, missingFoodDays, unsplitFoodEntries);
  if(!biggest) return 'Nothing is missing. Keep logging the way you have been.';
  if(biggest === unsplitFoodEntries){
    return `${unsplitFoodEntries} older food ${unsplitFoodEntries === 1 ? "entry isn't" : "entries aren't"} sorted into items yet, so ${unsplitFoodEntries === 1 ? "it doesn't" : "they don't"} count.`;
  }
  return biggest === missingSleepDays
    ? `Sleep is missing on ${plural(missingSleepDays, 'day')}.`
    : `Food is missing on ${plural(missingFoodDays, 'day')}.`;
}

function cycleNote({ cycle }){
  if(!cycle || cycle.nearPeriod < CYCLE_NOTE_MIN_DAYS || cycle.nearPeriod < cycle.counted * CYCLE_NOTE_MIN_SHARE) return null;
  return `${cycle.nearPeriod} of ${cycle.counted} headache days with a known cycle day fell between 2 days before and 3 days after a period start.`;
}

const medicationNote = ({ acuteMedDays30: days }) => (days >= ACUTE_FLAG_DAYS
  ? `You logged acute medication on ${days} of the last 30 days. That is worth raising with your doctor.`
  : null);

function doctorQuestions(stats, cycle, medication){
  const questions = [];
  if(medication) questions.push(`Could using acute medication on ${stats.acuteMedDays30} of the last 30 days be adding to my headaches?`);
  if(cycle) questions.push('Could my headaches be linked to my menstrual cycle?');
  if(stats.attacks >= MIN_ATTACKS_FOR_HABIT) questions.push(`I logged ${stats.attacks} headaches on ${plural(stats.headacheDays, 'day')}. Is there anything else you would want me to track?`);
  return questions;
}

// The Insights JSON from the spec, plus try_next.factor_key so a trial can
// record what it tested. It never suggests starting, stopping or changing
// medication, and macros cannot appear: they are never factors.
export function ruleSuggestion(stats, pastTrials = []){
  const ruledOut = notHelpedBefore(pastTrials);
  const [best, ...rest] = factorTrials(stats, ruledOut);
  const cycle_note = cycleNote(stats), medication_note = medicationNote(stats);
  const labelOf = key => stats.factors.find(f=> f.key === key).label;
  return {
    try_next: best || fallbackTrial(stats, ruledOut),
    also_watching: rest.slice(0, MAX_WATCHING).map(t=> ({ item: labelOf(t.factor_key), evidence: t.why })),
    keep_logging: keepLoggingNote(stats),
    doctor_questions: doctorQuestions(stats, cycle_note, medication_note),
    cycle_note,
    medication_note,
  };
}

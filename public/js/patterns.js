// The pattern engine: what came before headaches, compared with headache-free
// stretches, and a rule-based suggestion that always gives the person something
// to do. Pure, so the browser and the Netlify function can both import it: no
// DOM, no network, and no import of data.js or ui.js.
//
// Time. Everything runs on stored wall-clock values, so results do not depend
// on the process time zone: an attack starts at its `date` plus `time`, never at
// start_at read through local getters. A blank or invalid time counts as 12:00,
// for attacks and exposures alike. 48 hours means 48 hours on the wall clock.
//
// Lookbacks. Each headache entry is one attack (`attacks`), so one attack across
// midnight counts once. A lookback is the 48 hours before an attack's start, and
// anything logged at or after the start is out. Attacks starting under 48 hours
// after a counted attack join it and add no lookback, so one meal cannot count
// for several attacks, and every lookback is 48 hours long, like a control
// window. `headacheTotal` is therefore counted lookbacks and can be below
// `attacks`. Something logged between two clustered attacks is not counted.
//
// Control windows. Walking forward from the first logged date, two consecutive
// calendar dates form a control window when:
//   - neither date is a headache day (every date any headache touches),
//   - at least one of them has an entry, because a stretch the person never
//     logged is unknown rather than headache-free,
//   - both dates are over, so today never counts.
// A window that qualifies uses up both dates, so windows never overlap. A date
// that does not qualify moves the walk on by one. A control window can sit just
// before a headache and so overlap a lookback, which can only shrink differences.
//
// Missing data. A window with nothing logged says nothing about a factor, and
// counting it as "not seen" on the control side would inflate that factor. So a
// control window counts toward food factors only if it has a split food entry,
// and toward sleep factors only if it has sleep hours. `controlTotal` therefore
// differs between food and sleep. Lookback denominators stay at every counted
// lookback, so missing data there can only understate a factor. `gaps` reports
// what is missing. A factor seen in no lookback is left out.
//
// A log with no usable control windows. controlTotal is 0, no control count is
// invented, every factor is an early guess, and ruleSuggestion asks for more
// logging rather than naming a food. Daily coffee would otherwise look like a
// trigger.
import { shiftDate } from './dates.js';
import { TAG_LABELS, triggerLabel, visibleItems } from './food-items.js';
import { headacheDaySet, isHeadacheEntry } from './headache.js';

const LOOKBACK_MS = 48 * 3600000;

// Confidence. Logs usually hold under 20 lookbacks and hundreds of foods, so the
// best-looking factor is often luck. Each factor gets a one-sided Fisher exact
// test of "more common in lookbacks than in control windows", corrected for the
// number of factors tested:
//   strong:      5+ lookbacks, and p below 0.05 / factors tested (Bonferroni).
//   moderate:    3+ lookbacks, and within a Benjamini-Hochberg cutoff at 0.05.
//   early guess: everything else.
// Both of the first two also need 10+ control windows. On simulated pure noise,
// moderate or strong fires in about 1% of logs (see tests/patterns.test.js).
const CONFIDENCE = ['early guess', 'moderate', 'strong'];
const ALPHA = 0.05;
const MIN_CONTROLS = 10;
const MODERATE_HITS = 3;
const STRONG_HITS = 5;

const logFactorials = [0];
function logFactorial(n){
  for(let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i-1] + Math.log(i);
  return logFactorials[n];
}
const logChoose = (n, k) => logFactorial(n) - logFactorial(k) - logFactorial(n - k);

// The one comparison with the control rate: the chance of `hits` or more of
// `total` lookbacks if lookbacks and control windows do not differ.
function pAgainstControl(hits, total, control){
  const seen = hits + control.hits, windows = total + control.total;
  let p = 0;
  for(let x = hits; x <= Math.min(seen, total); x++){
    if(seen - x > control.total) continue;
    p += Math.exp(logChoose(total, x) + logChoose(control.total, seen - x) - logChoose(windows, seen));
  }
  return Math.min(p, 1);
}

const factorP = f => pAgainstControl(f.beforeHeadache, f.headacheTotal, { hits: f.controlHits, total: f.controlTotal });

// The largest p that survives Benjamini-Hochberg, or -1 when none does.
function benjaminiHochbergCutoff(ps){
  const sorted = [...ps].sort((a, b)=> a - b);
  for(let rank = sorted.length; rank > 0; rank--){
    if(sorted[rank-1] <= rank / sorted.length * ALPHA) return sorted[rank-1];
  }
  return -1;
}

// hits of total lookbacks, against `control` = { hits, total }. With no control
// counts nothing can be compared, so it is an early guess. `tested` is how many
// factors were tested, and `cutoff` the Benjamini-Hochberg cutoff across them.
export function confidenceFor(hits, total, control, { tested = 1, cutoff = ALPHA / tested } = {}){
  if(!control || control.total < MIN_CONTROLS) return 'early guess';
  const p = pAgainstControl(hits, total, control);
  if(hits >= STRONG_HITS && p < ALPHA / tested) return 'strong';
  if(hits >= MODERATE_HITS && p <= cutoff) return 'moderate';
  return 'early guess';
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
// Common pain relievers, in case one lands in the food log without ever being
// logged as a med. Logged med names and options.medNames are added to these.
const COMMON_MEDS = ['advil','aleve','aspirin','acetaminophen','excedrin','ibuprofen','motrin','naproxen','paracetamol','sumatriptan','tylenol'];

// Wall-clock milliseconds for a stored date and time. Only ever compared with
// each other, so it is safe that the numbers read as UTC.
function wallClock(date, time){
  const [year, month, day] = date.split('-').map(Number);
  const [, hh, mm] = String(time ?? '').match(/^(\d{1,2}):(\d{2})/) || [];
  const valid = hh < 24 && mm < 60;
  return Date.UTC(year, month - 1, day, valid ? Number(hh) : 12, valid ? Number(mm) : 0);
}

const hasHours = hours => hours != null && hours !== '' && Number(hours) > 0;

// Not sorted into items yet, so it says nothing about what was eaten. An entry
// the AI finished with no items is done, not unsplit.
const isUnsplit = entry => entry.split_status === 'pending'
  || (entry.split_status !== 'done' && !(Array.isArray(entry.items) && entry.items.length));

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const normalName = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// Macros, water and medicines are never food factors, so nothing downstream can
// suggest skipping them.
function isFoodFactor(name, meds){
  if(!name || MACRO_WORDS.has(name) || /\bwater\b/.test(name)) return false;
  return !meds.some(med=> ` ${name} `.includes(` ${med} `));
}

// Registers each food factor of an entry in `catalog` and returns the keys.
// Waiting entries count for nothing, like everywhere else food is totalled.
function foodKeys(entry, meds, catalog){
  if(entry.split_status === 'pending') return [];
  const keys = [];
  const note = (key, label, caffeine)=>{
    keys.push(key);
    const known = catalog.get(key);
    catalog.set(key, { label, caffeine: caffeine || Boolean(known && known.caffeine) });
  };
  for(const item of visibleItems(entry.items)){
    const name = normalName(item.name);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if(isFoodFactor(name, meds)) note(`food:${name}`, capitalize(name), tags.includes('caffeine'));
    if(FOOD_TYPE_LABELS[item.food_type]) note(`type:${item.food_type}`, FOOD_TYPE_LABELS[item.food_type], false);
    for(const tag of tags) if(TAG_LABELS[tag]) note(`tag:${tag}`, triggerLabel(tag), tag === 'caffeine');
  }
  return keys;
}

// A nap joins the night, so one day has one sleep total and one band. It is
// placed at the time of that day's first sleep entry.
function sleepExposure(date, entries, catalog){
  const nights = entries.filter(e=> e.type === 'sleep' && hasHours(e.hours));
  if(!nights.length) return null;
  const hours = nights.reduce((sum, e)=> sum + Number(e.hours), 0);
  const band = SLEEP_BANDS.find(b=> hours < b.below);
  catalog.set(band.key, { label: band.label, caffeine: false });
  return { at: Math.min(...nights.map(e=> wallClock(date, e.time))), keys: [band.key] };
}

// date -> [{ at, keys }], plus the dates with usable food and sleep data.
function readLog(days, meds, catalog){
  const byDate = new Map(), foodDates = new Set(), sleepDates = new Set();
  const add = (date, exposure)=>{
    if(!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(exposure);
  };
  for(const { date, entries } of days){
    for(const entry of entries){
      if(entry.type !== 'food') continue;
      if(!isUnsplit(entry)) foodDates.add(date);
      add(date, { at: wallClock(date, entry.time), keys: foodKeys(entry, meds, catalog) });
    }
    const sleep = sleepExposure(date, entries, catalog);
    if(sleep){ add(date, sleep); sleepDates.add(date); }
  }
  return { byDate, foodDates, sleepDates };
}

// Attacks starting under 48 hours after a counted attack join it.
function countedAttacks(attacks){
  const counted = [];
  let last = -Infinity;
  for(const attack of [...attacks].sort((a, b)=> a.start - b.start)){
    if(attack.start - last < LOOKBACK_MS) continue;
    counted.push(attack);
    last = attack.start;
  }
  return counted;
}

function lookbackKeys({ date, start }, byDate){
  const keys = new Set();
  for(let back = 0; back <= 2; back++){
    for(const { at, keys: found } of byDate.get(shiftDate(date, -back)) || []){
      if(at >= start - LOOKBACK_MS && at < start) for(const key of found) keys.add(key);
    }
  }
  return keys;
}

function controlWindows(loggedDates, headacheDays, today){
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

function tally(keySets){
  const counts = new Map();
  for(const keys of keySets) for(const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}

// Sleep first on a tie because it is the gentlest change, then the narrowest food.
const KIND_ORDER = ['sleep', 'food', 'tag', 'type'];
const kindOf = key => key.slice(0, key.indexOf(':'));

function byEvidence(a, b){
  return CONFIDENCE.indexOf(b.confidence) - CONFIDENCE.indexOf(a.confidence)
    || factorP(a) - factorP(b)
    || b.beforeHeadache - a.beforeHeadache
    || KIND_ORDER.indexOf(kindOf(a.key)) - KIND_ORDER.indexOf(kindOf(b.key))
    || a.key.localeCompare(b.key);
}

function buildFactors(lookbacks, spans, { byDate, foodDates, sleepDates }, catalog){
  const usable = dates => spans.filter(span=> span.some(date=> dates.has(date)));
  const keysIn = span => span.flatMap(date=> (byDate.get(date) || []).flatMap(e=> e.keys));
  // Food keys only appear on dates with split food, sleep keys on dates with
  // hours, so counting every span's keys gives the hits for either family.
  const inControl = tally(spans.map(span=> new Set(keysIn(span))));
  const totals = { sleep: usable(sleepDates).length, food: usable(foodDates).length };
  const factors = [...tally(lookbacks)].map(([key, beforeHeadache])=> ({
    key, label: catalog.get(key).label, beforeHeadache, headacheTotal: lookbacks.length,
    controlHits: inControl.get(key) || 0, controlTotal: kindOf(key) === 'sleep' ? totals.sleep : totals.food,
  }));
  const cutoff = benjaminiHochbergCutoff(factors.map(factorP));
  for(const f of factors){
    f.confidence = confidenceFor(f.beforeHeadache, f.headacheTotal, { hits: f.controlHits, total: f.controlTotal }, { tested: factors.length, cutoff });
    if(catalog.get(f.key).caffeine) f.caffeine = true;
  }
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

function acuteDaysInLast30(days, today){
  const oldest = shiftDate(today, -29);
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
// `today` is the person's own date. Callers should pass it: the fallback is the
// UTC date of `now`, which keeps results the same in every process time zone but
// can be a day off near midnight. `medNames` adds to the logged med names.
export function buildStats(days, { now = new Date(), today = now.toISOString().slice(0, 10), medNames = [] } = {}){
  const headacheDays = headacheDaySet(days);
  const logged = days.filter(d=> d.entries.length);
  const loggedMeds = days.flatMap(d=> d.entries.filter(e=> e.type === 'meds').map(e=> e.name));
  const meds = [...new Set([...COMMON_MEDS, ...loggedMeds, ...medNames].map(normalName))].filter(Boolean);
  const catalog = new Map();
  const log = readLog(days, meds, catalog);
  const attacks = days.flatMap(({ date, entries })=> entries.filter(isHeadacheEntry)
    .map(entry=> ({ date, start: wallClock(date, entry.time) })));
  const lookbacks = countedAttacks(attacks).map(attack=> lookbackKeys(attack, log.byDate));
  const spans = controlWindows(new Set(logged.map(d=> d.date)), headacheDays, today);
  return {
    attacks: attacks.length,
    headacheDays: headacheDays.size,
    loggedDays: logged.length,
    factors: buildFactors(lookbacks, spans, log, catalog),
    cycle: cycleStats(days),
    acuteMedDays30: acuteDaysInLast30(days, today),
    gaps: logGaps(logged),
  };
}

// Food suggestions run 2 to 4 weeks: the wider the change, the longer it needs
// to show, since it is harder to keep to and takes in more meals. Caffeine gets
// 3 weeks whatever the factor, because the first week is spent easing down.
const TRIAL_DAYS = { sleep: 14, food: 14, tag: 21, type: 28, habit: 14, logging: 14, caffeine: 21 };
const forWeeks = days => `Do this for the next ${days / 7} weeks`;
const MIN_HITS_TO_SUGGEST = 2;
const MAX_P_TO_SUGGEST = 0.2;     // loose on purpose: an early guess is still worth a try
const MIN_ATTACKS_FOR_HABIT = 3;
const MAX_WATCHING = 3;
const ACUTE_FLAG_DAYS = 8;        // the same line as the medication flag in insights.js
const CYCLE_NOTE_MIN_DAYS = 3;
const CYCLE_NOTE_MIN_SHARE = 0.5;

const SLEEP_TITLE = 'Aim for 7+ hours of sleep';
// The only food groups narrow enough to try cutting. The rest go to the doctor.
const SUGGESTIBLE_TYPES = new Set(['type:dairy', 'type:sweets_snacks']);
const isBroadType = f => kindOf(f.key) === 'type' && !SUGGESTIBLE_TYPES.has(f.key);

const HABITS = [
  { factor_key:'habit:steady_sleep', title:'Keep a steady sleep schedule' },
  { factor_key:'habit:regular_meals', title:'Eat at regular times' },
  { factor_key:'habit:water', title:'Drink water through the day' },
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const inSentence = label => (/^[A-Z]+$/.test(label) ? label : label.toLowerCase());
const sameTitle = title => String(title ?? '').trim().toLowerCase();

function evidence(f, stats){
  const headaches = f.headacheTotal === stats.attacks ? 'headaches' : 'headache spells';
  return `${f.label} came before ${f.beforeHeadache} of ${f.headacheTotal} ${headaches}, compared with ${f.controlHits} of ${f.controlTotal} headache-free stretches.`;
}

function factorTrial(f, stats){
  const why = evidence(f, stats);
  if(kindOf(f.key) === 'sleep'){
    return { title: SLEEP_TITLE, action: forWeeks(TRIAL_DAYS.sleep), why, confidence: f.confidence, days: TRIAL_DAYS.sleep, factor_key: f.key };
  }
  if(f.caffeine){
    const days = TRIAL_DAYS.caffeine, weeks = days / 7;
    return { title: `Ease off ${inSentence(f.label)} for ${weeks} weeks`, why, confidence: f.confidence, days, factor_key: f.key,
      action: `Cut down gradually over a week or so, because stopping suddenly can trigger headaches. Then stay low for the rest of the ${weeks} weeks` };
  }
  const days = TRIAL_DAYS[kindOf(f.key)];
  return { title: `Skip ${inSentence(f.label)} for ${days / 7} weeks`, action: forWeeks(days), why, confidence: f.confidence, days, factor_key: f.key };
}

// A signal at all: seen more than once, with windows to compare, and leaning
// toward headaches. More sleep cannot answer 7+ hours.
const hasSignal = f => f.key !== 'sleep:7_plus' && f.controlTotal > 0
  && f.beforeHeadache >= MIN_HITS_TO_SUGGEST && factorP(f) <= MAX_P_TO_SUGGEST;

const worthSuggesting = f => hasSignal(f) && !isBroadType(f);

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
  return stats.factors.filter(worthSuggesting).map(f=> factorTrial(f, stats)).filter(trial=>{
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
  if(stats.factors.every(f=> !f.controlTotal)){
    return loggingTrial('Keep logging your sleep and food, on good days too', 'There are no headache-free stretches with sleep or food logged to compare with yet, so nothing can be singled out.');
  }
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

// A broad food group can be the top signal without being a safe thing to cut
// alone. Noise should not reach the doctor, so an early guess stays out.
function broadGroupQuestion(stats){
  const top = stats.factors.find(hasSignal);
  if(!top || !isBroadType(top) || top.confidence === 'early guess') return null;
  return `${evidence(top, stats)} Is that worth looking into?`;
}

function doctorQuestions(stats, cycle, medication){
  const questions = [];
  const broadGroup = broadGroupQuestion(stats);
  if(broadGroup) questions.push(broadGroup);
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

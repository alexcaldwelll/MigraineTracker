// Fictional sample data for the demo. Pure: no DOM, no storage, no network.
// Everything here is invented. The same date always gives the same data, so the
// demo looks the same every time, and it ends at `today` so it never goes stale.
import { shiftDate } from './dates.js';
import { reviewTrial } from './trials.js';

export const DEMO_DAYS = 56;

// Days back from today with a headache, newest last. At least a week apart so
// each one is its own cluster for patterns.js.
const HEADACHE_OFFSETS = [52, 44, 36, 28, 17, 9, 3];
// The evening before each of these, a dinner with aged cheese was logged.
const CHEESE_BEFORE = new Set(HEADACHE_OFFSETS);
// A few cheese dinners with no headache after, so the pattern is not perfect.
const CHEESE_QUIET = new Set([40, 23, 13]);
// Short nights before most headaches, plus a few without one.
const SHORT_NIGHT = new Set([...HEADACHE_OFFSETS.filter(o => o !== 28), 31, 20]);
// Period starts (4 days of flow each).
const PERIOD_STARTS = [47, 19];

// mulberry32: a small seeded generator.
function seeded(seed){
  let a = seed >>> 0;
  return ()=>{
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const item = (name, main_macro, food_type, protein_g, carbs_g, fat_g, tags = [])=>
  ({ name, main_macro, food_type, protein_g, carbs_g, fat_g, tags });

const COFFEE = item('Coffee with milk', 'carbs', 'drinks', 2, 4, 2, ['caffeine']);

const BREAKFASTS = [
  { text: 'Oatmeal with blueberries and a coffee', items: [item('Oatmeal', 'carbs', 'grains', 6, 27, 3), item('Blueberries', 'carbs', 'fruit_veg', 1, 14, 0), COFFEE] },
  { text: 'Two eggs on toast and a coffee', items: [item('Scrambled eggs', 'protein', 'meat_fish', 12, 1, 10), item('Whole wheat toast', 'carbs', 'grains', 5, 24, 2), COFFEE] },
  { text: 'Yogurt with granola and a coffee', items: [item('Plain yogurt', 'protein', 'dairy', 9, 11, 4), item('Granola', 'carbs', 'grains', 4, 30, 8), COFFEE] },
  { text: 'Banana and peanut butter toast with a coffee', items: [item('Banana', 'carbs', 'fruit_veg', 1, 27, 0), item('Peanut butter toast', 'fat', 'legumes_nuts', 9, 20, 12), COFFEE] },
];
const LUNCHES = [
  { text: 'Turkey sandwich and an apple', items: [item('Turkey sandwich', 'protein', 'meat_fish', 24, 36, 8), item('Apple', 'carbs', 'fruit_veg', 0, 25, 0)] },
  { text: 'Chicken and rice bowl with broccoli', items: [item('Grilled chicken', 'protein', 'meat_fish', 35, 0, 6), item('White rice', 'carbs', 'grains', 4, 44, 0), item('Broccoli', 'carbs', 'fruit_veg', 3, 6, 0)] },
  { text: 'Lentil soup and a roll', items: [item('Lentil soup', 'carbs', 'legumes_nuts', 12, 30, 3), item('Bread roll', 'carbs', 'grains', 4, 20, 2)] },
  { text: 'Tuna salad wrap', items: [item('Tuna salad wrap', 'protein', 'meat_fish', 26, 30, 12)] },
  { text: 'Hummus, cucumber and pita', items: [item('Hummus', 'fat', 'legumes_nuts', 6, 14, 10), item('Cucumber', 'carbs', 'fruit_veg', 1, 4, 0), item('Pita bread', 'carbs', 'grains', 5, 33, 1)] },
];
const DINNERS = [
  { text: 'Baked salmon, potatoes and green beans', items: [item('Baked salmon', 'protein', 'meat_fish', 34, 0, 14), item('Roasted potatoes', 'carbs', 'fruit_veg', 4, 36, 5), item('Green beans', 'carbs', 'fruit_veg', 2, 7, 0)] },
  { text: 'Vegetable stir fry with tofu and rice', items: [item('Tofu stir fry', 'protein', 'legumes_nuts', 18, 14, 12), item('White rice', 'carbs', 'grains', 4, 44, 0)] },
  { text: 'Spaghetti with tomato sauce and a side salad', items: [item('Spaghetti with tomato sauce', 'carbs', 'grains', 12, 80, 6), item('Side salad', 'carbs', 'fruit_veg', 1, 5, 4)] },
  { text: 'Chicken tacos with salsa', items: [item('Chicken tacos', 'protein', 'meat_fish', 28, 30, 10), item('Salsa', 'carbs', 'fruit_veg', 1, 4, 0)] },
  { text: 'Beef chili with beans', items: [item('Beef chili', 'protein', 'meat_fish', 26, 24, 12)] },
  { text: 'Veggie omelet and toast', items: [item('Veggie omelet', 'protein', 'meat_fish', 16, 4, 14), item('Whole wheat toast', 'carbs', 'grains', 5, 24, 2)] },
];
const CHEESE_DINNERS = [
  { text: 'Burger with aged cheddar and fries', items: [item('Beef burger', 'protein', 'meat_fish', 30, 30, 22), item('Aged cheddar', 'fat', 'dairy', 7, 0, 9, ['aged_cheese']), item('Fries', 'carbs', 'fruit_veg', 4, 40, 15)] },
  { text: 'Mac and cheese made with aged cheddar', items: [item('Macaroni', 'carbs', 'grains', 12, 60, 4), item('Aged cheddar sauce', 'fat', 'dairy', 14, 4, 20, ['aged_cheese'])] },
  { text: 'Pizza with parmesan and a side salad', items: [item('Cheese pizza', 'carbs', 'grains', 22, 70, 20), item('Parmesan', 'fat', 'dairy', 5, 0, 4, ['aged_cheese']), item('Side salad', 'carbs', 'fruit_veg', 1, 5, 4)] },
];
const SNACKS = [
  { text: 'A square of dark chocolate', items: [item('Dark chocolate', 'fat', 'sweets_snacks', 1, 7, 5, ['chocolate', 'caffeine'])] },
  { text: 'Almonds and a pear', items: [item('Almonds', 'fat', 'legumes_nuts', 6, 6, 14), item('Pear', 'carbs', 'fruit_veg', 1, 27, 0)] },
  { text: 'Crackers and carrot sticks', items: [item('Crackers', 'carbs', 'grains', 3, 20, 4), item('Carrot sticks', 'carbs', 'fruit_veg', 1, 6, 0)] },
];

const food = (time, meal)=> ({ type: 'food', time, text: meal.text, split_status: 'done', items: meal.items.map(i => ({ ...i, tags: [...i.tags] })) });
const pick = (rand, list)=> list[Math.floor(rand() * list.length)];

function sleepEntry(rand, short){
  const hours = short ? 5.2 + Math.round(rand() * 6) / 10 : 6.8 + Math.round(rand() * 14) / 10;
  const wakeMin = 6 * 60 + 45;
  const bedMin = (wakeMin - Math.round(hours * 60) + 1440) % 1440;
  const clock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const quality = short ? 'poor' : hours >= 7.5 ? 'good' : 'fair';
  return { type: 'sleep', time: '07:00', bedtime: clock(bedMin), waketime: clock(wakeMin), hours, quality,
    wakeFeeling: short ? 'groggy' : 'refreshed', interruptions: [], note: null };
}

function headacheEntry(date, index){
  const kinds = [
    { severity: 6, time: '11:30', duration: 7, symptoms: ['nausea', 'light_sensitivity'], fog: 'mild', dizziness: null },
    { severity: 4, time: '15:10', duration: 4, symptoms: ['neck_pain'], fog: null, dizziness: null },
    { severity: 8, time: '10:20', duration: 9, symptoms: ['nausea', 'light_sensitivity', 'sound_sensitivity'], fog: 'severe', dizziness: 'mild' },
    { severity: 5, time: '14:00', duration: 5, symptoms: ['light_sensitivity'], fog: 'mild', dizziness: null },
    { severity: 3, time: '16:45', duration: 3, symptoms: [], fog: null, dizziness: null },
    { severity: 7, time: '09:40', duration: 8, symptoms: ['nausea', 'sound_sensitivity'], fog: 'mild', dizziness: 'mild' },
    { severity: 5, time: '13:15', duration: 4, symptoms: ['light_sensitivity', 'neck_pain'], fog: null, dizziness: null },
  ];
  const k = kinds[index % kinds.length];
  const start = new Date(`${date}T${k.time}:00`);
  return { type: 'headache', time: k.time, severity: k.severity, duration: k.duration, open: false,
    start_at: start.toISOString(), end_at: new Date(start.getTime() + k.duration * 3600000).toISOString(),
    fog: k.fog, dizziness: k.dizziness, symptoms: k.symptoms, note: null };
}

// today is 'YYYY-MM-DD'. Returns { days, meds, trials }. Days run oldest first,
// entries carry no ids (the backend assigns them), and nothing is logged after
// the morning of `today`, so the person can log the rest of the day.
export function buildDemoData(today){
  const rand = seeded(20260611);
  const days = [];
  const headacheDates = new Map(HEADACHE_OFFSETS.map((o, i) => [shiftDate(today, -o), i]));
  const periodDates = new Set(PERIOD_STARTS.flatMap(s => [0, 1, 2, 3].map(n => shiftDate(today, -(s - n)))));

  for(let offset = DEMO_DAYS; offset >= 0; offset--){
    const date = shiftDate(today, -offset);
    const isToday = offset === 0;
    const entries = [];
    entries.push(sleepEntry(rand, SHORT_NIGHT.has(offset)));
    entries.push(food('08:00', pick(rand, BREAKFASTS)));
    if(!isToday){
      entries.push(food('12:30', pick(rand, LUNCHES)));
      const cheeseTonight = CHEESE_BEFORE.has(offset - 1) || CHEESE_QUIET.has(offset);
      entries.push(food('19:00', cheeseTonight ? pick(rand, CHEESE_DINNERS) : pick(rand, DINNERS)));
      if(rand() < 0.35) entries.push(food('16:00', pick(rand, SNACKS)));
    }
    entries.push({ type: 'hydration', time: '09:00', amount: isToday ? 16 : 40 + Math.round(rand() * 4) * 8 });
    if(headacheDates.has(date)){
      const idx = headacheDates.get(date);
      entries.push(headacheEntry(date, idx));
      entries.push({ type: 'meds', time: '12:00', name: 'Ibuprofen', category: 'acute', dose: '400 mg' });
    }
    if(periodDates.has(date)){
      entries.push({ type: 'period', time: '08:30', flow: ['heavy', 'medium', 'light', 'light'][Math.min(3, Math.max(0, countBack(periodDates, date)))], note: null });
    }
    if(!isToday && rand() < 0.5) entries.push({ type: 'meds', time: '08:15', name: 'Magnesium', category: 'supplement', dose: '200 mg' });
    if(!isToday && offset % 3 === 1 && !headacheDates.has(date)) entries.push({ type: 'workout', time: '17:30', activity: 'Walk', duration: 35, strain: null, hr: null, calories: null, note: null });
    if(offset === 3) entries.push({ type: 'prodrome', time: '08:45', symptoms: ['yawning', 'neck_stiffness'], note: null });
    if(offset === 9) entries.push({ type: 'note', time: '21:00', stress: 'high', text: 'Deadline week. Busy and skipped a proper lunch.' });
    entries.sort((a, b) => a.time.localeCompare(b.time));
    days.push({ date, entries });
  }

  const meds = [
    { id: 'demo-med-1', name: 'Ibuprofen', category: 'acute', default_dose: '400 mg', created_at: `${shiftDate(today, -DEMO_DAYS)}T09:00:00.000Z` },
    { id: 'demo-med-2', name: 'Magnesium', category: 'supplement', default_dose: '200 mg', created_at: `${shiftDate(today, -DEMO_DAYS)}T09:01:00.000Z` },
  ];

  // Trials: a finished sleep trial reviewed against the sample days, and a
  // cheese trial that started two days ago and is still running.
  const finishedStart = shiftDate(today, -27);
  const finished = {
    id: 'demo-trial-1',
    suggestion: { title: 'Aim for 7+ hours of sleep', action: 'Be in bed early enough for 7 or more hours of sleep, most nights.', why: 'Short nights came before several of your headaches.', confidence: 'moderate', days: 14, factor_key: 'sleep:under_6' },
    start_date: finishedStart,
    end_date: shiftDate(finishedStart, 13),
    status: 'completed',
    created_at: `${finishedStart}T08:00:00.000Z`,
  };
  finished.result = reviewTrial(finished, days);
  const activeStart = shiftDate(today, -2);
  const active = {
    id: 'demo-trial-2',
    suggestion: { title: 'Try going without aged cheese', action: 'Skip aged cheeses such as cheddar and parmesan for the next 3 weeks.', why: 'Aged cheese was logged the day before most of your headaches.', confidence: 'moderate', days: 21, factor_key: 'tag:aged_cheese' },
    start_date: activeStart,
    end_date: shiftDate(activeStart, 20),
    status: 'active',
    result: null,
    created_at: `${activeStart}T08:00:00.000Z`,
  };
  return { days, meds, trials: [active, finished] };
}

// Which day of the flow this is: 0 for the first day.
function countBack(periodDates, date){
  let n = 0;
  while(periodDates.has(shiftDate(date, -(n + 1)))) n++;
  return n;
}

// The demo backend: the same interface as the Supabase one, held in memory.
// It is filled with fictional sample data, resets on refresh, and makes no
// network call, not even for the AI. Nothing here touches the DOM or storage.
import { localDate } from './dates.js';
import { buildDemoData } from './demo-data.js';

export const SCREENSHOTS_OFF = 'Screenshots are turned off in the demo.';

const copy = value => structuredClone(value);

// Counts match buildStats on the sample data (checked in tests/demo.test.js).
// Worded to pass validateInsight with no AI call.
export const DEMO_INSIGHT = {
  try_next: {
    title: 'Keep a steady sleep schedule',
    action: 'Go to bed and get up at about the same time every day for the next 2 weeks, aiming for 7 or more hours.',
    why: 'Under 6 hours of sleep came before 6 of your 7 headaches, and before only 2 of 22 headache-free stretches.',
    confidence: 'moderate',
    days: 14,
    factor_key: 'sleep:under_6',
  },
  also_watching: [
    { item: 'Aged cheese', evidence: 'It was logged in the 48 hours before 7 of 7 headaches, and in 5 of 22 headache-free stretches. You are already testing this one.' },
    { item: 'Short nights and busy days together', evidence: 'Your two worst headaches followed a short night, and one came during a high-stress week.' },
  ],
  keep_logging: 'Keep logging meals and sleep, even on days without a headache. Those days are what the comparison needs.',
  doctor_questions: [
    'Do my headaches line up with my cycle closely enough to track it formally?',
    'How often is it safe for me to use ibuprofen for a headache?',
  ],
  cycle_note: '2 of your 7 headaches started within a few days of a period.',
  medication_note: 'Ibuprofen was logged on 4 of the last 30 days.',
};

// Simple word lookup: enough to split what a visitor types, nothing more.
const FOODS = [
  [/\b(coffee|espresso|latte|cappuccino)\b/, ['drinks', 'carbs', 2, 4, 2, ['caffeine']]],
  [/\b(tea|matcha)\b/, ['drinks', 'carbs', 0, 0, 0, ['caffeine']]],
  [/\b(cola|soda|diet coke|energy drink)\b/, ['drinks', 'carbs', 0, 39, 0, ['caffeine']]],
  [/\b(cheddar|parmesan|gouda|blue cheese|brie|gruyere|aged cheese)\b/, ['dairy', 'fat', 7, 0, 9, ['aged_cheese']]],
  [/\b(cheese|yogurt|milk|butter|cream)\b/, ['dairy', 'fat', 6, 2, 8, []]],
  [/\b(wine|beer|whiskey|vodka|cocktail)\b/, ['drinks', 'carbs', 0, 4, 0, ['alcohol']]],
  [/\b(chocolate|cocoa)\b/, ['sweets_snacks', 'fat', 1, 7, 5, ['chocolate']]],
  [/\b(bacon|salami|sausage|ham|hot dog|pepperoni|jerky)\b/, ['meat_fish', 'protein', 10, 1, 14, ['processed_meat']]],
  [/\b(chicken|turkey|beef|steak|pork|fish|salmon|tuna|shrimp|egg|eggs|tofu)\b/, ['meat_fish', 'protein', 25, 0, 8, []]],
  [/\b(rice|pasta|spaghetti|noodles|bread|toast|bagel|oatmeal|cereal|pizza|sandwich)\b/, ['grains', 'carbs', 8, 45, 5, []]],
  [/\b(apple|banana|orange|berries|blueberries|grapes|salad|broccoli|carrot|carrots|potato|potatoes|beans|spinach)\b/, ['fruit_veg', 'carbs', 2, 20, 1, []]],
  [/\b(nuts|almonds|peanut butter|hummus|lentils)\b/, ['legumes_nuts', 'fat', 7, 10, 14, []]],
  [/\b(cookie|cookies|cake|candy|chips|ice cream|donut)\b/, ['sweets_snacks', 'carbs', 2, 30, 12, []]],
];

export function demoSplitFood(text){
  const pieces = String(text ?? '').split(/,|;|\band\b|\bwith\b|\bplus\b|\n/i)
    .map(piece => piece.trim().replace(/^(a|an|the|some|of)\s+/i, '').replace(/[.!]+$/, ''))
    .filter(Boolean)
    .slice(0, 8);
  const items = pieces.map(name => {
    const hit = FOODS.find(([pattern]) => pattern.test(name.toLowerCase()));
    const [food_type, main_macro, protein_g, carbs_g, fat_g, tags] = hit ? hit[1] : ['other', 'carbs', 0, 0, 0, []];
    return { name: name.slice(0, 100), main_macro, food_type, protein_g, carbs_g, fat_g, tags: [...tags] };
  });
  return { items };
}

export function createDemoBackend(today = localDate()){
  const sample = buildDemoData(today);
  let nextId = 1;
  const newId = () => `demo-${nextId++}`;
  const stamp = () => new Date().toISOString();

  // Rows in insertion order, like a table.
  const rows = sample.days.flatMap(({ date, entries }) =>
    entries.map(({ type, time, ...rest }) => ({ id: newId(), date, time, type, data: rest })));
  const toEntry = row => copy({ id: row.id, type: row.type, time: row.time, ...row.data });
  const toRow = (date, { type, time, ...data }) => ({ date, time, type, data: copy(data) });
  const byTime = (a, b) => String(a.time).localeCompare(String(b.time));

  let meds = sample.meds.map(copy);
  let settings = { password_set_at: stamp(), ai_notice_seen_at: stamp() };
  let insight = { result: { ...copy(DEMO_INSIGHT), source: 'ai' }, created_at: stamp() };
  let trials = sample.trials.map(copy);

  return {
    demo: true,

    async listDay(date){
      return rows.filter(row => row.date === date).sort(byTime).map(toEntry);
    },
    async listAll(){
      const byDate = new Map();
      for(const row of [...rows].sort((a, b) => b.date.localeCompare(a.date) || byTime(a, b))){
        if(!byDate.has(row.date)) byDate.set(row.date, []);
        byDate.get(row.date).push(toEntry(row));
      }
      return Array.from(byDate, ([date, entries]) => ({ date, entries }));
    },
    async add(date, entry){
      const row = { id: newId(), ...toRow(date, entry) };
      rows.push(row);
      return row.id;
    },
    async update(id, date, entry){
      const at = rows.findIndex(row => row.id === id);
      if(at >= 0) rows[at] = { id, ...toRow(date, entry) };
    },
    async remove(id){
      const at = rows.findIndex(row => row.id === id);
      if(at >= 0) rows.splice(at, 1);
    },

    async listMeds(){ return meds.map(copy); },
    async addMed(med){ meds.push({ ...copy(med), id: newId(), created_at: stamp() }); },
    async removeMed(id){ meds = meds.filter(med => med.id !== id); },

    async getSettings(){ return copy(settings); },
    async saveSettings(patch){ settings = { ...settings, ...copy(patch) }; },

    async getInsight(){ return insight ? copy(insight) : null; },
    async saveInsight(result){ insight = { result: copy(result), created_at: stamp() }; },

    async listTrials(){
      return [...trials].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(copy);
    },
    async saveTrial(trial){
      const saved = trial.id
        ? { ...trials.find(t => t.id === trial.id), ...copy(trial) }
        : { ...copy(trial), id: newId(), created_at: stamp() };
      trials = trial.id && trials.some(t => t.id === trial.id)
        ? trials.map(t => t.id === trial.id ? saved : t)
        : [saved, ...trials];
      return copy(saved);
    },

    // No network: pre-written answers only.
    async ai(action, payload){
      if(action === 'split_food' || action === 'backfill_food') return demoSplitFood(payload && payload.text);
      if(action === 'analyze') return { result: copy(DEMO_INSIGHT), source: 'ai' };
      if(action === 'read_screenshot') throw new Error(SCREENSHOTS_OFF);
      throw new Error('That is not available in the demo.');
    },
  };
}

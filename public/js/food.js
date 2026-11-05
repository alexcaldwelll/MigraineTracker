// Food splitting in the browser: save first, then ask the AI to sort the text
// into items. DOM-free, so it imports in Node.
import { data } from './data.js';
import { localDate, shiftDate } from './dates.js';

// An item the person deleted is kept as {edited: true, removed: true}. It is
// hidden everywhere (visibleItems), and because edited items always survive a
// merge and block a same-named incoming item, a re-split cannot bring it back.
export function visibleItems(items){
  return (Array.isArray(items) ? items : []).filter(item=> item && item.removed !== true);
}

// Edited items always survive. Incoming items replace the rest, except an
// incoming item that has the same name as an edited one.
export function mergeItems(existing, incoming){
  const kept = (existing || []).filter(item=> item && item.edited === true);
  const names = new Set(kept.map(item=> String(item.name).trim().toLowerCase()));
  const fresh = (incoming || []).filter(item=> !names.has(String(item.name).trim().toLowerCase()));
  return [...kept, ...fresh];
}

export function canSendToAi(settings){
  return Boolean(settings && settings.ai_notice_seen_at);
}

export const TAG_LABELS = {
  caffeine:'Caffeine', alcohol:'Alcohol', aged_cheese:'Aged cheese', processed_meat:'Processed meat',
  chocolate:'Chocolate', msg:'MSG', artificial_sweetener:'Artificial sweetener',
};
export const triggerLabel = tag => TAG_LABELS[tag] || String(tag);

const MACRO_KEY = { protein: 'protein_g', carbs: 'carbs_g', fat: 'fat_g' };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Every food amount shown in the app is an estimate, so it starts with "~".
export function formatAmount(grams, macro){
  const g = Math.round(num(grams));
  return macro ? `~${g}g ${macro}` : `~${g}g`;
}

// Items that count: visible ones, on entries that are not waiting for the AI.
function countedItems(entries){
  return (entries || [])
    .filter(e=> e && e.type === 'food' && e.split_status !== 'pending')
    .flatMap(e=> visibleItems(e.items));
}

export function dayTotals(entries){
  const total = { protein_g: 0, carbs_g: 0, fat_g: 0 };
  for(const item of countedItems(entries)){
    for(const key of Object.values(MACRO_KEY)) total[key] += num(item[key]);
  }
  for(const key of Object.keys(total)) total[key] = Math.round(total[key] * 10) / 10;
  return total;
}

export function triggerTags(entries){
  const seen = new Set();
  for(const item of countedItems(entries)){
    for(const tag of (Array.isArray(item.tags) ? item.tags : [])) seen.add(tag);
  }
  return [...seen];
}

// The macro to show an item's amount in, with its grams.
export function itemAmount(item){
  const macro = MACRO_KEY[item.main_macro] ? item.main_macro : null;
  return macro ? formatAmount(item[MACRO_KEY[macro]], macro) : '';
}

// Reads the stored entry fresh, so nothing the person changed meanwhile is lost.
async function currentEntry(date, id){
  const entries = await data().listDay(date);
  const found = (entries || []).find(e=> e.id === id);
  if(!found) return null;
  const { id: _id, date: _date, ...row } = found;
  return row;
}

// One person edit of a food entry's items, saved with edited: true.
// change = { item, index?, name? }: `item` null deletes (marks removed); no
// `index` adds. `name` guards against the list having moved since it was drawn.
// Returns false when the entry or item is gone.
export async function changeEntryItems(date, id, change){
  const row = await currentEntry(date, id);
  if(!row) return false;
  const items = Array.isArray(row.items) ? row.items.slice() : [];
  if(change.index == null){
    items.push({ ...change.item, edited: true });
  }else{
    let at = items[change.index] && items[change.index].name === change.name ? change.index : items.findIndex(i=> i && i.name === change.name);
    if(at < 0) return false;
    items[at] = change.item === null ? { ...items[at], edited: true, removed: true } : { ...change.item, edited: true };
  }
  await data().update(id, date, { ...row, items });
  return true;
}

// `entry` is a stored food entry ({id, type, time, text, ...}). Never rejects.
// The row's data never gets id or date written into it. The AI call can be
// slow, so the final write starts from the entry as it is then: if the text
// changed or the entry is gone, nothing is written.
// options.action 'backfill_food' is the quiet path for old entries: nothing is
// written before the call, and nothing on failure, so the entry stays as it was.
// Returns 'done', 'rate_limited' (HTTP 429), or 'skipped'/'failed'.
export async function splitEntry(date, entry, { action = 'split_food' } = {}){
  const backfill = action === 'backfill_food';
  try{
    const { id, date: _date, ...clean } = entry;
    if(!id) return 'skipped';
    if(!backfill && clean.split_status !== 'pending'){
      await data().update(id, date, { ...clean, split_status: 'pending' });
    }
    const settings = await data().getSettings();
    if(!canSendToAi(settings)) return 'skipped';   // stays pending until the notice is accepted
    let incoming = null, limited = false;
    try{
      const result = await data().ai(action, { text: clean.text });
      incoming = Array.isArray(result && result.items) ? result.items : [];
    }catch(error){
      console.error(error);
      limited = Boolean(error && error.status === 429);
    }
    if(backfill && !incoming) return limited ? 'rate_limited' : 'failed';
    const row = await currentEntry(date, id);
    if(!row || row.text !== clean.text) return 'skipped';
    await data().update(id, date, incoming
      ? { ...row, split_status: 'done', items: mergeItems(row.items, incoming) }
      : { ...row, split_status: 'failed' });
    return incoming ? 'done' : 'failed';
  }catch(error){
    console.error(error);
    return 'failed';
  }
}

export const BACKFILL_SIZE = 10;

// Old food entries (no split_status, no items), newest first, at most `size`.
// `days` is listAll's [{date, entries}]; each returned entry carries its date.
// pending and failed entries belong to retryPendingSplits and Retry. An entry
// with any items (edited ones included) is not unsplit, so it is left alone.
export function pickBackfillBatch(days, size = BACKFILL_SIZE){
  const found = [];
  for(const day of days || []){
    for(const e of (day && day.entries) || []){
      const unsplit = !Array.isArray(e.items) || e.items.length === 0;
      if(e && e.type === 'food' && !e.split_status && unsplit && typeof e.text === 'string' && e.text.trim()){
        found.push({ ...e, date: day.date });
      }
    }
  }
  found.sort((a, b)=> a.date !== b.date ? (a.date < b.date ? 1 : -1) : String(b.time || '').localeCompare(String(a.time || '')));
  return found.slice(0, size);
}

// One batch per app open, one request at a time. Stops quietly on a 429.
// Returns how many entries were split.
export async function backfillFood(days, size = BACKFILL_SIZE){
  try{
    if(!canSendToAi(await data().getSettings())) return 0;
    let done = 0;
    for(const entry of pickBackfillBatch(days, size)){
      const result = await splitEntry(entry.date, entry, { action: 'backfill_food' });
      if(result === 'done') done++;
      if(result === 'rate_limited') break;
    }
    return done;
  }catch(error){
    console.error(error);
    return 0;
  }
}

export const RETRY_DAYS = 7;
export const RETRY_LIMIT = 5;

// On app open: pending food entries from the last 7 days, newest first, at most
// 5, one at a time. `days` is listAll's [{date, entries}]. Returns how many ran.
export async function retryPendingSplits(days, now = new Date()){
  try{
    if(!canSendToAi(await data().getSettings())) return 0;
    const today = localDate(now), oldest = shiftDate(today, -RETRY_DAYS);
    const todo = [];
    for(const day of [...(days || [])].sort((a,b)=> a.date < b.date ? 1 : -1)){
      if(day.date < oldest || day.date > today) continue;
      const pending = day.entries.filter(e=> e.type === 'food' && e.split_status === 'pending');
      for(const entry of pending.reverse()) todo.push({ date: day.date, entry });
    }
    const batch = todo.slice(0, RETRY_LIMIT);
    for(const { date, entry } of batch) await splitEntry(date, entry);
    return batch.length;
  }catch(error){
    console.error(error);
    return 0;
  }
}

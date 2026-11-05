// Food splitting in the browser: save first, then ask the AI to sort the text
// into items. DOM-free, so it imports in Node.
import { data } from './data.js';

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

// `entry` is a stored food entry ({id, type, time, text, ...}). Never rejects.
// The row's data never gets id or date written into it.
export async function splitEntry(date, entry){
  try{
    const { id, date: _date, ...clean } = entry;
    if(!id) return;
    if(clean.split_status !== 'pending'){
      await data().update(id, date, { ...clean, split_status: 'pending' });
    }
    const settings = await data().getSettings();
    if(!canSendToAi(settings)) return;   // stays pending until the notice is accepted
    try{
      const result = await data().ai('split_food', { text: clean.text });
      const incoming = Array.isArray(result && result.items) ? result.items : [];
      await data().update(id, date, {
        ...clean,
        split_status: 'done',
        items: mergeItems(clean.items, incoming),
      });
    }catch(error){
      console.error(error);
      await data().update(id, date, { ...clean, split_status: 'failed' });
    }
  }catch(error){
    console.error(error);
  }
}

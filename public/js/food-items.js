// Food item rules with no imports, so the patterns code and the server can
// share them without pulling in data.js.

// An item the person deleted is kept as {edited: true, removed: true}. It is
// hidden everywhere (visibleItems), and because edited items always survive a
// merge and block a same-named incoming item, a re-split cannot bring it back.
export function visibleItems(items){
  return (Array.isArray(items) ? items : []).filter(item=> item && item.removed !== true);
}

// What an entry says was eaten, as lowercase names. A split entry gives its
// items, and an old unsplit one its text. Deleted items stay gone, and a split
// that found no food gives nothing, so the text never brings either back.
export function foodNames(entry){
  const plain = name => String(name ?? '').trim().toLowerCase();
  const items = Array.isArray(entry.items) ? entry.items : [];
  if(items.length) return visibleItems(items).map(item=> plain(item.name)).filter(Boolean);
  const text = plain(entry.text);
  return text && entry.split_status !== 'done' ? [text] : [];
}

export const TAG_LABELS = {
  caffeine:'Caffeine', alcohol:'Alcohol', aged_cheese:'Aged cheese', processed_meat:'Processed meat',
  chocolate:'Chocolate', msg:'MSG', artificial_sweetener:'Artificial sweetener',
};
export const triggerLabel = tag => TAG_LABELS[tag] || String(tag);

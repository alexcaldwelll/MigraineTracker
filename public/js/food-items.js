// Food item rules with no imports, so the patterns code and the server can
// share them without pulling in data.js.

// An item the person deleted is kept as {edited: true, removed: true}. It is
// hidden everywhere (visibleItems), and because edited items always survive a
// merge and block a same-named incoming item, a re-split cannot bring it back.
export function visibleItems(items){
  return (Array.isArray(items) ? items : []).filter(item=> item && item.removed !== true);
}

export const TAG_LABELS = {
  caffeine:'Caffeine', alcohol:'Alcohol', aged_cheese:'Aged cheese', processed_meat:'Processed meat',
  chocolate:'Chocolate', msg:'MSG', artificial_sweetener:'Artificial sweetener',
};
export const triggerLabel = tag => TAG_LABELS[tag] || String(tag);

// Small shared helpers. Nothing here touches the DOM until it is called.

export const $ = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));

const HTML_ESCAPES = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};

export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c=>HTML_ESCAPES[c]);
}

export function svgIcon(id, size){ size = size || 14; return '<svg class="icon" width="'+size+'" height="'+size+'" viewBox="0 0 24 24"><use href="#icon-'+id+'"></use></svg>'; }
export function xIcon(){ return svgIcon('x', 13); }

// ---------- Tabs ----------
const TAB_IDS = {log:'tab-log', history:'tab-history', analysis:'tab-analysis'};

export function activateTab(tab){
  $$('nav button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  Object.values(TAB_IDS).forEach(id=> $('#'+id).style.display='none');
  $('#'+TAB_IDS[tab]).style.display='block';
}

// ---------- Chip helpers ----------
export function singleSelect(container){
  container.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const wasOn = chip.classList.contains('on');
      container.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
      if(!wasOn) chip.classList.add('on');
    });
  });
}
export function multiSelect(container){
  container.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=> chip.classList.toggle('on'));
  });
}
export function getSingle(sel){ const on = $(sel).querySelector('.chip.on'); return on ? on.dataset.val : null; }
export function getMulti(sel){ return $$(sel+' .chip.on').map(c=>c.dataset.val); }
export function setChip(sel, val){ const c = $(sel).querySelector(`.chip[data-val="${val}"]`); if(c) c.classList.add('on'); }

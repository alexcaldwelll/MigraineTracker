// The History tab: every logged day, newest first, and the print view.
import { data, emptyOnError } from './data.js';
import { $, svgIcon } from './ui.js';
import { entryRowHtml, wireEntryRows } from './today.js';

export async function renderHistory(){
  const days = await emptyOnError(data().listAll());
  days.sort((a,b)=> a.date < b.date ? 1 : -1);
  const list = $('#historyList');
  if(days.length===0){ list.innerHTML = '<div class="empty">'+svgIcon('calendar',44).replace('class="icon"','class="icon-lg"')+'<div>No entries yet.</div></div>'; return; }
  list.innerHTML = days.map(d=>{
    const sorted = d.entries.slice().sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    return `<div class="history-entry"><div class="date">${d.date}</div>${sorted.map(e=>entryRowHtml(e, d.date)).join('')}</div>`;
  }).join('');
  wireEntryRows('#historyList', null);
}

export function initHistory(){
  $('#printBtn').addEventListener('click', ()=> window.print());
}

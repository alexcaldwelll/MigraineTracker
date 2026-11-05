// The Today tab: date header, tiles, the Meds sheet's quick list and the day's
// entries, plus the meds modal. Entry rows are shared with History.
import { data, emptyOnError } from './data.js';
import { dayTitle, localDate, shiftDate, shortDate } from './dates.js';
import { commitDraft, logQuickMed, openEditSheet, openSheet, submitEntry } from './forms.js';
import { endHeadache, findOpenHeadache, isStale, startHeadache } from './headache.js';
import { $, $$, escapeHtml, svgIcon, xIcon, activateTab, getSingle } from './ui.js';

let onEntryDeleted = ()=>{};
let renderCount = 0;               // only the newest render may draw, when days change quickly
let allDays = [];                  // every day from listAll, so an open headache from an earlier day is found
let needsReload = true;            // allDays may be behind the database
let headacheBusy = false;          // one headache save at a time, so a double tap cannot log two
let stillGoingDismissed = false;   // "Yes, still going" is remembered until the page reloads, so the card stops asking

// ---------- Tile status ----------
const sameName = name => String(name ?? '').trim().toLowerCase();

function countStatus(count, isToday){
  if(count===0) return 'None yet';
  return `${count} ${isToday ? 'today' : 'logged'}`;
}
function sleepStatus(entries){
  const sleeps = entries.filter(e=>e.type==='sleep');
  if(sleeps.length===0) return 'Not logged';
  const hours = sleeps.reduce((sum,e)=> sum + (Number(e.hours)||0), 0);
  return hours>0 ? `${Math.round(hours*10)/10} hrs` : 'Logged';
}
// Rescue meds are taken when needed, so they are never counted as due.
function medsStatus(entries, catalog, isToday){
  const taken = entries.filter(e=>e.type==='meds');
  const scheduled = catalog.filter(m=>m.category!=='acute');
  if(scheduled.length===0) return countStatus(taken.length, isToday);
  const takenNames = new Set(taken.map(e=>sameName(e.name)));
  const done = scheduled.filter(m=>takenNames.has(sameName(m.name))).length;
  return `${done} of ${scheduled.length} taken`;
}
export function tileStatus(type, entries, catalog = [], isToday = true){
  if(type==='food') return countStatus(entries.filter(e=>e.type==='food').length, isToday);
  if(type==='sleep') return sleepStatus(entries);
  if(type==='meds') return medsStatus(entries, catalog, isToday);
  if(type==='more') return 'water, period…';
  return '';
}

// ---------- Quick meds, inside the Meds sheet ----------
function renderQuickMeds(entries, meds){
  $('#quickMedsEmpty').hidden = meds.length>0;
  if(meds.length===0){ $('#quickMedsRow').innerHTML=''; $('#medOther').open = true; return; }
  const takenNames = new Set(entries.filter(e=>e.type==='meds').map(e=>sameName(e.name)));
  const focusedId = document.activeElement?.closest?.('#quickMedsRow .med-tap-btn')?.dataset.id;
  $('#quickMedsRow').innerHTML = meds.map(m=>{
    const taken = takenNames.has(sameName(m.name));
    return `<button type="button" class="med-tap-btn ${taken?'taken':''}" data-id="${m.id}" data-name="${escapeHtml(m.name)}" data-cat="${escapeHtml(m.category)}" data-dose="${escapeHtml(m.default_dose||'')}">
      <span class="name">${taken?'✓ ':''}${escapeHtml(m.name)}</span>
      <span class="cat">${escapeHtml(m.category)}${m.default_dose ? ' · '+escapeHtml(m.default_dose) : ''}</span>
    </button>`;
  }).join('');
  $$('#quickMedsRow .med-tap-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> logQuickMed({ name: btn.dataset.name, category: btn.dataset.cat, dose: btn.dataset.dose||null }));
    if(btn.dataset.id===focusedId) btn.focus();
  });
}

// ---------- Meds modal ----------
async function renderMedsModal(){
  const meds = await emptyOnError(data().listMeds());
  $('#medsCatalogList').innerHTML = meds.length===0
    ? '<div class="empty">No medications saved yet.</div>'
    : meds.map(m=>`<div class="med-catalog-item"><span>${escapeHtml(m.name)} <span class="cat">(${escapeHtml(m.category)}${m.default_dose?', '+escapeHtml(m.default_dose):''})</span></span><button type="button" class="x" data-id="${m.id}" aria-label="Remove ${escapeHtml(m.name)}">${xIcon()}</button></div>`).join('');
  $$('#medsCatalogList .x').forEach(x=> x.addEventListener('click', ()=> deleteMed(x.dataset.id)));
}
async function deleteEntry(id){
  try{
    await data().remove(id);
  }catch(error){
    alert('Delete failed: ' + error.message); console.error(error);
  }
}
async function deleteMed(id){
  await data().removeMed(id).catch(console.error);
  renderMedsModal(); renderToday();
}

// ---------- Headache button ----------
const pad = n => String(n).padStart(2,'0');
const toLocalInput = d => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function showHeadacheError(message, retry){
  $('#headacheErrorText').textContent = message;
  $('#headacheRetryBtn').hidden = !retry;
  $('#headacheRetryBtn').onclick = retry || null;
  $('#headacheError').hidden = false;
}
function hideHeadacheError(){ $('#headacheError').hidden = true; }

// Reads every day once (at startup, and again after a headache changes). The
// last good copy stays if the read fails.
export async function refreshHeadache(){
  try{
    allDays = await data().listAll();
    needsReload = false;
  }catch(error){
    console.error(error);
  }
  renderHeadacheButton();
  return !needsReload;
}
export function renderHeadacheButton(){
  const open = findOpenHeadache(allDays);
  const btn = $('#headacheBtn');
  btn.textContent = open ? 'My headache ended' : 'I have a headache';
  btn.classList.toggle('ongoing', Boolean(open));
  const stale = Boolean(open) && isStale(open, new Date()) && !stillGoingDismissed;
  $('#headacheStale').hidden = !stale;
  if(stale){
    const start = new Date(open.start_at || `${open.date}T${open.time}:00`);
    $('#headacheStaleText').textContent = `Your headache started ${shortDate(localDate(start))} at ${open.time}. Is it still going, or when did it end?`;
    $('#headacheEndAt').min = toLocalInput(start);
    $('#headacheEndAt').max = toLocalInput(new Date());
    if(!$('#headacheEndAt').value) $('#headacheEndAt').value = toLocalInput(new Date());
  }
}

// Runs one headache save. The button stays disabled until it finishes.
async function runHeadache(task){
  if(headacheBusy) return;
  headacheBusy = true;
  $('#headacheBtn').disabled = true;
  hideHeadacheError();
  try{
    if(needsReload && !(await refreshHeadache())){
      showHeadacheError('Could not check for a headache that is already open. Try again.', ()=> runHeadache(task));
      return;
    }
    await task();
  }finally{
    headacheBusy = false;
    $('#headacheBtn').disabled = false;
  }
}
async function beginHeadache(entry){
  if(!entry) return;  // one is already open
  const { date, ...row } = entry;
  const result = await submitEntry(date, row);
  if(!result.ok){
    // Retry saves this same attempt, with the time of the first tap.
    showHeadacheError(`Not saved: ${result.error}`, ()=> runHeadache(()=> beginHeadache(startHeadache(allDays, new Date(entry.start_at)))));
    return;
  }
  needsReload = true;
  await refreshHeadache();
  showDay(date);
  const saved = findOpenHeadache(allDays);
  if(saved) openEditSheet(saved, { title: 'Headache details' });
}
async function finishHeadache(open, endAt){
  const { id, date, ...row } = endHeadache(open, endAt);
  const result = await commitDraft({ id, date, entry: row }, ()=>{});
  if(!result.ok){
    showHeadacheError(`Not saved: ${result.error}`, ()=> runHeadache(()=> finishHeadache(open, endAt)));
    return;
  }
  needsReload = true;
  await refreshHeadache();
  renderToday();
}
function onHeadacheTap(){
  runHeadache(async ()=>{
    const open = findOpenHeadache(allDays);
    if(open) await finishHeadache(open, new Date());
    else await beginHeadache(startHeadache(allDays, new Date()));
  });
}
function onEndAtSaved(){
  const open = findOpenHeadache(allDays);
  const end = new Date($('#headacheEndAt').value);
  const start = open && new Date(open.start_at || `${open.date}T${open.time}:00`);
  if(!open || Number.isNaN(end.getTime()) || end < start || end > new Date()){
    showHeadacheError('Pick a time between when the headache started and now.');
    return;
  }
  runHeadache(()=> finishHeadache(open, end));
}

// ---------- The day ----------
function renderDayHeader(date, isToday){
  $('#dayTitle').textContent = dayTitle(date);
  $('#dayDate').textContent = shortDate(date);
  $('#loggedHeading').textContent = isToday ? 'Logged today' : `Logged ${shortDate(date)}`;
}
function renderTiles(entries, meds, isToday){
  $$('.tile').forEach(tile=>{
    tile.querySelector('.tile-status').textContent = tileStatus(tile.dataset.sheet, entries, meds, isToday);
  });
}
function renderEntryList(entries, date){
  $('#todayList').innerHTML = entries.length===0
    ? '<div class="empty">'+svgIcon('calendar',44).replace('class="icon"','class="icon-lg"')+'<div>Nothing logged for this day yet.</div></div>'
    : entries.map(e=> entryRowHtml(e)).join('');
  wireEntryRows('#todayList', date);
}
export async function renderToday(){
  const render = ++renderCount;
  const date = $('#entryDate').value;
  const isToday = date===localDate();
  renderDayHeader(date, isToday);
  const [entries, meds] = await Promise.all([
    emptyOnError(data().listDay(date)),
    emptyOnError(data().listMeds()),
  ]);
  if(render!==renderCount) return;
  renderTiles(entries, meds, isToday);
  renderQuickMeds(entries, meds);
  renderEntryList(entries, date);
  renderHeadacheButton();
}

export function wireEntryRows(containerSel, date){
  $(containerSel).querySelectorAll('.entry-open').forEach(open=>{
    open.addEventListener('click', async ()=>{
      const row = open.closest('.entry-item');
      const day = date || row.dataset.date;
      const entries = await emptyOnError(data().listDay(day));
      const entry = entries.find(en=>en.id===row.dataset.id);
      if(!entry) return;
      showDay(day);
      activateTab('today');
      openEditSheet(entry);
    });
  });
  $(containerSel).querySelectorAll('.x').forEach(x=>{
    x.addEventListener('click', async ()=>{
      await deleteEntry(x.dataset.id);
      refreshHeadache();
      renderToday(); onEntryDeleted();
    });
  });
}
function tagColor(type){
  return `var(--tag-${['food','headache','prodrome','meds','sleep','workout','period','hydration','note'].includes(type)?type:'note'})`;
}
function tagLabel(type){
  return {food:'Food', headache:'Headache', prodrome:'Early signs', meds:'Meds', sleep:'Sleep', workout:'Exercise', period:'Period', hydration:'Water', note:'Note'}[type] || type;
}
function tagIconId(type){
  return {food:'food', headache:'headache', prodrome:'prodrome', meds:'meds', sleep:'sleep', workout:'workout', period:'period', hydration:'hydration', note:'note'}[type] || 'note';
}
const SYMPTOM_LABELS = {nausea:'Nausea', light_sensitivity:'Light sensitivity', sound_sensitivity:'Sound sensitivity', smell_sensitivity:'Smell sensitivity', visual_aura:'Visual aura', neck_pain:'Neck pain', vomiting:'Vomiting'};
const PRODROME_LABELS = {fatigue:'Fatigue', neck_stiffness:'Neck stiffness', light_sensitivity:'Light sensitivity', sound_sensitivity:'Sound sensitivity', mood_change:'Mood change', food_craving:'Food craving', yawning:'Excess yawning', concentration:'Trouble concentrating', dizziness:'Dizziness', nausea:'Nausea'};
function entryBody(e){
  if(e.type==='food') return escapeHtml(e.text);
  if(e.type==='headache'){
    const parts=[];
    if(e.open===true) parts.push('Ongoing');
    if(e.severity!=null) parts.push(`Severity ${e.severity}`);
    if(e.duration) parts.push(`${e.duration}h`);
    if(e.fog) parts.push(`Fog: ${e.fog}`);
    if(e.dizziness) parts.push(`Dizzy: ${e.dizziness}`);
    if(e.symptoms && e.symptoms.length) parts.push(e.symptoms.map(s=>SYMPTOM_LABELS[s]||s).join(', '));
    if(e.note) parts.push(e.note);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  if(e.type==='prodrome'){
    const parts=[];
    if(e.symptoms && e.symptoms.length) parts.push(e.symptoms.map(s=>PRODROME_LABELS[s]||s).join(', '));
    if(e.note) parts.push(e.note);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  if(e.type==='meds'){
    const parts=[e.name + (e.category?` (${e.category})`:'')];
    if(e.dose) parts.push(e.dose);
    return escapeHtml(parts.filter(Boolean).join(' · '));
  }
  if(e.type==='sleep'){
    const parts=[];
    if(e.bedtime||e.waketime) parts.push(`${e.bedtime||'?'} → ${e.waketime||'?'}`);
    if(e.hours) parts.push(`${e.hours}h`);
    if(e.quality) parts.push(e.quality);
    if(e.wakeFeeling) parts.push('woke: '+e.wakeFeeling);
    if(e.interruptions && e.interruptions.length) parts.push(e.interruptions.length+' interruption(s)');
    if(e.note) parts.push(e.note);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  if(e.type==='workout'){
    const parts=[];
    if(e.activity) parts.push(e.activity);
    if(e.duration) parts.push(`${e.duration}min`);
    if(e.strain) parts.push(`Intensity ${e.strain}/10`);
    if(e.hr) parts.push(`Avg HR ${e.hr}`);
    if(e.calories) parts.push(`${e.calories}cal`);
    if(e.note) parts.push(e.note);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  if(e.type==='period'){
    const parts=[];
    if(e.flow) parts.push('Flow: '+e.flow);
    if(e.note) parts.push(e.note);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  if(e.type==='hydration') return escapeHtml(e.amount||0) + ' oz';
  if(e.type==='note'){
    const parts=[];
    if(e.stress) parts.push(`Stress: ${e.stress}`);
    if(e.text) parts.push(e.text);
    return escapeHtml(parts.join(' · ')) || '(no details)';
  }
  return '';
}
export function entryRowHtml(e, date){
  return `<div class="entry-item" data-id="${e.id}" ${date?`data-date="${date}"`:''}>
    <button type="button" class="entry-open">
      <span class="top">
        <span class="tag" style="background:${tagColor(e.type)}">${svgIcon(tagIconId(e.type),11)}${escapeHtml(tagLabel(e.type))}</span>
        <span class="time">${escapeHtml(e.time||'')}</span>
      </span>
      <span class="body">${entryBody(e)}</span>
      <span class="sr-only">Edit</span>
    </button>
    <button type="button" class="x" data-id="${e.id}" aria-label="Delete ${escapeHtml(tagLabel(e.type))} entry">${xIcon()}</button>
  </div>`;
}

function showDay(date){
  $('#entryDate').value = date;
  renderToday();
}

export function initToday(callbacks){
  ({ onEntryDeleted } = callbacks);

  $('#entryDate').value = localDate();
  $('#dayBack').addEventListener('click', ()=> showDay(shiftDate($('#entryDate').value, -1)));
  $('#dayFwd').addEventListener('click', ()=> showDay(shiftDate($('#entryDate').value, 1)));
  $('#entryDate').addEventListener('change', ()=> showDay($('#entryDate').value || localDate()));

  $('#headacheBtn').addEventListener('click', onHeadacheTap);
  $('#headacheStillBtn').addEventListener('click', ()=>{ stillGoingDismissed = true; renderHeadacheButton(); });
  $('#headacheEndAtBtn').addEventListener('click', onEndAtSaved);
  $$('.tile').forEach(tile=> tile.addEventListener('click', ()=> openSheet(tile.dataset.sheet)));

  $('#settingsBtn').addEventListener('click', ()=>{ $('#medsModal').style.display='block'; renderMedsModal(); });
  $('#closeMedsModalBtn').addEventListener('click', ()=>{ $('#medsModal').style.display='none'; });
  $('#saveNewMedBtn').addEventListener('click', async ()=>{
    const name = $('#newMedName').value.trim();
    if(!name) return;
    const category = getSingle('#newMedCategoryRow') || 'preventive';
    const dose = $('#newMedDose').value.trim() || null;
    await data().addMed({ name, category, default_dose: dose }).catch(console.error);
    $('#newMedName').value=''; $('#newMedDose').value='';
    renderMedsModal(); renderToday();
  });
}

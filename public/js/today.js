// The Log tab's lists: quick meds, the day's entries and the day picker, plus
// the meds modal. Entry rows are shared with History.
import { data, emptyOnError } from './data.js';
import { localDate, nowTime, shiftDate } from './dates.js';
import { addEntry, populateFieldsForEdit } from './forms.js';
import { $, $$, escapeHtml, svgIcon, xIcon, activateTab, getSingle } from './ui.js';

let onEntryDeleted = ()=>{};

// ---------- Quick meds ----------
export async function renderQuickMeds(){
  const meds = await emptyOnError(data().listMeds());
  const date = $('#entryDate').value;
  const todays = await emptyOnError(data().listDay(date));
  const takenNames = new Set(todays.filter(e=>e.type==='meds').map(e=>e.name));
  if(meds.length===0){ $('#quickMedsRow').innerHTML=''; $('#quickMedsEmpty').style.display='block'; return; }
  $('#quickMedsEmpty').style.display='none';
  $('#quickMedsRow').innerHTML = meds.map(m=>`
    <div class="med-tap-btn ${takenNames.has(m.name)?'taken':''}" data-id="${m.id}" data-name="${escapeHtml(m.name)}" data-cat="${escapeHtml(m.category)}" data-dose="${escapeHtml(m.default_dose||'')}">
      <span class="name">${takenNames.has(m.name)?'✓ ':''}${escapeHtml(m.name)}</span>
      <span class="cat">${escapeHtml(m.category)}${m.default_dose ? ' · '+escapeHtml(m.default_dose) : ''}</span>
    </div>`).join('');
  $$('#quickMedsRow .med-tap-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const entry = { type:'meds', time: nowTime(), name: btn.dataset.name, category: btn.dataset.cat, dose: btn.dataset.dose||null };
      const ok = await addEntry($('#entryDate').value, entry);
      if(ok){ renderTodayList(); renderQuickMeds(); }
    });
  });
}

// ---------- Meds modal ----------
async function renderMedsModal(){
  const meds = await emptyOnError(data().listMeds());
  $('#medsCatalogList').innerHTML = meds.length===0
    ? '<div class="empty">No medications saved yet.</div>'
    : meds.map(m=>`<div class="med-catalog-item"><span>${escapeHtml(m.name)} <span class="cat">(${escapeHtml(m.category)}${m.default_dose?', '+escapeHtml(m.default_dose):''})</span></span><span class="x" data-id="${m.id}" style="cursor:pointer;">${xIcon()}</span></div>`).join('');
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
  renderMedsModal(); renderQuickMeds();
}

// ---------- Entry list ----------
export async function renderTodayList(){
  const date = $('#entryDate').value;
  const entries = await emptyOnError(data().listDay(date));
  $('#todayList').innerHTML = entries.length===0
    ? '<div class="empty">'+svgIcon('calendar',44).replace('class="icon"','class="icon-lg"')+'<div>Nothing logged for this day yet.</div></div>'
    : entries.map(e=> entryRowHtml(e)).join('');
  wireEntryRows('#todayList', date);
}
export function wireEntryRows(containerSel, date){
  $(containerSel).querySelectorAll('.entry-item').forEach(row=>{
    row.addEventListener('click', async (ev)=>{
      if(ev.target.classList.contains('x')) return;
      const id = row.dataset.id;
      const entries = await emptyOnError(data().listDay(date || row.dataset.date));
      const entry = entries.find(en=>en.id===id);
      if(entry){
        if(date) $('#entryDate').value = date; else $('#entryDate').value = row.dataset.date;
        populateFieldsForEdit(entry);
        activateTab('log');
      }
    });
  });
  $(containerSel).querySelectorAll('.x').forEach(x=>{
    x.addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      await deleteEntry(x.dataset.id);
      renderTodayList(); onEntryDeleted(); renderQuickMeds();
    });
  });
}
function tagColor(type){
  return {food:'#8a9b6e', headache:'#b0563f', prodrome:'#c98a4a', meds:'#5b7a6b', sleep:'#3f5c4f', workout:'#4a6f8a', period:'#a15c7a', hydration:'#4a8ba8', note:'#7a7568'}[type] || '#7a7568';
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
    <div class="top">
      <span><span class="tag" style="background:${tagColor(e.type)}">${svgIcon(tagIconId(e.type),11)}${escapeHtml(tagLabel(e.type))}</span> <span class="time">${escapeHtml(e.time||'')}</span></span>
      <span class="x" data-id="${e.id}">${xIcon()}</span>
    </div>
    <div class="body">${entryBody(e)}</div>
  </div>`;
}

function shiftDay(n){
  const date = $('#entryDate').value;
  if(!date) return;
  $('#entryDate').value = shiftDate(date, n);
  renderTodayList(); renderQuickMeds();
}

export function initToday(callbacks){
  ({ onEntryDeleted } = callbacks);

  $('#entryDate').value = localDate();
  $('#dayBack').addEventListener('click', ()=> shiftDay(-1));
  $('#dayFwd').addEventListener('click', ()=> shiftDay(1));
  $('#entryDate').addEventListener('change', ()=>{ renderTodayList(); renderQuickMeds(); });

  $('#settingsBtn').addEventListener('click', ()=>{ $('#medsModal').style.display='block'; renderMedsModal(); });
  $('#closeMedsModalBtn').addEventListener('click', ()=>{ $('#medsModal').style.display='none'; });
  $('#saveNewMedBtn').addEventListener('click', async ()=>{
    const name = $('#newMedName').value.trim();
    if(!name) return;
    const category = getSingle('#newMedCategoryRow') || 'preventive';
    const dose = $('#newMedDose').value.trim() || null;
    await data().addMed({ name, category, default_dose: dose }).catch(console.error);
    $('#newMedName').value=''; $('#newMedDose').value='';
    renderMedsModal(); renderQuickMeds();
  });
}

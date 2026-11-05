// The entry sheet: one short form for one entry type, used for adding and
// editing, plus saving, field wiring and filling fields from a screenshot.
import { data, emptyOnError } from './data.js';
import { localDate, nowTime, shortDate } from './dates.js';
import { closedHeadacheTimes } from './headache.js';
import { $, $$, escapeHtml, xIcon, singleSelect, multiSelect, getSingle, getMulti, setChip, setOn } from './ui.js';

const SHEET_TITLES = {food:'Food', headache:'Headache', prodrome:'Early signs', meds:'Meds', sleep:'Sleep', workout:'Exercise', period:'Period', hydration:'Water', note:'Note'};
const SCREENSHOT_TYPES = ['food','sleep','workout'];

let currentType = 'food';
let editingId = null;
let editingEntry = null;   // the stored entry being edited, so open/start_at/end_at survive
let earlierMode = false;   // "Log an earlier headache": date and time are editable
let saving = false;
let interruptions = [];
const draftTimes = {};      // a time set in one type's sheet stays with that type
let onEntrySaved = ()=>{};  // an entry was added or updated
let onMedSaved = ()=>{};    // the meds catalog grew

// ---------- Sleep interruptions (dynamic rows) ----------
function renderInterruptions(){
  $('#interruptionsList').innerHTML = interruptions.map((it,i)=>`
    <div class="interruption-row">
      <input type="time" value="${escapeHtml(it.time||'')}" data-i="${i}" data-f="time" aria-label="Interruption time">
      <input type="text" placeholder="e.g. woke up, nap" value="${escapeHtml(it.note||'')}" data-i="${i}" data-f="note" aria-label="Interruption note">
      <button type="button" class="x" data-i="${i}" aria-label="Remove interruption">${xIcon()}</button>
    </div>`).join('');
  $('#interruptionsList').querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const i = parseInt(inp.dataset.i), f = inp.dataset.f;
      interruptions[i][f] = inp.value;
    });
  });
  $('#interruptionsList').querySelectorAll('.x').forEach(x=>{
    x.addEventListener('click', ()=>{ interruptions.splice(parseInt(x.dataset.i),1); renderInterruptions(); });
  });
}

// ---------- Build entry payload ----------
function buildEntry(date){
  const time = $('#entryTime').value || nowTime();
  const base = { type: currentType, time };
  if(currentType==='food'){
    const text = $('#foodText').value.trim();
    if(!text) return null;
    return {...base, text};
  }
  if(currentType==='headache'){
    const sevBtn = $('#severityRow').querySelector('.sev-btn.on');
    const duration = $('#headacheDuration').value || null;
    return {...base,
      severity: sevBtn ? parseInt(sevBtn.dataset.val) : null,
      duration,
      fog: getSingle('#fogRow'),
      dizziness: getSingle('#dizzyRow'),
      symptoms: getMulti('#symptomsRow'),
      note: $('#headacheNote').value.trim() || null,
      ...headacheTiming(date, time, duration) };
  }
  if(currentType==='prodrome'){
    const symptoms = getMulti('#prodromeRow');
    const note = $('#prodromeNote').value.trim();
    if(symptoms.length===0 && !note) return null;
    return {...base, symptoms, note: note||null};
  }
  if(currentType==='meds'){
    const name = $('#medName').value.trim();
    if(!name) return null;
    const category = getSingle('#medCategoryRow') || 'other';
    const dose = $('#medDetail').value.trim() || null;
    return {...base, name, category, dose};
  }
  if(currentType==='sleep'){
    const bed = $('#bedtime').value, wake = $('#waketime').value;
    const quality = getSingle('#sleepQuality'), wakeFeeling = getSingle('#wakeFeelingRow');
    const kept = interruptions.filter(it=>it.time||it.note);
    const note = $('#sleepNote').value.trim() || null;
    if(!bed && !wake && !quality && !wakeFeeling && kept.length===0 && !note) return null;
    return {...base, bedtime: bed||null, waketime: wake||null,
      quality, hours: computeSleepHours(bed, wake),
      wakeFeeling, interruptions: kept, note };
  }
  if(currentType==='workout'){
    const activity = $('#workoutActivity').value.trim();
    const duration = $('#workoutDuration').value || null;
    const strain = $('#workoutStrain').value || null;
    const hr = $('#workoutHr').value || null;
    const cal = $('#workoutCalories').value || null;
    const note = $('#workoutNote').value.trim() || null;
    if(!activity && !duration && !strain && !hr && !cal && !note) return null;
    return {...base, activity: activity||null, duration, strain, hr, calories: cal, note};
  }
  if(currentType==='period'){
    const flow = getSingle('#flowRow');
    const note = $('#periodNote').value.trim();
    if(!flow && !note) return null;
    return {...base, flow, note: note||null};
  }
  if(currentType==='hydration'){
    const amount = $('#hydrationAmount').value;
    if(!amount) return null;
    return {...base, amount: parseInt(amount)};
  }
  if(currentType==='note'){
    const stress = getSingle('#stressRow');
    const text = $('#noteText').value.trim();
    if(!stress && !text) return null;
    return {...base, stress, text: text||null};
  }
}
// What marks a headache as open or closed, and when it began and ended.
// Old entries have none of these and stay that way.
function headacheTiming(date, time, duration){
  const prior = editingEntry;
  if(earlierMode) return { open: false, ...closedHeadacheTimes(date, time, duration) };
  if(!prior || !prior.start_at) return {};
  const start_at = closedHeadacheTimes(date, time, null).start_at;
  if(prior.open === true) return { open: true, start_at };
  const timing = { open: false, start_at };
  // An end time set by "My headache ended" stays unless the duration was changed.
  if(prior.end_at && String(duration ?? '') === String(prior.duration ?? '')) timing.end_at = prior.end_at;
  else if(duration) timing.end_at = closedHeadacheTimes(date, time, duration).end_at;
  return timing;
}
function computeSleepHours(bed, wake){
  if(!bed || !wake) return null;
  let [bh,bm]=bed.split(':').map(Number), [wh,wm]=wake.split(':').map(Number);
  let diff = (wh*60+wm)-(bh*60+bm);
  if(diff<=0) diff += 24*60;
  return Math.round((diff/60)*10)/10;
}
// Clears one type's sheet. Other types keep their drafts.
function clearDraft(type){
  const scope = '#fields-'+type;
  $$(scope+' input, '+scope+' textarea').forEach(f=>{
    if(f.type==='checkbox') f.checked = false; else f.value = '';
  });
  $$(scope+' .chip[data-val], '+scope+' .sev-btn').forEach(c=>setOn(c, false));
  $$(scope+' details').forEach(d=>{ d.open = false; });
  if(type==='sleep'){ interruptions = []; renderInterruptions(); }
  draftTimes[type] = '';
  if(type===currentType){
    $('#entryTime').value = '';
    showTimeField(false);
    resetScreenshot();
  }
}

// ---------- Saving ----------
function failureMessage(error){
  return (error && error.message) || 'Something went wrong.';
}
export async function submitEntry(date, entry){
  try{
    await data().add(date, entry);
    return { ok: true };
  }catch(error){
    console.error(error);
    return { ok: false, error: failureMessage(error) };
  }
}
async function submitUpdate(id, date, entry){
  try{
    await data().update(id, date, entry);
    return { ok: true };
  }catch(error){
    console.error(error);
    return { ok: false, error: failureMessage(error) };
  }
}
// The only place that decides a draft may go: after the save has succeeded.
export async function commitDraft({ id, date, entry }, clear){
  const result = id ? await submitUpdate(id, date, entry) : await submitEntry(date, entry);
  if(result.ok) clear();
  return result;
}
async function saveMedToCatalog(name, category, dose){
  const existing = await emptyOnError(data().listMeds());
  if(existing.some(m=>m.name.toLowerCase()===name.toLowerCase())) return;
  await data().addMed({ name, category, default_dose: dose }).catch(console.error);
  onMedSaved();
}

// ---------- Sheet messages ----------
function showSheetError(message, retry){
  $('#sheetErrorText').textContent = message;
  $('#sheetRetryBtn').hidden = !retry;
  $('#sheetRetryBtn').onclick = retry || null;
  $('#sheetError').hidden = false;
}
function hideSheetError(){ $('#sheetError').hidden = true; }
const notSavedMessage = error => `Not saved: ${error} What you entered is still here.`;

// Blocks a second save, so a double tap cannot log something twice.
async function whileSaving(send){
  saving = true;
  hideSheetError();
  const btn = $('#sheetSaveBtn'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    return await send();
  }finally{
    saving = false;
    btn.disabled = false; btn.textContent = label;
  }
}

async function saveSheet(){
  if(saving) return;
  const date = earlierMode ? ($('#sheetDate').value || $('#entryDate').value) : $('#entryDate').value;
  const entry = buildEntry(date);
  if(!entry){
    $$('#fields-'+currentType+' details').forEach(d=>{ d.open = true; });
    showSheetError('Add at least one detail before saving.');
    return;
  }
  const type = currentType, id = editingId;
  const remember = type==='meds' && $('#medSaveCatalog').checked;
  const result = await whileSaving(()=> commitDraft({ id, date, entry }, ()=>{
    editingId = null; editingEntry = null; earlierMode = false;
    $('#sheetDateField').hidden = true;
    clearDraft(type);
  }));
  if(!result.ok){
    // A retry later must keep the time of this attempt, not the time of the retry.
    $('#entryTime').value = entry.time;
    showTimeField(true);
    presentSheet();  // Escape can still close the sheet during a save
    showSheetError(notSavedMessage(result.error), saveSheet);
    return;
  }
  if(remember) saveMedToCatalog(entry.name, entry.category, entry.dose);
  closeSheet();
  onEntrySaved({ type });
}

// A tap on a saved medication logs it at once and leaves the sheet open, so
// several can be ticked off together.
export async function logQuickMed(med){
  if(saving) return;
  const date = $('#entryDate').value;
  const entry = { type:'meds', time: $('#entryTime').value || nowTime(), ...med };
  const send = async ()=>{
    const result = await whileSaving(()=> submitEntry(date, entry));
    if(result.ok) onEntrySaved({ type: 'meds' });
    else{
      presentSheet();
      showSheetError(`Not saved: ${result.error}`, send);
    }
  };
  await send();
}

// ---------- The sheet ----------
function presentSheet(){
  if(!$('#sheet').open) $('#sheet').showModal();
}
function closeSheet(){
  if(!saving && $('#sheet').open) $('#sheet').close();
}
function showTimeField(show){
  $('#timeField').hidden = !show;
  $('#changeTimeBtn').hidden = show;
}
function resetScreenshot(){
  $('#screenshotRow').open = false;
  $('#screenshotFile').value = '';
  $('#screenshotStatus').textContent = '';
}
function showType(type){
  draftTimes[currentType] = $('#entryTime').value;
  currentType = type;
  $('#entryTime').value = draftTimes[type] || '';
  showTimeField(Boolean($('#entryTime').value));
  $$('.type-fields').forEach(f=>{ f.hidden = f.id !== 'fields-'+type; });
  $('#screenshotRow').hidden = !SCREENSHOT_TYPES.includes(type);
  resetScreenshot();
  $('#quickMedsBlock').hidden = Boolean(editingId);
  syncSaveButton();
}
// A tap on the quick list saves by itself, so Save only appears for typing one in.
function syncSaveButton(){
  $('#sheetSaveBtn').hidden = currentType==='meds' && !$('#medOther').open;
}
function showSheetDay(){
  const date = $('#entryDate').value;
  $('#sheetDay').hidden = date===localDate();
  $('#sheetDay').textContent = `For ${shortDate(date)}`;
}
// An edit that was closed unsaved is dropped: the stored entry is unchanged.
function abandonEdit(){
  if(!editingId && !earlierMode) return;
  editingId = null; editingEntry = null; earlierMode = false;
  $('#sheetDateField').hidden = true;
  clearDraft(currentType);
}

// `earlier` opens the headache form for one that is over: date and time show.
export function openSheet(type, { earlier = false } = {}){
  abandonEdit();
  hideSheetError();
  showSheetDay();
  const more = type==='more';
  $('#moreList').hidden = !more;
  $('#sheetForm').hidden = more;
  $('#sheetTitle').textContent = more ? 'More' : earlier ? 'Earlier headache' : SHEET_TITLES[type];
  $('#sheetSaveBtn').textContent = 'Save';
  if(!more) showType(type);
  if(earlier){
    earlierMode = true;
    $('#sheetDate').max = localDate();
    $('#sheetDate').value = $('#entryDate').value;
    $('#sheetDateField').hidden = false;
    if(!$('#entryTime').value) $('#entryTime').value = nowTime();
    showTimeField(true);
    $('#sheetDay').hidden = true;
  }
  presentSheet();
}

// `title` lets the headache flow call its follow-up sheet "Headache details".
export function openEditSheet(entry, { title } = {}){
  if(!SHEET_TITLES[entry.type]) return;
  abandonEdit();
  hideSheetError();
  showSheetDay();
  clearDraft(entry.type);
  editingId = entry.id; editingEntry = entry;
  showType(entry.type);
  fillFields(entry);
  revealFilledDetail(entry.type);
  showTimeField(true);
  $('#moreList').hidden = true;
  $('#sheetForm').hidden = false;
  $('#sheetTitle').textContent = title || 'Edit ' + SHEET_TITLES[entry.type].toLowerCase();
  $('#sheetSaveBtn').textContent = 'Save changes';
  presentSheet();
}

// A filled field must never sit out of sight inside a collapsed section.
function revealFilledDetail(type){
  $$('#fields-'+type+' details').forEach(d=>{
    const filled = Array.from(d.querySelectorAll('input, textarea')).some(f=> f.type==='checkbox' ? f.checked : f.value);
    if(filled || d.querySelector('.chip.on, .sev-btn.on')) d.open = true;
  });
}

function fillFields(e){
  $('#entryTime').value = e.time || '';
  if(e.type==='food') $('#foodText').value = e.text||'';
  if(e.type==='headache'){
    if(e.severity!=null) setSevChip(e.severity);
    $('#headacheDuration').value = e.duration||'';
    if(e.fog) setChip('#fogRow', e.fog);
    if(e.dizziness) setChip('#dizzyRow', e.dizziness);
    (e.symptoms||[]).forEach(s=> setChip('#symptomsRow', s));
    $('#headacheNote').value = e.note||'';
  }
  if(e.type==='prodrome'){
    (e.symptoms||[]).forEach(s=> setChip('#prodromeRow', s));
    $('#prodromeNote').value = e.note||'';
  }
  if(e.type==='meds'){
    $('#medName').value = e.name||'';
    if(e.category) setChip('#medCategoryRow', e.category);
    $('#medDetail').value = e.dose||'';
  }
  if(e.type==='sleep'){
    $('#bedtime').value = e.bedtime||''; $('#waketime').value = e.waketime||'';
    if(e.quality) setChip('#sleepQuality', e.quality);
    if(e.wakeFeeling) setChip('#wakeFeelingRow', e.wakeFeeling);
    interruptions = (e.interruptions||[]).slice(); renderInterruptions();
    $('#sleepNote').value = e.note||'';
  }
  if(e.type==='workout'){
    $('#workoutActivity').value = e.activity||'';
    $('#workoutDuration').value = e.duration||'';
    $('#workoutStrain').value = e.strain||'';
    $('#workoutHr').value = e.hr||'';
    $('#workoutCalories').value = e.calories||'';
    $('#workoutNote').value = e.note||'';
  }
  if(e.type==='period'){
    if(e.flow) setChip('#flowRow', e.flow);
    $('#periodNote').value = e.note||'';
  }
  if(e.type==='hydration'){
    $('#hydrationAmount').value = e.amount||'';
  }
  if(e.type==='note'){
    if(e.stress) setChip('#stressRow', e.stress);
    $('#noteText').value = e.text||'';
  }
}
function setSevChip(val){ const b = $('#severityRow').querySelector(`.sev-btn[data-val="${val}"]`); if(b) setOn(b, true); }

// ---------- Screenshot analysis ----------
function fileToBase64(file){
  return new Promise((res, rej)=>{
    const r = new FileReader();
    r.onload = ()=> res(r.result.split(',')[1]);
    r.onerror = ()=> rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
async function analyzeScreenshot(type, file){
  const statusEl = $('#screenshotStatus');
  statusEl.textContent = 'Reading screenshot…';
  try{
    const base64 = await fileToBase64(file);
    const mediaType = file.type || 'image/png';
    const parsed = await data().ai('read_screenshot', { type, mediaType, data: base64 });
    fillFieldsFromExtraction(type, parsed);
    revealFilledDetail(type);
    statusEl.textContent = 'Drafted from the screenshot. Check the numbers, then tap Save.';
  }catch(e){
    console.error('analyzeScreenshot error:', e);
    statusEl.textContent = 'Could not read that screenshot (' + (e && e.message ? e.message : String(e)) + '). Enter it manually instead.';
  }
}
function fillFieldsFromExtraction(type, d){
  if(type==='food'){
    const parts = [];
    if(d.summary) parts.push(d.summary);
    const macros = [];
    if(d.calories!=null) macros.push(d.calories+' cal');
    if(d.protein_g!=null) macros.push(d.protein_g+'g protein');
    if(d.carbs_g!=null) macros.push(d.carbs_g+'g carbs');
    if(d.fat_g!=null) macros.push(d.fat_g+'g fat');
    if(macros.length) parts.push('(' + macros.join(', ') + ')');
    $('#foodText').value = parts.join(' ');
  }
  if(type==='sleep'){
    if(d.bedtime) $('#bedtime').value = d.bedtime;
    if(d.waketime) $('#waketime').value = d.waketime;
    if(d.score!=null) $('#sleepNote').value = 'Score ' + d.score;
  }
  if(type==='workout'){
    if(d.activity) $('#workoutActivity').value = d.activity;
    if(d.duration_min!=null) $('#workoutDuration').value = d.duration_min;
    if(d.strain!=null) $('#workoutStrain').value = d.strain;
    if(d.avg_hr!=null) $('#workoutHr').value = d.avg_hr;
    if(d.calories!=null) $('#workoutCalories').value = d.calories;
  }
}

export function initForms(callbacks){
  ({ onEntrySaved, onMedSaved } = callbacks);

  singleSelect($('#fogRow')); singleSelect($('#dizzyRow'));
  singleSelect($('#sleepQuality')); singleSelect($('#wakeFeelingRow'));
  singleSelect($('#stressRow')); singleSelect($('#flowRow'));
  singleSelect($('#medCategoryRow')); singleSelect($('#newMedCategoryRow'));
  multiSelect($('#symptomsRow')); multiSelect($('#prodromeRow'));
  $$('.chip[data-val], .sev-btn').forEach(c=> setOn(c, c.classList.contains('on')));
  $('#severityRow').querySelectorAll('.sev-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const wasOn = btn.classList.contains('on');
      $('#severityRow').querySelectorAll('.sev-btn').forEach(b=>setOn(b, false));
      if(!wasOn) setOn(btn, true);
    });
  });
  // hydration presets
  $$('#fields-hydration .chip[data-preset]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const cur = parseInt($('#hydrationAmount').value)||0;
      $('#hydrationAmount').value = cur + parseInt(chip.dataset.preset);
    });
  });

  $('#addInterruptionBtn').addEventListener('click', ()=>{ interruptions.push({time:'', note:''}); renderInterruptions(); });
  $('#changeTimeBtn').addEventListener('click', ()=>{
    $('#entryTime').value = nowTime();
    showTimeField(true);
    $('#entryTime').focus();
  });
  $$('#moreList .more-item[data-more]').forEach(item=>{
    item.addEventListener('click', ()=> openSheet(item.dataset.more));
  });
  $('#earlierHeadacheBtn').addEventListener('click', ()=> openSheet('headache', { earlier: true }));

  $('#medOther').addEventListener('toggle', syncSaveButton);
  $('#sheetForm').addEventListener('submit', (ev)=>{
    ev.preventDefault();
    saveSheet();
  });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('cancel', (ev)=>{ if(saving) ev.preventDefault(); });
  $('#screenshotFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) analyzeScreenshot(currentType, file);
  });
}

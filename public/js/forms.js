// The add/edit form: type chips, field wiring, building an entry, and filling
// fields from a screenshot.
import { data, emptyOnError } from './data.js';
import { nowTime } from './dates.js';
import { $, $$, escapeHtml, xIcon, singleSelect, multiSelect, getSingle, getMulti, setChip } from './ui.js';

let currentType = 'food';
let editingId = null;
let interruptions = [];
let onEntrySaved = ()=>{};  // an entry was added or updated
let onMedSaved = ()=>{};    // the meds catalog grew

// ---------- Sleep interruptions (dynamic rows) ----------
function renderInterruptions(){
  $('#interruptionsList').innerHTML = interruptions.map((it,i)=>`
    <div class="interruption-row">
      <input type="time" value="${escapeHtml(it.time||'')}" data-i="${i}" data-f="time">
      <input type="text" placeholder="e.g. woke up, nap" value="${escapeHtml(it.note||'')}" data-i="${i}" data-f="note">
      <span class="x" data-i="${i}">${xIcon()}</span>
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
function buildEntry(){
  const time = $('#entryTime').value || nowTime();
  const base = { type: currentType, time };
  if(currentType==='food'){
    const text = $('#foodText').value.trim();
    if(!text) return null;
    return {...base, text};
  }
  if(currentType==='headache'){
    const sevBtn = $('#severityRow').querySelector('.sev-btn.on');
    return {...base,
      severity: sevBtn ? parseInt(sevBtn.dataset.val) : null,
      duration: $('#headacheDuration').value || null,
      fog: getSingle('#fogRow'),
      dizziness: getSingle('#dizzyRow'),
      symptoms: getMulti('#symptomsRow'),
      note: $('#headacheNote').value.trim() || null };
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
    if($('#medSaveCatalog').checked) saveMedToCatalog(name, category, dose);
    return {...base, name, category, dose};
  }
  if(currentType==='sleep'){
    const bed = $('#bedtime').value, wake = $('#waketime').value;
    return {...base, bedtime: bed||null, waketime: wake||null,
      quality: getSingle('#sleepQuality'), hours: computeSleepHours(bed, wake),
      wakeFeeling: getSingle('#wakeFeelingRow'),
      interruptions: interruptions.filter(it=>it.time||it.note),
      note: $('#sleepNote').value.trim() || null };
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
function computeSleepHours(bed, wake){
  if(!bed || !wake) return null;
  let [bh,bm]=bed.split(':').map(Number), [wh,wm]=wake.split(':').map(Number);
  let diff = (wh*60+wm)-(bh*60+bm);
  if(diff<=0) diff += 24*60;
  return Math.round((diff/60)*10)/10;
}
function clearTypeFields(){
  $('#entryTime').value='';
  $('#foodText').value='';
  $$('#severityRow .sev-btn').forEach(c=>c.classList.remove('on'));
  $('#headacheDuration').value='';
  $$('#fogRow .chip').forEach(c=>c.classList.remove('on'));
  $$('#dizzyRow .chip').forEach(c=>c.classList.remove('on'));
  $$('#symptomsRow .chip').forEach(c=>c.classList.remove('on'));
  $('#headacheNote').value='';
  $$('#prodromeRow .chip').forEach(c=>c.classList.remove('on'));
  $('#prodromeNote').value='';
  $('#medName').value=''; $$('#medCategoryRow .chip').forEach(c=>c.classList.remove('on'));
  $('#medDetail').value=''; $('#medSaveCatalog').checked=false;
  $('#bedtime').value=''; $('#waketime').value='';
  $$('#sleepQuality .chip').forEach(c=>c.classList.remove('on'));
  $$('#wakeFeelingRow .chip').forEach(c=>c.classList.remove('on'));
  interruptions=[]; renderInterruptions();
  $('#sleepNote').value='';
  $('#workoutActivity').value=''; $('#workoutDuration').value='';
  $('#workoutStrain').value=''; $('#workoutHr').value=''; $('#workoutCalories').value='';
  $('#workoutNote').value='';
  $$('#flowRow .chip').forEach(c=>c.classList.remove('on'));
  $('#periodNote').value='';
  $('#hydrationAmount').value='';
  $$('#stressRow .chip').forEach(c=>c.classList.remove('on'));
  $('#noteText').value='';
  $('#screenshotFile').value=''; $('#screenshotStatus').textContent='';
}

// ---------- Saving ----------
export async function addEntry(date, entry){
  try{
    await data().add(date, entry);
    return true;
  }catch(error){
    alert('Save failed: ' + error.message); console.error(error);
    return false;
  }
}
async function updateEntry(id, date, entry){
  try{
    await data().update(id, date, entry);
    return true;
  }catch(error){
    alert('Update failed: ' + error.message); console.error(error);
    return false;
  }
}
async function saveMedToCatalog(name, category, dose){
  const existing = await emptyOnError(data().listMeds());
  if(existing.some(m=>m.name.toLowerCase()===name.toLowerCase())) return;
  await data().addMed({ name, category, default_dose: dose }).catch(console.error);
  onMedSaved();
}

function exitEditMode(){
  editingId = null;
  $('#formHeading').textContent = 'Add an entry';
  $('#addEntryBtn').textContent = 'Add to log';
  $('#cancelEditBtn').style.display='none';
  $$('#typeRow .type-chip').forEach(c=> c.style.opacity='1');
}

function selectType(type){
  const chip = $(`#typeRow .type-chip[data-val="${type}"]`);
  if(!chip) return;
  $('#typeRow').querySelectorAll('.type-chip').forEach(c=>c.classList.remove('on'));
  chip.classList.add('on');
  currentType = type;
  $$('.type-fields').forEach(f=>f.style.display='none');
  $('#fields-'+type).style.display='block';
  $('#screenshotRow').style.display = ['food','sleep','workout'].includes(type) ? 'block' : 'none';
}

export function populateFieldsForEdit(e){
  selectType(e.type);
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
  editingId = e.id;
  $('#formHeading').textContent = 'Edit entry';
  $('#addEntryBtn').textContent = 'Update entry';
  $('#cancelEditBtn').style.display='block';
  window.scrollTo({top:0, behavior:'smooth'});
}
function setSevChip(val){ const b = $('#severityRow').querySelector(`.sev-btn[data-val="${val}"]`); if(b) b.classList.add('on'); }

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
    statusEl.textContent = 'Drafted below from the screenshot — check the numbers, then tap "Add to log".';
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
  $('#severityRow').querySelectorAll('.sev-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const wasOn = btn.classList.contains('on');
      $('#severityRow').querySelectorAll('.sev-btn').forEach(b=>b.classList.remove('on'));
      if(!wasOn) btn.classList.add('on');
    });
  });
  // hydration presets
  $$('#fields-hydration .chip[data-preset]').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      const cur = parseInt($('#hydrationAmount').value)||0;
      $('#hydrationAmount').value = cur + parseInt(chip.dataset.preset);
    });
  });

  $('#typeRow').querySelectorAll('.type-chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      if(editingId) return; // don't allow type switch mid-edit
      $('#typeRow').querySelectorAll('.type-chip').forEach(c=>c.classList.remove('on'));
      chip.classList.add('on');
      currentType = chip.dataset.val;
      $$('.type-fields').forEach(f=>f.style.display='none');
      $('#fields-'+currentType).style.display='block';
      $('#screenshotRow').style.display = ['food','sleep','workout'].includes(currentType) ? 'block' : 'none';
      $('#screenshotStatus').textContent=''; $('#screenshotFile').value='';
    });
  });
  $('#screenshotRow').style.display = ['food','sleep','workout'].includes(currentType) ? 'block' : 'none';
  $('#addInterruptionBtn').addEventListener('click', ()=>{ interruptions.push({time:'', note:''}); renderInterruptions(); });

  $('#addEntryBtn').addEventListener('click', async ()=>{
    const entry = buildEntry();
    if(!entry){ alert('Add at least one detail before saving.'); return; }
    const date = $('#entryDate').value;
    let ok;
    if(editingId){
      ok = await updateEntry(editingId, date, entry);
    } else {
      ok = await addEntry(date, entry);
    }
    if(ok){
      exitEditMode();
      clearTypeFields();
      onEntrySaved();
      const btn = $('#addEntryBtn'); const old = btn.textContent;
      btn.textContent = editingId ? old : 'Added'; setTimeout(()=>btn.textContent=old, 900);
    }
  });
  $('#cancelEditBtn').addEventListener('click', ()=>{ exitEditMode(); clearTypeFields(); });
  $('#screenshotFile').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(file) analyzeScreenshot(currentType, file);
  });
}

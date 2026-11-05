// The Insights tab: progress, the medication-overuse flag, one thing to try next
// and the charts.
import { data, emptyOnError } from './data.js';
import { localDate } from './dates.js';
import { foodNames } from './food-items.js';
import { $, escapeHtml } from './ui.js';
import { daysWithHeadacheDates, headacheDaySet } from './headache.js';
import { buildStats, headacheDaysByCycleDay, ruleSuggestion } from './patterns.js';
import { activeTrial, reviewTrial, startTrial, stopGate, trialDay, trialLabel } from './trials.js';

let analyzing = false;

export async function renderAnalysis(){
  await loadTrialState();
  if(!activeTrial(trials)) showSavedInsight($('#aiOutput'));
  const days = await emptyOnError(data().listAll());
  const n = days.length;
  $('#progressNote').innerHTML = n===0
    ? 'No entries yet.'
    : `<b>${n}</b> day${n===1?'':'s'} with at least one entry. ${n<28 ? `Keep going — a full month (you're at ${Math.round(n/28*100)}%) gives enough range to see cycle-related and slower-building patterns, not just same-day ones.` : 'You have a solid month of data — patterns should be starting to show. Still a conversation-starter for your doctor, not a diagnosis.'}`;

  // MOH check: acute med days in the last 30 days
  const last30 = days.filter(d=> (new Date() - new Date(d.date+'T00:00:00'))/86400000 <= 30);
  const acuteDays = last30.filter(d=> d.entries.some(e=>e.type==='meds' && e.category==='acute')).length;
  const mohCard = $('#mohWarnCard');
  if(acuteDays >= 8){
    mohCard.style.display='block';
    mohCard.innerHTML = `<div class="warn-box"><b>Worth flagging to your doctor:</b> you've logged acute/rescue medication on <b>${acuteDays}</b> of the last 30 days. Regular use of acute headache medication on 10+ days a month (or 15+ for simple pain relievers like NSAIDs) for more than 3 months can itself cause a second headache disorder called medication-overuse headache. This isn't a diagnosis — just something concrete to bring up at your next visit.</div>`;
  } else { mohCard.style.display='none'; }

  const dayRollups = rollUpDays(days);
  const withH = dayRollups.filter(d=>d.hasHeadache);
  const withoutH = dayRollups.filter(d=>!d.hasHeadache);
  const avg = arr => { const v=arr.map(d=>d.sleepHours).filter(x=>x!=null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const avgH = avg(withH), avgN = avg(withoutH);
  let sleepHtml='';
  if(avgH==null && avgN==null){ sleepHtml='<div class="empty">Not enough sleep data yet.</div>'; }
  else{
    const max = Math.max(avgH||0, avgN||0, 8);
    sleepHtml += barRow('Headache days', avgH, max, withH.length, v=>v.toFixed(1)+'h');
    sleepHtml += barRow('No headache', avgN, max, withoutH.length, v=>v.toFixed(1)+'h');
  }
  $('#sleepChart').innerHTML = sleepHtml;
  $('#foodChart').innerHTML = freqChart(withH, d=>d.foods, 'var(--tag-headache)');
  $('#medChart').innerHTML = freqChart(withH, d=>d.meds, 'var(--tag-food)');

  // Cycle chart
  const { periodStarts, byCycleDay } = headacheDaysByCycleDay(days);
  if(periodStarts.length===0){
    $('#cycleChart').innerHTML = '<div class="empty">Log period days to see this — need at least one logged period start.</div>';
  } else {
    const relevant = Object.entries(byCycleDay).filter(([k])=>{ const v=parseInt(k); return v>=-5 && v<=7; }).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
    if(relevant.length===0){
      $('#cycleChart').innerHTML = '<div class="empty">No headache days logged near a period start yet.</div>';
    } else {
      const max = Math.max(...relevant.map(([,v])=>v));
      $('#cycleChart').innerHTML = '<div class="analysis-note" style="margin-bottom:8px;">Day 0 = first day of period. Migraines clustering around days -2 to +3 suggest a menstrual pattern.</div>' +
        relevant.map(([k,v])=> barRow('Day '+k, v, max, null, x=>String(x))).join('');
    }
  }
}

// Every date a headache touches is a headache day, with or without a severity.
// A food counts once a day, however many entries it is in.
export function rollUpDays(days){
  const headacheDays = headacheDaySet(days);
  return daysWithHeadacheDates(days).map(d=>{
    const sleepEntry = d.entries.find(e=>e.type==='sleep' && e.hours!=null);
    const foods = [...new Set(d.entries.filter(e=>e.type==='food').flatMap(foodNames))];
    const meds = d.entries.filter(e=>e.type==='meds').map(e=>e.name.toLowerCase().trim());
    return { date: d.date, hasHeadache: headacheDays.has(d.date), sleepHours: sleepEntry?sleepEntry.hours:null, foods, meds };
  });
}

function barRow(label, val, max, count, fmt){
  const pct = val==null?0:Math.min(100,(val/max)*100);
  return `<div class="bar-row"><div class="label">${label}${count!=null?`<span class="count-pill">n=${count}</span>`:''}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="bar-val">${val==null?'—':fmt(val)}</div></div>`;
}
export function freqChart(subset, extractor, color){
  if(subset.length===0) return '<div class="empty">No headache days logged yet.</div>';
  const counts={};
  subset.forEach(d=> extractor(d).forEach(item=>{ if(!item) return; counts[item]=(counts[item]||0)+1; }));
  const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if(sorted.length===0) return '<div class="empty">Nothing logged on headache days yet.</div>';
  const max = sorted[0][1];
  return sorted.map(([item,count])=>{
    const pct=(count/max)*100;
    return `<div class="bar-row"><div class="label">${escapeHtml(item)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%; background:${color}"></div></div>
      <div class="bar-val">${count}/${subset.length}</div></div>`;
  }).join('');
}

// Every field is AI or logged text, so all of it goes in through textContent.
export function renderInsight(result, container, { onStart } = {}){
  const doc = container.ownerDocument;
  const make = (tag, className, text)=>{
    const node = doc.createElement(tag);
    node.className = className;
    if(text != null) node.textContent = text;
    return node;
  };
  const section = (heading, ...content)=>{
    const box = make('section', 'insight-section');
    box.append(make('h3', 'insight-heading', heading), ...content);
    return box;
  };
  const list = (items, fill)=>{
    const ul = make('ul', 'insight-list');
    ul.append(...items.map(item=> fill(make('li', 'insight-item'), item)));
    return ul;
  };

  const next = result.try_next;
  const meta = make('div', 'pill-row');
  meta.append(make('span', 'pill', `Confidence: ${next.confidence}`), make('span', 'pill', `${next.days} days`));
  const sections = [section('Try this next',
    make('p', 'insight-title', next.title),
    make('p', 'insight-text', next.action),
    make('p', 'insight-why', next.why),
    meta)];
  if(onStart) sections[0].append(startControl(make, onStart));

  if(result.also_watching?.length){
    sections.push(section('Also watching', list(result.also_watching, (li, { item, evidence })=>{
      li.append(make('b', 'insight-item-name', item), make('span', 'insight-text', evidence));
      return li;
    })));
  }
  if(result.keep_logging) sections.push(section('Keep logging', make('p', 'insight-text', result.keep_logging)));
  if(result.cycle_note) sections.push(section('Your cycle', make('p', 'insight-text', result.cycle_note)));
  if(result.medication_note) sections.push(section('Medication', make('p', 'insight-text', result.medication_note)));
  if(result.doctor_questions?.length){
    sections.push(section('Questions for your doctor', list(result.doctor_questions, (li, question)=>{
      li.textContent = question;
      return li;
    })));
  }
  if(result.source === 'rules'){
    sections.push(make('p', 'analysis-note', "The AI wasn't used for this one, so it comes from the app's own counts."));
  }
  container.replaceChildren(...sections);
}

// The last result, with no AI call. A failed read only logs.
export async function showSavedInsight(container){
  try{
    const saved = await data().getInsight();
    if(saved?.result?.try_next && !analyzing) renderInsight(saved.result, container, { onStart: startFrom });
  }catch(error){
    console.error(error);
  }
}

// When the AI function cannot be reached. Rejects if the log cannot be read,
// because an empty log would give a suggestion that is simply wrong.
async function localInsight(today){
  const [days, meds] = await Promise.all([data().listAll(), emptyOnError(data().listMeds())]);
  const stats = buildStats(days, { today, medNames: meds.map(med=> med.name) });
  return { ...ruleSuggestion(stats), source: 'rules' };
}

async function saveInsight(insight){
  try{
    await data().saveInsight(insight);
  }catch(error){
    console.error(error);
  }
}

// Only a server answer is saved. A local fallback is worth seeing once, not
// worth replacing the last AI result for.
export async function requestInsight(today = localDate()){
  let insight;
  try{
    const { result, source } = await data().ai('analyze', { today });
    if(!result?.try_next) throw new Error('The analysis came back empty.');
    insight = { ...result, source };
  }catch(error){
    console.error(error);
    return localInsight(today);
  }
  await saveInsight(insight);
  return insight;
}

// ---------- Tracked trials ----------
let trials = [];            // newest first, as last read
let trialsError = null;     // why the last read or review save failed
let settling = null;        // one review save at a time, whoever asks
const keptIds = new Set();  // reviews the person has dismissed

function loadKept(){
  try{ JSON.parse(localStorage.getItem('keptTrials') || '[]').forEach(id=> keptIds.add(id)); }catch(error){ /* nothing remembered */ }
}
function rememberKept(id){
  keptIds.add(id);
  try{ localStorage.setItem('keptTrials', JSON.stringify([...keptIds])); }catch(error){ /* kept for this visit only */ }
}

const swap = (list, row)=> list.map(t=> t.id === row.id ? row : t);

async function settle(today){
  let list = await data().listTrials();
  const ended = list.filter(t=> t.status === 'active' && today > t.end_date);
  if(ended.length === 0) return { trials: list, error: null };
  try{
    const days = await data().listAll();
    for(const trial of ended){
      const saved = await data().saveTrial({ ...trial, status: 'completed', result: reviewTrial(trial, days) });
      list = swap(list, saved);
    }
    return { trials: list, error: null };
  }catch(error){
    console.error(error);
    return { trials: list, error };
  }
}

// Reads the trials and saves the review of any that ended, once, with one
// write each. Rejects only when the trials cannot be read.
export function settleTrials(today = localDate()){
  if(!settling) settling = settle(today).finally(()=>{ settling = null; });
  return settling;
}

async function loadTrialState(){
  loadKept();
  try{
    ({ trials, error: trialsError } = await settleTrials());
  }catch(error){
    console.error(error);
    trials = []; trialsError = error;
  }
  renderTrialPanel();
}

function h(tag, className, text, doc = document){
  const node = doc.createElement(tag);
  if(className) node.className = className;
  if(text != null) node.textContent = text;
  return node;
}

// A button whose save can fail: the error and Retry stay on screen and the
// state is kept.
function errorBox(doc = document){
  const box = h('div', 'warn-box', null, doc);
  box.setAttribute?.('role', 'alert');
  box.hidden = true;
  return box;
}
function showError(box, message, retry){
  const doc = box.ownerDocument;
  const retryBtn = h('button', 'btn small', 'Retry', doc);
  retryBtn.type = 'button';
  retryBtn.addEventListener('click', retry);
  box.replaceChildren(h('div', null, message, doc), retryBtn);
  box.hidden = false;
}

function startControl(make, onStart){
  const wrap = make('div', 'trial-start');
  const btn = make('button', 'btn small', 'Start this');
  btn.type = 'button';
  const box = errorBox(wrap.ownerDocument);
  const go = async ()=>{
    btn.disabled = true; box.hidden = true;
    try{
      await onStart();
    }catch(error){
      console.error(error);
      showError(box, 'Could not start the trial: ' + (error.message || error) + ' Nothing was lost.', go);
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', go);
  wrap.append(btn, box);
  return wrap;
}

// Reads the trials fresh, so a trial started on another device is seen.
export async function startFrom(result){
  const today = localDate();
  const fresh = await data().listTrials();
  const trial = startTrial(result.try_next, today, fresh);
  if(!trial) throw new Error('A trial is already running.');
  const saved = await data().saveTrial(trial);
  trials = [saved, ...fresh];
  renderTrialPanel();
}

// Stopped trials keep their dates and have no result. Rejects if the save fails.
export async function stopTrial(trial){
  const saved = await data().saveTrial({ ...trial, status: 'stopped', result: null });
  trials = swap(trials, saved);
  return saved;
}

const perWeekText = value => value == null ? 'not enough logged' : `${value} a week`;

function reviewCard(trial){
  const card = h('div', 'trial-review');
  card.append(h('h3', 'insight-heading', `${trialLabel(trial)} finished`),
    h('p', 'insight-title', trial.suggestion.title),
    h('p', 'insight-text', trial.result.summary));
  const keep = h('button', 'btn small', 'Keep');
  keep.type = 'button';
  keep.addEventListener('click', ()=>{ rememberKept(trial.id); renderTrialPanel(); });
  card.append(keep, h('p', 'analysis-note', 'Keep leaves things as they are. Or analyze again for the next suggestion.'));
  return card;
}

function activeCard(trial, today){
  const card = h('div', 'trial-active');
  const { day, total } = trialDay(trial, today);
  card.append(h('h3', 'insight-heading', `${trialLabel(trial)}: day ${day} of ${total}`),
    h('p', 'insight-title', trial.suggestion.title));
  if(trial.suggestion.action) card.append(h('p', 'insight-text', trial.suggestion.action));
  if(today > trial.end_date){
    card.append(h('p', 'analysis-note', 'This trial has ended. Its review could not be saved yet.'));
  }
  const stop = h('button', 'btn small ghost', 'Stop this trial');
  stop.type = 'button';
  const box = errorBox();
  const gate = stopGate();
  const doStop = async ()=>{
    stop.disabled = true; box.hidden = true;
    try{
      await stopTrial(trial);
      renderTrialPanel();
    }catch(error){
      console.error(error);
      stop.disabled = false;
      showError(box, 'Could not stop the trial: ' + (error.message || error) + ' It is still running.', doStop);
    }
  };
  const cancel = h('button', 'link-btn', 'Keep going');
  cancel.type = 'button';
  cancel.hidden = true;
  stop.addEventListener('click', ()=>{
    if(gate.press() === 'arm'){
      stop.textContent = 'Tap again to stop'; cancel.hidden = false;
      return;
    }
    doStop();
  });
  cancel.addEventListener('click', ()=>{ gate.cancel(); stop.textContent = 'Stop this trial'; cancel.hidden = true; });
  card.append(stop, cancel, box);
  return card;
}

function pastList(past){
  const list = h('ul', 'insight-list');
  past.forEach(trial=>{
    const li = h('li', 'insight-item');
    li.append(h('b', 'insight-item-name', trial.suggestion.title));
    const range = `${trial.start_date} to ${trial.end_date}`;
    const outcome = trial.status === 'stopped' ? 'Stopped early.'
      : trial.result ? `Before: ${perWeekText(trial.result.before)}. During: ${perWeekText(trial.result.during)}.`
      : 'Finished.';
    li.append(h('span', 'insight-text', `${range}. ${outcome}`));
    list.append(li);
  });
  return list;
}

function renderTrialPanel(){
  if(typeof document === 'undefined') return;
  const panel = $('#trialPanel');
  if(!panel) return;
  const today = localDate();
  const active = activeTrial(trials);
  const newest = trials[0];
  const review = newest && newest.status === 'completed' && newest.result && !keptIds.has(newest.id) ? newest : null;
  const nodes = [];
  if(trialsError && !active && !review && trials.length === 0){
    const box = errorBox();
    showError(box, 'Could not load your trials: ' + (trialsError.message || trialsError), ()=>{ loadTrialState(); });
    nodes.push(box);
  }
  if(active) nodes.push(activeCard(active, today));
  else if(review) nodes.push(reviewCard(review));
  if(active && trialsError){
    const box = errorBox();
    showError(box, 'The finished trial could not be saved: ' + (trialsError.message || trialsError), ()=>{ loadTrialState(); });
    nodes.push(box);
  }
  panel.replaceChildren(...nodes);
  $('#aiAnalyzeBtn').hidden = Boolean(active);
  $('#aiOutput').hidden = Boolean(active);
  const past = trials.filter(t=> t.status !== 'active');
  $('#pastTrialsCard').hidden = past.length === 0;
  $('#pastTrials').replaceChildren(...(past.length ? [pastList(past)] : []));
}

export function initInsights(){
  $('#aiAnalyzeBtn').addEventListener('click', async ()=>{
    const out = $('#aiOutput');
    const btn = $('#aiAnalyzeBtn');
    analyzing = true;
    btn.disabled = true; btn.textContent = 'Analyzing...';
    out.textContent = '';
    try{
      renderInsight(await requestInsight(), out, { onStart: startFrom });
    }catch(e){
      console.error(e);
      out.textContent = 'Analysis failed: ' + (e.message || e);
    }finally{
      analyzing = false;
      btn.disabled = false; btn.textContent = 'Analyze my data';
    }
  });
}

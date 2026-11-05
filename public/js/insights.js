// The Analysis tab: progress, the medication-overuse flag, charts and AI analysis.
import { data, emptyOnError } from './data.js';
import { $, escapeHtml } from './ui.js';

function findCycleDays(days){
  // Returns sorted list of period start dates (first day with any 'period' entry after a gap of 20+ days from the previous one)
  const periodDates = days.filter(d=> d.entries.some(e=>e.type==='period')).map(d=>d.date).sort();
  const starts = [];
  let last = null;
  periodDates.forEach(dateStr=>{
    const d = new Date(dateStr+'T00:00:00');
    if(!last || (d - last)/86400000 > 20){ starts.push(d); }
    last = d;
  });
  return starts;
}
function cycleDayFor(dateStr, periodStarts){
  const d = new Date(dateStr+'T00:00:00');
  let best = null;
  periodStarts.forEach(start=>{
    const diff = Math.round((d - start)/86400000);
    if(diff >= -7 && diff <= 35){
      if(best===null || Math.abs(diff) < Math.abs(best)) best = diff;
    }
  });
  return best;
}

export async function renderAnalysis(){
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

  const dayRollups = days.map(d=>{
    const headacheEntries = d.entries.filter(e=>e.type==='headache' && e.severity!=null);
    const sleepEntry = d.entries.find(e=>e.type==='sleep' && e.hours!=null);
    const foods = d.entries.filter(e=>e.type==='food').map(e=>e.text.toLowerCase().trim());
    const meds = d.entries.filter(e=>e.type==='meds').map(e=>e.name.toLowerCase().trim());
    return { date: d.date, hasHeadache: headacheEntries.length>0, sleepHours: sleepEntry?sleepEntry.hours:null, foods, meds };
  });
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
  const periodStarts = findCycleDays(days);
  if(periodStarts.length===0){
    $('#cycleChart').innerHTML = '<div class="empty">Log period days to see this — need at least one logged period start.</div>';
  } else {
    const byCycleDay = {};
    dayRollups.forEach(d=>{
      if(!d.hasHeadache) return;
      const cd = cycleDayFor(d.date, periodStarts);
      if(cd===null) return;
      const key = cd<0 ? String(cd) : '+'+cd;
      byCycleDay[key] = (byCycleDay[key]||0)+1;
    });
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

function barRow(label, val, max, count, fmt){
  const pct = val==null?0:Math.min(100,(val/max)*100);
  return `<div class="bar-row"><div class="label">${label}${count!=null?`<span class="count-pill">n=${count}</span>`:''}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="bar-val">${val==null?'—':fmt(val)}</div></div>`;
}
function freqChart(subset, extractor, color){
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

export function initInsights(){
  $('#aiAnalyzeBtn').addEventListener('click', async ()=>{
    const out = $('#aiOutput');
    const btn = $('#aiAnalyzeBtn');
    btn.disabled = true; btn.textContent = 'Analyzing...';
    out.textContent = '';
    try{
      const days = await emptyOnError(data().listAll());
      if(days.length < 5){
        out.textContent = 'Log at least a few days first — there\'s not enough data yet for a meaningful analysis.';
        return;
      }
      const { text } = await data().ai('analyze', {});
      out.textContent = text;
    }catch(e){
      console.error(e);
      out.textContent = 'Analysis failed: ' + (e.message || e);
    }finally{
      btn.disabled = false; btn.textContent = 'Analyze my data';
    }
  });
}

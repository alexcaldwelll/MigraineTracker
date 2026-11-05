// Entry point: builds the Supabase backend, wires every screen, starts auth.
import { initAuth } from './auth.js';
import { createSupabaseBackend, data, setBackend } from './data.js';
import { backfillFood, canSendToAi, retryPendingSplits } from './food.js';
import { initForms } from './forms.js';
import { renderHistory, initHistory } from './history.js';
import { renderAnalysis, initInsights } from './insights.js';
import { refreshHeadache, refreshTrialCard, renderToday, initToday } from './today.js';
import { $, $$, activateTab } from './ui.js';

const SUPABASE_URL = 'https://piiahxbeqsrzagjximoh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpaWFoeGJlcXNyemFnanhpbW9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1OTg1NzMsImV4cCI6MjA5OTE3NDU3M30.cWRlOx3XfE1ImM84vCqglnql1NuS0OvVcao-Ulhqg1s';

// Missing if the CDN script was blocked or failed its integrity check.
const client = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) ?? null;
if(client) setBackend(createSupabaseBackend(client));

let appInitialized = false;
function initApp(){
  if(appInitialized) return;
  appInitialized = true;
  renderToday();
  refreshHeadache();
  refreshTrialCard();
  showAiNoticeIfNeeded();
  retryPending();
}

// Food saved while the AI was down or the notice was unread is sorted now,
// then a batch of old entries. Runs in the background; nothing waits on it.
async function retryPending(){
  try{
    const days = await data().listAll();
    let changed = await retryPendingSplits(days, new Date()) > 0;
    // Old one-line entries: one small batch per app open, after the retries.
    // Re-read so entries the retries just wrote are not picked again.
    if(await backfillFood(await data().listAll()) > 0) changed = true;
    if(changed) renderToday();
  }catch(error){
    console.error(error);
  }
}

// Shown once, after the password gate. Until it is accepted, nothing is sent
// to the AI; everything else works.
async function showAiNoticeIfNeeded(){
  try{
    if(canSendToAi(await data().getSettings())) return;
  }catch(error){
    console.error(error);
    return;
  }
  const dialog = $('#aiNotice'), btn = $('#aiNoticeBtn'), error = $('#aiNoticeError');
  btn.onclick = async ()=>{
    btn.disabled = true; error.hidden = true;
    try{
      await data().saveSettings({ ai_notice_seen_at: new Date().toISOString() });
      dialog.close();
    }catch(e){
      console.error(e);
      error.textContent = 'Could not save that: ' + (e.message || e) + ' AI sorting stays off until it saves. Try again.';
      error.hidden = false;
    }finally{
      btn.disabled = false;
    }
  };
  dialog.showModal();
}

$$('nav button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    activateTab(btn.dataset.tab);
    if(btn.dataset.tab==='today') refreshTrialCard();
    if(btn.dataset.tab==='history') renderHistory();
    if(btn.dataset.tab==='insights') renderAnalysis();
  });
});

initForms({
  onEntrySaved: (entry)=>{ if(entry && entry.type==='headache') refreshHeadache(); renderToday(); },
  onMedSaved: renderToday,
});
initToday({ onEntryChanged: renderHistory });
initHistory();
initInsights();
initAuth(client, initApp);

// Entry point: builds the Supabase backend, wires every screen, starts auth.
import { initAuth } from './auth.js';
import { createSupabaseBackend, setBackend } from './data.js';
import { initForms } from './forms.js';
import { renderHistory, initHistory } from './history.js';
import { renderAnalysis, initInsights } from './insights.js';
import { renderToday, initToday } from './today.js';
import { $$, activateTab } from './ui.js';

const SUPABASE_URL = 'https://piiahxbeqsrzagjximoh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpaWFoeGJlcXNyemFnanhpbW9oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1OTg1NzMsImV4cCI6MjA5OTE3NDU3M30.cWRlOx3XfE1ImM84vCqglnql1NuS0OvVcao-Ulhqg1s';

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
setBackend(createSupabaseBackend(client));

let appInitialized = false;
function initApp(){
  if(appInitialized) return;
  appInitialized = true;
  renderToday();
}

$$('nav button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    activateTab(btn.dataset.tab);
    if(btn.dataset.tab==='history') renderHistory();
    if(btn.dataset.tab==='insights') renderAnalysis();
  });
});

initForms({
  onEntrySaved: renderToday,
  onMedSaved: renderToday,
});
initToday({ onEntryDeleted: renderHistory });
initHistory();
initInsights();
initAuth(client, initApp);

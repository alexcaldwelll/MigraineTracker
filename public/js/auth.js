// Sign-in, sign-out and the required password change. The Supabase client is
// passed in for its auth calls; settings go through data() like everything else.
import { data } from './data.js';
import { $ } from './ui.js';

const MIN_PASSWORD_LENGTH = 10;
let passwordMode = 'required'; // 'required' (first sign-in) or 'change' (from the header)
let gatedUserId = null;        // user already sent through the gate; ignore repeat sign-in events
let gateRun = 0;               // guards against overlapping gate checks
let enterApp = ()=>{};         // starts the app once someone has passed the gate

function showOnly(which){
  $('#authScreen').style.display = which==='auth' ? 'block' : 'none';
  $('#passwordScreen').style.display = which==='password' ? 'block' : 'none';
  $('#app').style.display = which==='app' ? 'block' : 'none';
}
function openPasswordScreen(mode){
  passwordMode = mode;
  $('#newPassword').value = ''; $('#confirmPassword').value = '';
  $('#passwordStatus').textContent = '';
  $('#passwordForm').style.display = 'block';
  $('#gateRetry').style.display = 'none';
  $('#cancelPasswordBtn').style.display = mode==='change' ? 'block' : 'none';
  $('#passwordSignOutBtn').style.display = mode==='change' ? 'none' : 'block';
  $('#passwordSub').textContent = mode==='change'
    ? 'Choose a new password.'
    : 'Welcome! Choose your own password to continue. It must be at least ' + MIN_PASSWORD_LENGTH + ' characters.';
  showOnly('password');
}
// Decide whether a signed-in person may enter the app. On any failure they stay out.
async function gateSession(){
  const run = ++gateRun;
  showOnly('password');
  $('#passwordForm').style.display = 'none';
  $('#gateRetry').style.display = 'none';
  $('#passwordSignOutBtn').style.display = 'block';
  $('#passwordSub').textContent = 'Checking your account...';
  $('#passwordStatus').textContent = '';
  let settings;
  try{
    settings = await data().getSettings();
  }catch(error){
    if(run !== gateRun) return;
    console.error(error);
    $('#passwordSub').textContent = 'We could not check your account.';
    $('#passwordStatus').textContent = 'Error: ' + error.message + ' Try again, or sign out.';
    $('#gateRetry').style.display = 'block';
    return;
  }
  if(run !== gateRun) return;
  if(!settings || !settings.password_set_at){ openPasswordScreen('required'); return; }
  showOnly('app');
  enterApp();
}
function showPasswordChangedNote(){
  const note = document.createElement('div');
  note.setAttribute('role', 'status');
  note.textContent = 'Password changed.';
  note.style.cssText = 'position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:var(--ink); color:var(--paper); padding:10px 16px; border-radius:8px; font-size:14px; z-index:200;';
  document.body.appendChild(note);
  setTimeout(()=> note.remove(), 4000);
}

export function initAuth(client, onEnter){
  enterApp = onEnter;

  $('#authSignInBtn').addEventListener('click', async ()=>{
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    if(!email || !password){ $('#authStatus').textContent = 'Enter both email and password.'; return; }
    $('#authStatus').textContent = 'Signing in...';
    const { error } = await client.auth.signInWithPassword({ email, password });
    $('#authStatus').textContent = error ? ('Error: ' + error.message) : '';
  });
  $('#gateRetryBtn').addEventListener('click', gateSession);
  $('#savePasswordBtn').addEventListener('click', async ()=>{
    const pw = $('#newPassword').value, confirmPw = $('#confirmPassword').value;
    const status = $('#passwordStatus');
    if(pw.length < MIN_PASSWORD_LENGTH){ status.textContent = 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters.'; return; }
    if(pw !== confirmPw){ status.textContent = 'The two passwords do not match.'; return; }
    const btn = $('#savePasswordBtn');
    btn.disabled = true; status.textContent = 'Saving...';
    try{
      const { error } = await client.auth.updateUser({ password: pw });
      if(error){ status.textContent = 'Error: ' + error.message; return; }
      try{
        await data().saveSettings({ password_set_at: new Date().toISOString() });
      }catch(saveError){
        console.error(saveError);
        status.textContent = 'Your password was changed, but we could not record it: ' + saveError.message + ' Press Save password again to retry.';
        return;
      }
      if(passwordMode === 'change'){
        showOnly('app');
        showPasswordChangedNote();
      } else {
        showOnly('app');
        enterApp();
      }
    }catch(e){
      console.error(e);
      status.textContent = 'Error: ' + (e.message || e);
    }finally{
      btn.disabled = false;
    }
  });
  $('#changePasswordBtn').addEventListener('click', ()=> openPasswordScreen('change'));
  $('#cancelPasswordBtn').addEventListener('click', ()=> showOnly('app'));
  async function signOut(){ await client.auth.signOut(); location.reload(); }
  $('#signOutBtn').addEventListener('click', signOut);
  $('#passwordSignOutBtn').addEventListener('click', signOut);
  client.auth.onAuthStateChange((event, session)=>{
    if(!session){ gateRun++; gatedUserId = null; showOnly('auth'); return; }
    // Token refreshes and updateUser fire this too; only a new sign-in needs the gate.
    if(event === 'INITIAL_SESSION' || event === 'SIGNED_IN'){
      if(gatedUserId === session.user.id) return;
      gatedUserId = session.user.id;
      // Defer: calling Supabase inside this callback can deadlock the client.
      setTimeout(gateSession, 0);
    }
  });
}

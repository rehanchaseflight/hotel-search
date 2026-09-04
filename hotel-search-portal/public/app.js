let tempToken = null;
let currentSearchId = null;
let currentSources = [];

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'include', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('login-error').textContent = '';
  try { const data = await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})}); tempToken=data.tempToken; hide('login-view'); show('twofa-view'); }
  catch(err){$('login-error').textContent=err.message;}
});

$('twofa-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('twofa-error').textContent='';
  try { const data=await api('/api/auth/verify-2fa',{method:'POST',body:JSON.stringify({tempToken,code:$('twofa-code').value})}); hide('twofa-view'); $('who').textContent=data.username; show('app-view'); loadSources(); applyRole(data.role); }
  catch(err){$('twofa-error').textContent=err.message;}
});

$('logout-btn').addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});location.reload();});

function applyRole(role){
  const admin=role==='ADMIN'||role==='SUPER_ADMIN';
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',!admin));
}

async function loadSources(){
  currentSources=await api('/api/sources');
  const tbody=document.querySelector('#sources-table tbody'); tbody.innerHTML='';
  const select=$('c-source'); select.innerHTML='';
  currentSources.forEach(s=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${s.name}</td><td><a href="${s.login_url}" target="_blank" rel="noopener noreferrer">${s.login_url}</a></td><td>${s.site_username||''}</td><td>Protected</td><td class="admin-only"><button data-id="${s.id}" class="del-source">Remove</button></td>`;
    tbody.appendChild(tr);
    const opt=document.createElement('option'); opt.value=s.id; opt.textContent=s.name; select.appendChild(opt);
  });
  document.querySelectorAll('.del-source').forEach(btn=>btn.addEventListener('click',async()=>{await api('/api/sources/'+btn.dataset.id,{method:'DELETE'});loadSources();}));
}

$('source-form').addEventListener('submit',async(e)=>{e.preventDefault();await api('/api/sources',{method:'POST',body:JSON.stringify({name:$('src-name').value,login_url:$('src-url').value,deep_link_template:$('src-template').value,site_username:$('src-username').value,site_password:$('src-password').value})});e.target.reset();loadSources();});

$('search-form').addEventListener('submit',async(e)=>{e.preventDefault();try{const data=await api('/api/search',{method:'POST',body:JSON.stringify({destination:$('s-destination').value,checkin:$('s-checkin').value,checkout:$('s-checkout').value,guests:Number($('s-guests').value)})});currentSearchId=data.searchId;show('results-section');const list=$('links-list');list.innerHTML='';data.links.forEach(l=>{const a=document.createElement('a');a.href=l.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=l.name;list.appendChild(a);});loadComparisons();}catch(err){alert(err.message);}});

async function loadComparisons(){if(!currentSearchId)return;const rows=await api('/api/comparisons/'+currentSearchId);const tbody=document.querySelector('#compare-table tbody');tbody.innerHTML='';rows.forEach(r=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${r.source_name}</td><td>${r.price}</td><td>${r.room_type||''}</td><td>${r.notes||''}</td><td><button data-id="${r.id}" class="del-comp">x</button></td>`;tbody.appendChild(tr);});document.querySelectorAll('.del-comp').forEach(btn=>btn.addEventListener('click',async()=>{await api('/api/comparisons/'+btn.dataset.id,{method:'DELETE'});loadComparisons();}));}

$('compare-form').addEventListener('submit',async(e)=>{e.preventDefault();if(!currentSearchId)return;await api('/api/comparisons',{method:'POST',body:JSON.stringify({search_id:currentSearchId,source_id:Number($('c-source').value),price:$('c-price').value,room_type:$('c-room').value,notes:$('c-notes').value})});e.target.reset();loadComparisons();});

(async()=>{try{const me=await api('/api/auth/me');$('who').textContent=me.username;hide('login-view');show('app-view');applyRole(me.role);loadSources();}catch{}})();

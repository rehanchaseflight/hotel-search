let tempToken=null,currentSearchId=null,currentSources=[];
const $=id=>document.getElementById(id),show=id=>$(id).classList.remove("hidden"),hide=id=>$(id).classList.add("hidden");

(function setupDestinationAutocomplete(){
  const input=$('s-destination');
  const countryInput=$('s-destination-country');

  if(!input||!countryInput)return;

  let dropdown=null;
  let timer=null;
  let requestId=0;
  let selected=false;

  function ensureDropdown(){
    if(dropdown)return;

    dropdown=document.createElement('div');
    dropdown.id='destination-suggestions';
    dropdown.style.cssText=[
      'position:absolute',
      'z-index:99999',
      'background:#fff',
      'border:1px solid #d1d5db',
      'border-radius:8px',
      'box-shadow:0 8px 24px rgba(0,0,0,.12)',
      'max-height:280px',
      'overflow-y:auto',
      'display:none',
      'box-sizing:border-box'
    ].join(';');

    document.body.appendChild(dropdown);
  }

  function positionDropdown(){
    if(!dropdown)return;

    const r=input.getBoundingClientRect();

    dropdown.style.left=(r.left+window.scrollX)+'px';
    dropdown.style.top=(r.bottom+window.scrollY+4)+'px';
    dropdown.style.width=r.width+'px';
  }

  function hideDropdown(){
    if(dropdown)dropdown.style.display='none';
  }

  function showDropdown(){
    ensureDropdown();
    positionDropdown();
    dropdown.style.display='block';
  }

  function escapeHtml(value){
    return String(value||'')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  async function searchDestinations(value){
    const q=String(value||'').trim();

    if(q.length<2){
      hideDropdown();
      return;
    }

    const id=++requestId;

    try{
      const res=await fetch('/api/destinations?q='+encodeURIComponent(q),{
        credentials:'same-origin',
        headers:{'Accept':'application/json'}
      });

      if(id!==requestId)return;

      if(!res.ok){
        hideDropdown();
        return;
      }

      const data=await res.json();

      if(id!==requestId)return;

      const results=Array.isArray(data.results)?data.results:[];

      if(!results.length){
        hideDropdown();
        return;
      }

      ensureDropdown();

      dropdown.innerHTML=results.map((item,index)=>`
        <div
          class="destination-option"
          data-index="${index}"
          style="padding:11px 13px;cursor:pointer;border-bottom:1px solid #f0f0f0;"
        >
          <div style="font-weight:600;color:#111827;">
            ${escapeHtml(item.city)}
          </div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">
            ${escapeHtml(item.country)}
          </div>
        </div>
      `).join('');

      [...dropdown.querySelectorAll('.destination-option')].forEach((el,index)=>{
        el.addEventListener('mouseenter',()=>{
          el.style.background='#f3f4f6';
        });

        el.addEventListener('mouseleave',()=>{
          el.style.background='';
        });

        el.addEventListener('mousedown',e=>{
          e.preventDefault();

          const item=results[index];
          if(!item)return;

          selected=true;

          input.value=item.display||`${item.city} - ${item.country}`;
          countryInput.value=item.country||'';

          input.dataset.city=item.city||'';
          input.dataset.country=item.country||'';
          input.dataset.rezlive=item.rezlive||`${item.city||''},${item.country||''}`;

          hideDropdown();
        });
      });

      showDropdown();

    }catch(err){
      console.error('Destination lookup failed:',err);
      hideDropdown();
    }
  }

  input.addEventListener('input',()=>{
    selected=false;

    input.dataset.city='';
    input.dataset.country='';
    input.dataset.rezlive='';

    countryInput.value='';

    clearTimeout(timer);

    const value=input.value.trim();

    if(value.length<2){
      hideDropdown();
      return;
    }

    timer=setTimeout(()=>{
      searchDestinations(value);
    },250);
  });

  input.addEventListener('focus',()=>{
    if(input.value.trim().length>=2&&!selected){
      clearTimeout(timer);
      searchDestinations(input.value.trim());
    }
  });

  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      hideDropdown();
    }
  });

  countryInput.addEventListener('input',()=>{
    selected=false;
    input.dataset.city='';
    input.dataset.country='';
    input.dataset.rezlive='';
  });

  document.addEventListener('click',e=>{
    if(e.target!==input&&!dropdown?.contains(e.target)&&e.target!==countryInput){
      hideDropdown();
    }
  });

  window.addEventListener('resize',positionDropdown);
  window.addEventListener('scroll',positionDropdown,true);

  ensureDropdown();
})();async function api(path,opts={}){const res=await fetch(path,{headers:{'Content-Type':'application/json'},credentials:'include',...opts});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Request failed');return data}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})});tempToken=d.tempToken;hide('login-view');show('twofa-view')}catch(err){$('login-error').textContent=err.message}});
$('twofa-form').addEventListener('submit',async e=>{e.preventDefault();$('twofa-error').textContent='';try{const d=await api('/api/auth/verify-2fa',{method:'POST',body:JSON.stringify({tempToken,code:$('twofa-code').value})});hide('twofa-view');$('who').textContent=d.username;show('app-view');applyRole(d.role);loadSources();loadSupplierHealth()}catch(err){$('twofa-error').textContent=err.message}});
$('logout-btn').addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});location.reload()});
function applyRole(role){document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hidden',!['ADMIN','SUPER_ADMIN'].includes(role)))}
function editSource(id){const source=currentSources.find(s=>String(s.id)===String(id));if(!source)return;$('source-name').value=source.name||'';$('source-login-url').value=source.login_url||'';$('source-agent-code').value=source.agent_code||'';$('source-username').value=source.site_username||'';$('source-password').value='';$('source-form').dataset.sourceId=source.id;$('source-form').dataset.editing='true';$('source-cancel').classList.remove('hidden');$('source-message').textContent=`Editing ${source.name}. Leave password blank to keep the existing password.`;$('source-name').focus();window.scrollTo({top:$('source-form').getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'})}
function cancelSourceEdit(){const form=$('source-form');form.dataset.sourceId='';form.dataset.editing='';$('source-name').value='WanderBeds';$('source-login-url').value='https://wanderbeds.com/?setlang=en';$('source-agent-code').value='';$('source-username').value='';$('source-password').value='';$('source-cancel').classList.add('hidden');$('source-message').textContent=''}

async function manualWanderBedsLogin(){
  try{
    const msg=$('source-message');
    if(msg){
      msg.textContent='Opening WanderBeds login browser...';
      msg.className='admin-message';
    }

    await api('/api/wanderbeds/manual-login',{
      method:'POST',
      body:JSON.stringify({})
    });

    const ok=confirm(
      'WanderBeds browser is open.\\n\\n' +
      'Complete the login manually.\\n' +
      'Wait for Trusted device / Redirecting to finish.\\n' +
      'When the WanderBeds dashboard appears, click OK.'
    );

    if(!ok)return;

    if(msg){
      msg.textContent='Verifying WanderBeds login...';
      msg.className='admin-message';
    }

    await api('/api/wanderbeds/manual-login/verify',{
      method:'POST',
      body:JSON.stringify({})
    });

    if(msg){
      msg.textContent='WanderBeds manual login verified successfully.';
      msg.className='admin-message success';
    }

    await loadSupplierHealth();

  }catch(err){
    const msg=$('source-message');
    if(msg){
      msg.textContent=err.message;
      msg.className='admin-message error';
    }else{
      alert(err.message);
    }
  }
}

async function loadSources(){try{currentSources=await api('/api/sources');renderSearchSupplierControls();const nameInput=$('source-name');const wanted=(nameInput?.value||'WanderBeds').trim();const editing=$('source-form')?.dataset.editing==='true';const source=currentSources.find(s=>new RegExp(wanted,'i').test(s.name||''))||currentSources.find(s=>/wanderbeds/i.test(s.name||''));if(source&&!editing){nameInput.value=source.name;$('source-login-url').value=source.login_url||'https://wanderbeds.com/?setlang=en';$('source-agent-code').value=source.agent_code||'';$('source-username').value=source.site_username||'';$('source-password').value='';$('source-form').dataset.sourceId=source.id}else if(!source&&!editing){$('source-form').dataset.sourceId=''}const tbody=document.querySelector('#sources-table tbody');if(!tbody)return;tbody.innerHTML='';currentSources.filter(s=>/hadaf|wanderbeds|locanda|rezlive/i.test(s.name||'')).forEach(s=>{const tr=document.createElement('tr');const credentialStatus=s.has_password?'Encrypted credentials':'Not configured';tr.innerHTML=`<td>${s.name}</td><td>${s.login_url||'—'}</td><td>Browser / B2B login</td><td>${credentialStatus}</td><td><button type="button" class="source-edit-btn" data-edit-source="${s.id}">Edit</button>${/wanderbeds/i.test(s.name||"")?'<button type="button" class="source-edit-btn" data-wanderbeds-login="1" style="margin-left:6px">Login Manually</button>':''}</td>`;tbody.appendChild(tr)})}catch(err){console.error(err)}}
async function saveSource(e){e.preventDefault();const msg=$('source-message');msg.textContent='';msg.className='admin-message';try{const supplier=$('source-name').value.trim()||'WanderBeds';const existing=currentSources.find(s=>String(s.id)==String($('source-form').dataset.sourceId))||currentSources.find(s=>new RegExp('^'+supplier.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i').test(s.name||''));const isLocanda=/locanda/i.test(supplier);const isRezLive=/rezlive/i.test(supplier);const browserConfig=isLocanda?{preset:'locanda',requires_manual_captcha:true}:isRezLive?{preset:'rezlive'}:{preset:'wanderbeds'};const payload={name:supplier,login_url:$('source-login-url').value.trim(),site_username:$('source-username').value.trim(),site_password:$('source-password').value,agent_code:$('source-agent-code').value.trim(),enabled:true,browser_config:browserConfig};if(existing){await api(`/api/sources/${existing.id}`,{method:'PUT',body:JSON.stringify(payload)});$('source-form').dataset.sourceId=existing.id;msg.textContent=`${supplier} credentials updated and encrypted.`}else{const d=await api('/api/sources',{method:'POST',body:JSON.stringify({...payload,connector_type:'browser'})});$('source-form').dataset.sourceId=d.id;msg.textContent=`${supplier} supplier saved. Credentials are encrypted.`}$('source-password').value='';$('source-form').dataset.editing='';$('source-cancel').classList.add('hidden');await loadSources();await loadSupplierHealth()}catch(err){msg.textContent=err.message;msg.className='admin-message error'}}
$('source-form')?.addEventListener('submit',saveSource);
$('source-cancel')?.addEventListener('click',cancelSourceEdit);

$('sources-table')?.addEventListener('click',e=>{
  const edit=e.target.closest('[data-edit-source]');
  if(edit){
    editSource(edit.dataset.editSource);
    return;
  }

  const login=e.target.closest('[data-wanderbeds-login]');
  if(login){
    manualWanderBedsLogin();
  }
});

async function loadSupplierHealth(){const box=$('dashboard-supplier-status');if(!box)return;try{box.innerHTML='<div class="searching-status">Checking supplier connections…</div>';renderSupplierStatus(await api('/api/supplier-health'),'dashboard-supplier-status')}catch(err){box.innerHTML=`<p class="error">Supplier health check failed: ${err.message}</p>`}}
function renderSupplierStatus(statuses,targetId='supplier-status'){const box=$(targetId);if(!box)return;box.innerHTML='';const list=Array.isArray(statuses)?statuses:[];const summary=document.createElement('div');summary.className='supplier-summary';summary.innerHTML=`<strong>${list.filter(x=>x.status==='live'||x.ok).length} live</strong>`;box.appendChild(summary);list.forEach(s=>{const card=document.createElement('div');card.className='supplier-status-card';const live=s.status==='live'||s.ok;card.innerHTML=`<span>${s.name}</span><span class="supplier-badge ${live?'live':'error'}">${live?'Live':'Offline'}</span>${s.error?`<small>${s.error}</small>`:''}`;box.appendChild(card)})}
function addCell(tr,value,cls=''){const td=document.createElement('td');td.textContent=value===null||value===undefined||value===''?'—':value;if(cls)td.className=cls;tr.appendChild(td)}
function getSelectedSupplierIds(){
  const selected=[];
  document
    .querySelectorAll('#search-supplier-controls input[data-source-id]')
    .forEach(input=>{
      if(input.checked){
        selected.push(String(input.dataset.sourceId));
      }
    });
  return selected;
}

function renderSearchSupplierControls(){
  const form=$('search-form');
  if(!form)return;

  let wrap=$('search-supplier-controls');

  if(!wrap){
    wrap=document.createElement('div');
    wrap.id='search-supplier-controls';
    wrap.style.margin='12px 0';
    wrap.style.padding='12px';
    wrap.style.border='1px solid #ddd';
    wrap.style.borderRadius='8px';

    const submitButton=form.querySelector('button[type="submit"]');

    if(submitButton){
      submitButton.parentNode.insertBefore(wrap,submitButton);
    }else{
      form.appendChild(wrap);
    }
  }

  const activeSources=(currentSources||[]).filter(
    s=>s && s.enabled!==false
  );

  wrap.innerHTML=`
    <div style="font-weight:600;margin-bottom:8px">
      Suppliers
    </div>

    <div id="supplier-selection-status"
         style="font-size:13px;margin-bottom:8px">
    </div>

    <div id="supplier-switches"
         style="display:flex;flex-wrap:wrap;gap:8px">
    </div>

    <div style="margin-top:10px;display:flex;gap:6px">
      <button type="button" id="supplier-select-all">Select All</button>
      <button type="button" id="supplier-clear-all">Clear All</button>
    </div>
  `;

  const switches=$('supplier-switches');

  activeSources.forEach(source=>{
    const id=String(source.id);
    const name=source.name||`Supplier ${id}`;

    const label=document.createElement('label');

    label.style.display='inline-flex';
    label.style.alignItems='center';
    label.style.gap='7px';
    label.style.padding='7px 11px';
    label.style.border='1px solid #ddd';
    label.style.borderRadius='20px';
    label.style.cursor='pointer';
    label.style.userSelect='none';
    label.style.background='#fff';

    const input=document.createElement('input');

    input.type='checkbox';
    input.checked=true;
    input.dataset.sourceId=id;
    input.style.display='none';

    const light=document.createElement('span');

    light.style.width='13px';
    light.style.height='13px';
    light.style.borderRadius='50%';
    light.style.display='inline-block';
    light.style.flexShrink='0';

    const state=document.createElement('span');

    state.style.fontWeight='700';
    state.style.minWidth='25px';

    const title=document.createElement('span');

    title.textContent=name;

    const update=()=>{
      if(input.checked){
        light.style.background='#16a34a';
        light.style.boxShadow='0 0 7px rgba(22,163,74,.8)';
        state.textContent='ON';
        state.style.color='#16a34a';
        label.style.borderColor='#16a34a';
      }else{
        light.style.background='#dc2626';
        light.style.boxShadow='0 0 7px rgba(220,38,38,.7)';
        state.textContent='OFF';
        state.style.color='#dc2626';
        label.style.borderColor='#dc2626';
      }

      const selected=getSelectedSupplierIds();
      const status=$('supplier-selection-status');

      if(status){
        status.textContent=
          `${selected.length} of ${activeSources.length} suppliers selected`;
      }
    };

    input.addEventListener('change',update);

    label.appendChild(input);
    label.appendChild(light);
    label.appendChild(title);
    label.appendChild(state);

    switches.appendChild(label);

    update();
  });

  $('supplier-select-all')?.addEventListener('click',()=>{
    wrap
      .querySelectorAll('input[data-source-id]')
      .forEach(input=>{
        input.checked=true;
        input.dispatchEvent(new Event('change'));
      });
  });

  $('supplier-clear-all')?.addEventListener('click',()=>{
    wrap
      .querySelectorAll('input[data-source-id]')
      .forEach(input=>{
        input.checked=false;
        input.dispatchEvent(new Event('change'));
      });
  });
}
function filterRates(rates){const hotel=normFilter($('r-hotel')?.value);const room=normFilter($('r-room')?.value);const board=$('r-board')?.value||'';const cancellation=$('r-cancellation')?.value||'';const supplier=$('r-supplier')?.value||'';const min=Number($('r-min')?.value||0);const max=Number($('r-max')?.value||0);return rates.filter(r=>(!hotel||normFilter(r.hotel).includes(hotel))&&(!room||normFilter(r.room).includes(room))&&(!board||r.board===board)&&(!cancellation||r.cancellation===cancellation)&&(!supplier||r.supplier===supplier)&&(!min||(r.price!=null&&Number(r.price)>=min))&&(!max||(r.price!=null&&Number(r.price)<=max)));}
function normFilter(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function fillFilterOptions(rates){const boardSel=$('r-board'),cancelSel=$('r-cancellation'),supplierSel=$('r-supplier');if(!boardSel||!cancelSel||!supplierSel)return;const set=(sel,values)=>{const current=sel.value;sel.innerHTML='<option value="">All</option>'+[...new Set(values.filter(Boolean))].sort().map(v=>`<option value="${String(v).replace(/"/g,'&quot;')}">${v}</option>`).join('');if([...sel.options].some(o=>o.value===current))sel.value=current};set(boardSel,rates.map(r=>r.board));set(cancelSel,rates.map(r=>r.cancellation));set(supplierSel,rates.map(r=>r.supplier));}
function hotelGroupKey(value){
  return String(value||'')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/&/g,' and ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\bhotel\b/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function isDisplayableHotelRate(r){
  if(!r || typeof r!=='object')return false;

  const hotel=String(r.hotel||'').trim();
  const room=String(r.room||'').trim();
  const raw=String(
    r?.raw?.text ??
    r?.raw?.rawText ??
    r?.raw_text ??
    r?.rawText ??
    ''
  );

  if(!hotel)return false;

  const hotelLower=hotel.toLowerCase();
  const roomLower=room.toLowerCase();
  const rawLower=raw.toLowerCase();

  // Obvious RezLive UI/marketing rows, not real hotel offers.
  const obviousBadHotels=new Set([
    'rate starting from',
    'more details',
    'smart ai insights',
    'smart insights',
    'easily compare in a single view',
    'property description',
    'room details'
  ]);

  if(obviousBadHotels.has(hotelLower)){
    return false;
  }

  // "Suite" was observed as a contaminated hotel row where the room
  // contained RezLive page marketing text. Do not remove normal Suite
  // hotel names unless this contamination is also present.
  if(
    hotelLower==='suite' &&
    (
      roomLower==='easily compare in a single view.' ||
      roomLower==='easily compare in a single view' ||
      /smart ai insights|smart insights|easily compare in a single view|ref_chip_rooms|property description/i.test(rawLower)
    )
  ){
    return false;
  }

  return true;
}
function cleanLocandaField(value){
  const x = String(value ?? '').trim();

  // Locanda hotel-list rows do not contain room/rate details yet.
  // Treat encoding artifacts and control characters as empty fields.
  if (
    !x ||
    /[\\u00c3\\u00e2]/.test(x) ||
    /[\\u0080-\\u009f]/.test(x) ||
    /\\uFFFD/.test(x)
  ) {
    return '';
  }

  return x;
}

async function loadAedUsdRate(){
  try{
    const response = await fetch(
      'https://open.er-api.com/v6/latest/AED',
      {cache:'no-store'}
    );

    if(!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const rate = Number(data?.rates?.USD);

    if(Number.isFinite(rate) && rate > 0){
      window.__aedUsdRate = rate;
      console.log('AED/USD RATE:', rate);
      return rate;
    }
  }catch(error){
    console.warn('AED/USD RATE LOAD FAILED:', error?.message || error);
  }

  return null;
}

const aedUsdRatePromise = loadAedUsdRate();

async function waitForAedUsdRate(){
  if(Number.isFinite(window.__aedUsdRate)){
    return window.__aedUsdRate;
  }

  try{
    const rate = await Promise.race([
      aedUsdRatePromise,
      new Promise(resolve => setTimeout(() => resolve(null), 5000))
    ]);

    return Number.isFinite(window.__aedUsdRate)
      ? window.__aedUsdRate
      : rate;
  }catch(error){
    console.warn('AED/USD RATE WAIT FAILED:', error?.message || error);
    return null;
  }
}
function renderResults(results,statuses){
  renderSupplierStatus(statuses);

  const box=$('live-results');
  if(!box)return;

  box.innerHTML='';

  const rates=(Array.isArray(results)?results:[])
    .filter(isDisplayableHotelRate)
    .map(r=>({
      ...r,
      hotel:String(r.hotel||'').trim(),
      room:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) ? '' : String(r.room||'').trim(),
      category:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) ? '' : cleanLocandaField(
        r.category ??
        r.hotel_category ??
        r.hotelCategory ??
        r.star_rating ??
        r.stars ??
        ''
      ),
      view:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) && String(r.availability||'').trim()
        ? String(r.availability).trim()
        : String(r.view||'').trim(),
      board:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) ? '' : String(r.board||'').trim(),
      cancellation:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) ? '' : String(r.cancellation||'').trim(),
      availability:String(r.availability||'Available').trim(),
      supplier:String(r.supplier||r.source||r.source_name||'Supplier').trim(),
      currency:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) ? 'USD' : String(r.currency||'AED').trim(),
      price:/locanda/i.test(String(r.supplier||r.source||r.source_name||'')) && (r.price==null || r.price==='' || Number(r.price)===0) ? null : (r.price==null||r.price===''?null:Number(r.price))
    }));

  const count=document.createElement('div');
  count.className='results-count';
  box.appendChild(count);

  if(!rates.length){
    count.textContent='No live hotel rates returned';

    const p=document.createElement('p');
    p.className='hint';
    p.textContent='No live supplier hotel rates were returned.';
    box.appendChild(p);
    return;
  }

  const filters=document.createElement('div');
  filters.className='result-filters';

  filters.innerHTML=
    '<strong>Filter results</strong>' +
    '<div class="result-filter-grid">' +
      '<label>Hotel<input id="r-hotel" placeholder="Hotel name"></label>' +
      '<label>Room<input id="r-room" placeholder="Room category"></label>' +
      '<label>Board<select id="r-board"><option value="">All</option></select></label>' +
      '<label>Cancellation<select id="r-cancellation"><option value="">All</option></select></label>' +
      '<label>Supplier<select id="r-supplier"><option value="">All</option></select></label>' +
      '<label>Min Price<input id="r-min" type="number" min="0" step="0.01" placeholder="0"></label>' +
      '<label>Max Price<input id="r-max" type="number" min="0" step="0.01" placeholder="No limit"></label>' +
      '<button type="button" id="r-clear">Clear</button>' +
    '</div>';

  box.appendChild(filters);

  fillFilterOptions(rates);

  const renderTable=()=>{
    const filtered=filterRates(rates);

    const priced=filtered.filter(
      r=>r.price!=null&&Number.isFinite(Number(r.price))&&Number(r.price)>0
    ).length;

    count.textContent=`${filtered.length} live rates • ${priced} priced`;

    const old=box.querySelector('.rate-table-wrap');
    if(old)old.remove();

    /*
     * Group offers by normalized hotel name.
     * This keeps Hadaf / RezLive / other suppliers together
     * when they refer to the same hotel.
     */
    const groups=new Map();

    filtered.forEach(r=>{
      const key=hotelGroupKey(r.hotel);

      if(!key)return;

      if(!groups.has(key)){
        groups.set(key,{
          hotel:r.hotel,
          offers:[]
        });
      }

      groups.get(key).offers.push(r);
    });

    /*
     * Sort every hotel group by its cheapest available rate.
     * Then sort the offers inside each hotel from cheapest to highest.
     */
    const hotelGroups=[...groups.values()]
      .map(group=>{
        group.offers.sort((a,b)=>{
          const ap=a.price==null?Infinity:Number(a.price);
          const bp=b.price==null?Infinity:Number(b.price);
          return ap-bp;
        });

        group.cheapest=group.offers.reduce((min,r)=>{
          const p=r.price==null?Infinity:Number(r.price);
          return p<min?p:min;
        },Infinity);

        return group;
      })
      .sort((a,b)=>a.cheapest-b.cheapest);

    const wrap=document.createElement('div');
    wrap.className='rate-table-wrap';
    wrap.style.overflowX='auto';

    const table=document.createElement('table');
    table.className='rate-results-table';

    const thead=document.createElement('thead');
    const hrow=document.createElement('tr');

    [
      'Hotel',
      'Room',
      'Category',
      'View',
      'Board',
      'Cancellation',
      'Price',
      'Availability',
      'Supplier'
    ].forEach(h=>{
      const th=document.createElement('th');
      th.textContent=h;
      hrow.appendChild(th);
    });

    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody=document.createElement('tbody');

    hotelGroups.forEach(group=>{
      group.offers.forEach((r,index)=>{
        const tr=document.createElement('tr');

        /*
         * Visually identify the cheapest supplier for each hotel.
         */
        if(index===0){
          tr.className='best-hotel-rate';
        }

        addCell(tr,r.hotel,index===0?'hotel-group-name':'');
        if(/rezlive/i.test(String(r.supplier || r.source || ""))){
          addCell(tr,'—');
          addCell(tr,'—');
        }else{
          addCell(tr,/locanda/i.test(String(r.supplier || r.source || "")) ? "" : r.room);
          addCell(tr,/locanda/i.test(String(r.supplier || r.source || "")) ? "" : r.category);
        }
        /*
         * REZLIVE_DETAILS_UI_V1
         *
         * RezLive returns hotel room/rate details through its
         * hotelviewmore endpoint. The search itself remains unchanged.
         */
        const rezDetails =
          r.raw &&
          r.raw.rezliveDetailsMeta
            ? r.raw.rezliveDetailsMeta
            : null;

        if(
          /rezlive/i.test(String(r.supplier || r.source || "")) &&
          rezDetails &&
          rezDetails.hotelId &&
          rezDetails.roomId &&
          rezDetails.filepostfix
        ){
          const td=document.createElement('td');
          const a=document.createElement('a');

          a.href='#';
          a.textContent='View Rates';
          a.className='hotel-view-link';

          a.addEventListener('click',async(ev)=>{
            ev.preventDefault();

            a.textContent='Loading...';
            a.style.pointerEvents='none';

            try{
              const response=await fetch('/api/rezlive/details',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                credentials:'same-origin',
                body:JSON.stringify({
                  hotelId:rezDetails.hotelId,
                  roomId:rezDetails.roomId,
                  filepostfix:rezDetails.filepostfix
                })
              });

              const payload=await response.json();

              if(!response.ok||!payload.ok){
                throw new Error(
                  payload.error||'Unable to load RezLive hotel details'
                );
              }

              const overlay=document.createElement('div');

              overlay.style.cssText=[
                'position:fixed',
                'inset:0',
                'background:rgba(0,0,0,.55)',
                'z-index:99999',
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'padding:24px'
              ].join(';');

              const modal=document.createElement('div');

              modal.style.cssText=[
                'background:#fff',
                'border-radius:10px',
                'width:min(1050px,96vw)',
                'max-height:90vh',
                'overflow:auto',
                'padding:24px',
                'box-shadow:0 20px 60px rgba(0,0,0,.3)'
              ].join(';');

              const header=document.createElement('div');

              header.style.cssText=[
                'display:flex',
                'justify-content:space-between',
                'align-items:center',
                'gap:16px',
                'margin-bottom:18px'
              ].join(';');

              const title=document.createElement('h3');
              title.textContent=
                String(r.hotel||'RezLive Hotel Details');
              title.style.margin='0';

              const close=document.createElement('button');
              close.type='button';
              close.textContent='Close';
              close.style.cssText=[
                'border:0',
                'background:#eee',
                'padding:8px 14px',
                'border-radius:6px',
                'cursor:pointer'
              ].join(';');

              close.addEventListener('click',()=>{
                overlay.remove();
              });

              header.appendChild(title);
              header.appendChild(close);
              modal.appendChild(header);

              const rates=Array.isArray(payload.rates)
                ? payload.rates
                : [];

              if(!rates.length){
                const empty=document.createElement('div');
                empty.textContent='No room rates were returned by RezLive.';
                empty.style.padding='20px 0';
                modal.appendChild(empty);
              }else{
                const table=document.createElement('table');

                table.style.cssText=[
                  'width:100%',
                  'border-collapse:collapse',
                  'font-size:14px'
                ].join(';');

                const thead=document.createElement('thead');
                const headRow=document.createElement('tr');

                [
                  'Room',
                  'Inclusion',
                  'Board',
                  'Per Room Rate',
                  'Total',
                  'Cancellation'
                ].forEach(label=>{
                  const th=document.createElement('th');
                  th.textContent=label;
                  th.style.cssText=[
                    'text-align:left',
                    'padding:10px',
                    'border-bottom:2px solid #ddd',
                    'white-space:nowrap'
                  ].join(';');
                  headRow.appendChild(th);
                });

                thead.appendChild(headRow);
                table.appendChild(thead);

                const tbody=document.createElement('tbody');

                rates.forEach(rate=>{
                  const row=document.createElement('tr');

                  [
                    rate.room||'—',
                    rate.inclusion||'—',
                    rate.board||'—',
                    rate.perRoomRate||'—',
                    rate.total||'—'
                  ].forEach(value=>{
                    const cell=document.createElement('td');
                    cell.textContent=String(value);
                    cell.style.cssText=[
                      'padding:10px',
                      'border-bottom:1px solid #eee',
                      'vertical-align:top'
                    ].join(';');
                    row.appendChild(cell);
                  });

                  const cancelCell=document.createElement('td');
                  cancelCell.style.cssText=[
                    'padding:10px',
                    'border-bottom:1px solid #eee',
                    'vertical-align:top'
                  ].join(';');

                  if(rate.cancellationArgs){
                    const cancelLink=document.createElement('a');
                    cancelLink.href='#';
                    cancelLink.textContent='Cancellation Policy';
                    cancelLink.style.cursor='pointer';

                    cancelLink.addEventListener('click',async(cancelEvent)=>{
                      cancelEvent.preventDefault();

                      cancelLink.textContent='Loading...';

                      try{
                        const args=String(
                          rate.cancellationArgs||''
                        );

                        const parts=args
                          .split(',')
                          .map(x=>x.trim())
                          .map(x=>x.replace(/^['"]|['"]$/g,''));

                        const policyId=parts[0]||'';
                        const roomIndex=parts[1]||'0';

                        const policyResponse=await fetch(
                          '/api/rezlive/cancellation-policy',
                          {
                            method:'POST',
                            headers:{
                              'Content-Type':'application/json'
                            },
                            credentials:'same-origin',
                            body:JSON.stringify({
                              policyId,
                              roomId:roomIndex,
                              searchId:rezDetails.filepostfix
                            })
                          }
                        );

                        const policyPayload=
                          await policyResponse.json();

                        if(
                          !policyResponse.ok ||
                          !policyPayload.ok
                        ){
                          throw new Error(
                            policyPayload.error||
                            'Cancellation policy unavailable'
                          );
                        }

                        const policyOverlay=
                          document.createElement('div');

                        policyOverlay.style.cssText=[
                          'position:fixed',
                          'inset:0',
                          'background:rgba(0,0,0,.55)',
                          'z-index:100000',
                          'display:flex',
                          'align-items:center',
                          'justify-content:center',
                          'padding:24px'
                        ].join(';');

                        const policyModal=
                          document.createElement('div');

                        policyModal.style.cssText=[
                          'background:#fff',
                          'border-radius:10px',
                          'width:min(750px,94vw)',
                          'max-height:80vh',
                          'overflow:auto',
                          'padding:24px',
                          'box-shadow:0 20px 60px rgba(0,0,0,.3)'
                        ].join(';');

                        const policyTitle=
                          document.createElement('h3');

                        policyTitle.textContent=
                          'Cancellation Policy';

                        const policyBody=
                          document.createElement('div');

                        policyBody.innerHTML=
                          policyPayload.html||
                          '<p>No cancellation policy details were returned.</p>';

                        const policyClose=
                          document.createElement('button');

                        policyClose.type='button';
                        policyClose.textContent='Close';
                        policyClose.style.cssText=[
                          'margin-top:18px',
                          'border:0',
                          'background:#eee',
                          'padding:8px 14px',
                          'border-radius:6px',
                          'cursor:pointer'
                        ].join(';');

                        policyClose.addEventListener(
                          'click',
                          ()=>{
                            policyOverlay.remove();
                          }
                        );

                        policyModal.appendChild(policyTitle);
                        policyModal.appendChild(policyBody);
                        policyModal.appendChild(policyClose);
                        policyOverlay.appendChild(policyModal);
                        document.body.appendChild(policyOverlay);

                      }catch(policyError){
                        alert(
                          'Cancellation policy could not be loaded: '+
                          String(
                            policyError&&policyError.message||
                            policyError
                          )
                        );
                      }finally{
                        cancelLink.textContent='Cancellation Policy';
                      }
                    });

                    cancelCell.appendChild(cancelLink);
                  }else{
                    cancelCell.textContent='—';
                  }

                  row.appendChild(cancelCell);
                  tbody.appendChild(row);
                });

                table.appendChild(tbody);
                modal.appendChild(table);
              }

              overlay.appendChild(modal);

              overlay.addEventListener('click',ev=>{
                if(ev.target===overlay){
                  overlay.remove();
                }
              });

              document.body.appendChild(overlay);

            }catch(error){
              alert(
                'RezLive hotel details could not be loaded: '+
                String(error&&error.message||error)
              );
            }finally{
              a.textContent='View Rates';
              a.style.pointerEvents='';
            }
          });

          td.appendChild(a);
          tr.appendChild(td);

        }else if(
  /wanderbeds/i.test(String(r.supplier || r.source || "")) &&
  /^https?:\/\/[^/]*wanderbeds\.com\/book\/1\/hoteldetails\//i.test(String(r.view || r.url || ""))
){
  const td=document.createElement('td');
  const a=document.createElement('a');

  a.href='#';
  a.textContent='View Rates';
  a.className='hotel-view-link';

  a.addEventListener('click',async(ev)=>{
    ev.preventDefault();

    const hotelName=String(r.hotel||'').trim();
    const detailUrl=String(r.view||r.url||'').trim();

    a.textContent='Loading...';
    a.style.pointerEvents='none';

    try{
      const response=await fetch('/api/wanderbeds/rates',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        body:JSON.stringify({
          url:detailUrl,
          hotel:hotelName
        })
      });

      const payload=await response.json();

      if(!response.ok||!payload.ok){
        throw new Error(
          payload.error||'Unable to load WanderBeds rates'
        );
      }

      const overlay=document.createElement('div');

      overlay.style.cssText=[
        'position:fixed',
        'inset:0',
        'background:rgba(0,0,0,.55)',
        'z-index:99999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px'
      ].join(';');

      const modal=document.createElement('div');

      modal.style.cssText=[
        'background:#fff',
        'border-radius:10px',
        'width:min(900px,95vw)',
        'max-height:90vh',
        'overflow:auto',
        'padding:24px',
        'box-shadow:0 20px 60px rgba(0,0,0,.3)'
      ].join(';');

      const close=document.createElement('button');
      close.type='button';
      close.textContent='Close';
      close.style.cssText='float:right;padding:7px 14px;cursor:pointer';

      close.addEventListener('click',()=>{
        overlay.remove();
      });

      const title=document.createElement('h2');
      title.textContent=hotelName||'WanderBeds Rates';

      modal.appendChild(close);
      modal.appendChild(title);

      if(!Array.isArray(payload.rates)||!payload.rates.length){
        const empty=document.createElement('p');
        empty.textContent='No priced rates were returned by WanderBeds.';
        modal.appendChild(empty);
      }else{
        payload.rates.forEach((rate)=>{
          const card=document.createElement('div');

          card.style.cssText=[
            'border:1px solid #ddd',
            'border-radius:8px',
            'padding:14px',
            'margin:12px 0'
          ].join(';');

          const room=document.createElement('div');
          room.style.fontWeight='600';
          room.textContent=rate.room||'Room';

          const meal=document.createElement('div');
          meal.textContent=rate.meal
            ?'Meal: '+rate.meal
            :'Meal: Not specified';

          const cancellation=document.createElement('div');
          cancellation.textContent=rate.cancellation
            ?'Cancellation: '+rate.cancellation
            :'Cancellation: Not specified';

          const deadline=document.createElement('div');
          deadline.textContent=rate.deadline
            ?'Deadline: '+rate.deadline
            :'';

          const nightly=document.createElement('div');
          nightly.style.fontWeight='600';
          nightly.textContent=
            'USD '+Number(rate.price||0).toFixed(2)+' / night';

          const total=document.createElement('div');

          if(rate.total_price!=null){
            total.textContent=
              'USD '+Number(rate.total_price).toLocaleString(
                undefined,
                {
                  minimumFractionDigits:2,
                  maximumFractionDigits:2
                }
              )+
              ' total'+
              (rate.nights
                ?' Â· '+rate.nights+' nights'
                :'');
          }

          card.appendChild(room);
          card.appendChild(meal);
          card.appendChild(cancellation);

          if(rate.deadline){
            card.appendChild(deadline);
          }

          card.appendChild(nightly);

          if(rate.total_price!=null){
            card.appendChild(total);
          }

          modal.appendChild(card);
        });
      }

      overlay.appendChild(modal);

      overlay.addEventListener('click',(ev)=>{
        if(ev.target===overlay){
          overlay.remove();
        }
      });

      document.body.appendChild(overlay);

    }catch(error){
      alert(
        'WanderBeds rates could not be loaded: '+
        String(error&&error.message||error)
      );
    }finally{
      a.textContent='View Rates';
      a.style.pointerEvents='';
    }
  });

  td.appendChild(a);
  tr.appendChild(td);

}else{
  const viewValue=String(r.view||r.url||'').trim();

if(
  /locanda/i.test(String(r.supplier||r.source||'')) &&
  /^https?:\/\/app\.locandahub\.com\/agent\/booking\/availability\.php\?/i.test(viewValue)
){
  const td=document.createElement('td');
  const a=document.createElement('a');

  a.href='#';
  a.textContent='View Rates';
  a.className='hotel-view-link';

  a.addEventListener('click',async(ev)=>{
    ev.preventDefault();

    const hotelName=String(r.hotel||'').trim();
    const detailUrl=String(r.view||r.url||'').trim();

    a.textContent='Loading...';
    a.style.pointerEvents='none';

    try{
      const response=await fetch('/api/locanda/rates',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        body:JSON.stringify({
          url:detailUrl,
          hotel:hotelName
        })
      });

      const payload=await response.json();

      if(!response.ok||!payload.ok){
        throw new Error(
          payload.error||'Unable to load Locanda rates'
        );
      }

      const overlay=document.createElement('div');

      overlay.style.cssText=[
        'position:fixed',
        'inset:0',
        'background:rgba(0,0,0,.55)',
        'z-index:99999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px'
      ].join(';');

      const modal=document.createElement('div');

      modal.style.cssText=[
        'background:#fff',
        'border-radius:10px',
        'width:min(900px,95vw)',
        'max-height:90vh',
        'overflow:auto',
        'padding:24px',
        'box-shadow:0 20px 60px rgba(0,0,0,.3)'
      ].join(';');

      const close=document.createElement('button');
      close.type='button';
      close.textContent='Close';
      close.style.cssText='float:right;padding:7px 14px;cursor:pointer';

      close.addEventListener('click',()=>{
        overlay.remove();
      });

      const title=document.createElement('h2');
      title.textContent=hotelName||'Locanda Rates';

      modal.appendChild(close);
      modal.appendChild(title);

      if(!Array.isArray(payload.rates)||!payload.rates.length){
        const empty=document.createElement('p');
        empty.textContent='No Locanda rates were found.';
        modal.appendChild(empty);
      }else{
        payload.rates.forEach(rate=>{
          const card=document.createElement('div');

          card.style.cssText=[
            'border:1px solid #ddd',
            'border-radius:8px',
            'padding:14px',
            'margin:10px 0'
          ].join(';');

          const room=document.createElement('div');
          room.textContent='Room: '+String(rate.room||'');

          const meal=document.createElement('div');
          meal.textContent='Meal: '+String(rate.meal||'');

          const cancellation=document.createElement('div');
          cancellation.textContent='Cancellation: '+String(rate.cancellation||'');

          const price=document.createElement('div');
          price.textContent=
            'Price: '+
            String(rate.amount||'')+
            ' '+
            String(rate.currency||'');

          price.style.fontWeight='700';

          card.appendChild(room);
          card.appendChild(meal);
          card.appendChild(cancellation);
          card.appendChild(price);

          modal.appendChild(card);
        });
      }

      overlay.appendChild(modal);

      overlay.addEventListener('click',(ev)=>{
        if(ev.target===overlay){
          overlay.remove();
        }
      });

      document.body.appendChild(overlay);

    }catch(error){
      alert(
        'Locanda rates could not be loaded: '+
        String(error&&error.message||error)
      );
    }finally{
      a.textContent='View Rates';
      a.style.pointerEvents='';
    }
  });

  td.appendChild(a);
  tr.appendChild(td);

}else if(
  /wanderbeds/i.test(String(r.supplier||r.source||'')) &&
  /^https?:\/\/(?:www\.)?wanderbeds\.com\/book\/\d+\/hoteldetails\//i.test(viewValue)
){
  const td=document.createElement('td');
  const a=document.createElement('a');

  a.href='#';
  a.textContent='View Rates';
  a.className='hotel-view-link';

  a.addEventListener('click',async(ev)=>{
    ev.preventDefault();

    const hotelName=String(r.hotel||'').trim();
    const detailUrl=String(r.view||r.url||'').trim();

    a.textContent='Loading...';
    a.style.pointerEvents='none';

    try{
      const response=await fetch('/api/wanderbeds/rates',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        body:JSON.stringify({
          url:detailUrl,
          hotel:hotelName
        })
      });

      const payload=await response.json();

      if(!response.ok||!payload.ok){
        throw new Error(
          payload.error||'Unable to load WanderBeds rates'
        );
      }

      const overlay=document.createElement('div');

      overlay.style.cssText=[
        'position:fixed',
        'inset:0',
        'background:rgba(0,0,0,.55)',
        'z-index:99999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px'
      ].join(';');

      const modal=document.createElement('div');

      modal.style.cssText=[
        'background:#fff',
        'border-radius:10px',
        'width:min(900px,95vw)',
        'max-height:90vh',
        'overflow:auto',
        'padding:24px',
        'box-shadow:0 20px 60px rgba(0,0,0,.3)'
      ].join(';');

      const close=document.createElement('button');
      close.type='button';
      close.textContent='Close';
      close.style.cssText='float:right;padding:7px 14px;cursor:pointer';

      close.addEventListener('click',()=>{
        overlay.remove();
      });

      const title=document.createElement('h2');
      title.textContent=hotelName||'WanderBeds Rates';

      modal.appendChild(close);
      modal.appendChild(title);

      if(!Array.isArray(payload.rates)||!payload.rates.length){
        const empty=document.createElement('p');
        empty.textContent='No priced rates were returned by WanderBeds.';
        modal.appendChild(empty);
      }else{
        payload.rates.forEach((rate)=>{
          const card=document.createElement('div');

          card.style.cssText=[
            'border:1px solid #ddd',
            'border-radius:8px',
            'padding:14px',
            'margin:12px 0'
          ].join(';');

          const room=document.createElement('div');
          room.style.fontWeight='600';
          room.textContent=rate.room||'Room';

          const meal=document.createElement('div');
          meal.textContent=rate.meal
            ?'Meal: '+rate.meal
            :'Meal: Not specified';

          const cancellation=document.createElement('div');
          cancellation.textContent=rate.cancellation
            ?'Cancellation: '+rate.cancellation
            :'Cancellation: Not specified';

          const deadline=document.createElement('div');
          deadline.textContent=rate.deadline
            ?'Deadline: '+rate.deadline
            :'';

          const nightly=document.createElement('div');
          nightly.style.fontWeight='600';
          nightly.textContent=
            'USD '+Number(rate.price||0).toFixed(2)+' / night';

          const total=document.createElement('div');

          if(rate.total_price!=null){
            total.textContent=
              'USD '+Number(rate.total_price).toLocaleString(
                undefined,
                {
                  minimumFractionDigits:2,
                  maximumFractionDigits:2
                }
              )+
              ' total'+
              (rate.nights
                ?' Â· '+rate.nights+' nights'
                :'');
          }

          card.appendChild(room);
          card.appendChild(meal);
          card.appendChild(cancellation);

          if(rate.deadline){
            card.appendChild(deadline);
          }

          card.appendChild(nightly);

          if(rate.total_price!=null){
            card.appendChild(total);
          }

          modal.appendChild(card);
        });
      }

      overlay.appendChild(modal);

      overlay.addEventListener('click',(ev)=>{
        if(ev.target===overlay){
          overlay.remove();
        }
      });

      document.body.appendChild(overlay);

    }catch(error){
      alert(
        'WanderBeds rates could not be loaded: '+
        String(error&&error.message||error)
      );
    }finally{
      a.textContent='View Rates';
      a.style.pointerEvents='';
    }
  });

  td.appendChild(a);
  tr.appendChild(td);

}else{
  addCell(tr,r.view);
}
}
        addCell(tr,/locanda/i.test(String(r.supplier || r.source || "")) ? "" : r.board);
        addCell(tr,/locanda/i.test(String(r.supplier || r.source || "")) ? "" : r.cancellation);
        const numericPrice =
          r.price==null || !Number.isFinite(Number(r.price))
            ? null
            : Number(r.price);

        const currencyCode = String(r.currency||'AED').trim().toUpperCase();

        let priceText = '—';

        if(numericPrice != null){
          const baseText = `${currencyCode} ${numericPrice.toFixed(2)}`;

          if(currencyCode === 'AED' && Number.isFinite(window.__aedUsdRate)){
            const usdPrice = numericPrice * window.__aedUsdRate;
            priceText = `${baseText} / USD ${usdPrice.toFixed(2)}`;
          }else{
            priceText = baseText;
          }
        }

        addCell(
          tr,
          priceText,
          index===0?'price-cell best-price':'price-cell'
        );

        if(/locanda/i.test(String(r.supplier || r.source || "")) && String(r.availability || "").includes("locandahub.com/agent/booking/availability.php")){
          const td=document.createElement('td');
          const a=document.createElement('a');

          a.href='#';
          a.textContent='Show Rooms';
          a.className='hotel-view-link';

          a.addEventListener('click',(ev)=>{
            ev.preventDefault();

            const existingViewLink=tr.querySelector('.hotel-view-link');

            if(existingViewLink && existingViewLink!==a){
              existingViewLink.click();
            }else{
              alert('Locanda rates link is not ready.');
            }
          });

          td.appendChild(a);
          tr.appendChild(td);
        }else{
          addCell(tr,r.availability);
        }

        const supplierText=
          index===0
            ? `${r.supplier} • BEST PRICE`
            : r.supplier;

        addCell(
          tr,
          supplierText,
          index===0?'supplier-cell best-supplier':'supplier-cell'
        );

        tbody.appendChild(tr);
      });

      /*
       * Add a subtle separator after every hotel group.
       */
      const separator=document.createElement('tr');
      separator.className='hotel-group-separator';

      const separatorCell=document.createElement('td');
      separatorCell.colSpan=9;
      separatorCell.textContent='';
      separator.appendChild(separatorCell);

      tbody.appendChild(separator);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
  };

  [
    'r-hotel',
    'r-room',
    'r-board',
    'r-cancellation',
    'r-supplier',
    'r-min',
    'r-max'
  ].forEach(id=>{
    $(id)?.addEventListener('input',renderTable);
    $(id)?.addEventListener('change',renderTable);
  });

  $('r-clear')?.addEventListener('click',()=>{
    ['r-hotel','r-room','r-min','r-max'].forEach(id=>{
      if($(id))$(id).value='';
    });

    ['r-board','r-cancellation','r-supplier'].forEach(id=>{
      if($(id))$(id).value='';
    });

    renderTable();
  });

  renderTable();
}
function dateParts(v){
  const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? {y:Number(m[1]),m:Number(m[2]),d:Number(m[3])} : null;
}

function daysBetweenDates(from,to){
  const a=dateParts(from),b=dateParts(to);
  if(!a||!b)return 0;

  const daysBeforeMonth=[0,31,59,90,120,151,181,212,243,273,304,334];

  function serial(p){
    let y=p.y-1;
    let leapDays=Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400);
    let days=365*y+leapDays+daysBeforeMonth[p.m-1]+p.d-1;

    if(p.m>2 && (p.y%4===0 && (p.y%100!==0 || p.y%400===0))){
      days++;
    }

    return days;
  }

  return serial(b)-serial(a);
}

function addDaysToDate(value,days){
  const p=dateParts(value);
  if(!p)return '';

  let y=p.y;
  let m=p.m;
  let d=p.d+Number(days||0);

  while(true){
    const leap=(y%4===0 && (y%100!==0 || y%400===0));
    const monthDays=[
      31,
      leap?29:28,
      31,30,31,30,31,31,30,31,30,31
    ][m-1];

    if(d<=monthDays)break;

    d-=monthDays;
    m++;

    if(m>12){
      m=1;
      y++;
    }
  }

  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function syncNights(){
  const ci=$('s-checkin').value;
  const co=$('s-checkout').value;

  if(ci&&co){
    const n=daysBetweenDates(ci,co);
    if(n>0)$('s-nights').value=n;
  }
}

function syncCheckout(){
  const ci=$('s-checkin').value;
  const n=Number($('s-nights').value||1);

  if(ci&&n>0){
    $('s-checkout').value=addDaysToDate(ci,n);
  }
}

$('s-checkin').addEventListener('change',syncCheckout);
$('s-nights').addEventListener('input',syncCheckout);
$('s-checkout').addEventListener('change',syncNights);
$('search-form').addEventListener('submit',async e=>{e.preventDefault();syncNights();const supplierIds=getSelectedSupplierIds();if(!supplierIds.length){$('supplier-status').innerHTML='<p class="error">Select at least one supplier.</p>';return;}const button=e.target.querySelector('button[type="submit"]');button.disabled=true;button.textContent='Searching…';show('results-section');$('search-summary').textContent=`${$('s-destination').value} Ã¢â‚¬Â¢ ${$('s-checkin').value} to ${$('s-checkout').value} Ã¢â‚¬Â¢ ${$('s-adults').value} adults Ã¢â‚¬Â¢ ${$('s-children').value} children Ã¢â‚¬Â¢ ${$('s-rooms').value} room${Number($('s-rooms').value)===1?'':'s'}`;$('supplier-status').innerHTML='<div class="searching-status">Searching live suppliers…</div>';$('live-results').innerHTML='<p class="hint">Waiting for live supplier rates…</p>';try{const d=await api('/api/search',{method:'POST',body:JSON.stringify({destination:$('s-destination').value.trim(),destinationCountry:$('s-destination-country').value.trim(),checkin:$('s-checkin').value,checkout:$('s-checkout').value,guests:Number($('s-adults').value),rooms:Number($('s-rooms').value),board:'ROOM_ONLY',country:$('s-country').value,nights:Number($('s-nights').value),children:Number($('s-children').value),hotelName:$('s-hotel').value.trim(),supplierIds:getSelectedSupplierIds()})});currentSearchId=d.searchId;await waitForAedUsdRate();renderResults(d.results,d.connectorStatuses)}catch(err){$('supplier-status').innerHTML='';$('live-results').innerHTML=`<p class="error">${err.message}</p>`}finally{button.disabled=false;button.textContent='Search Hotels'}});
(async()=>{try{const me=await api('/api/auth/me');$('who').textContent=me.username;hide('login-view');show('app-view');applyRole(me.role);await loadSources();loadSupplierHealth()}catch{}})();









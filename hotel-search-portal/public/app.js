function renderResults(results,statuses){
  renderSupplierStatus(statuses);
  const box=$('live-results');
  if(!box)return;
  box.innerHTML='';

  const rates=Array.isArray(results)?results:[];

  const count=document.createElement('div');
  count.className='results-count';
  count.textContent=rates.length
    ? `${rates.length} live rate${rates.length===1?'':'s'} found`
    : 'No live rates returned';
  box.appendChild(count);

  if(!rates.length){
    const p=document.createElement('p');
    p.className='hint';
    p.textContent='No live hotel rates returned. Configure API or Browser / B2B Portal sources in Manage Sources.';
    box.appendChild(p);
    return;
  }

  rates.sort((a,b)=>
    (Number.isFinite(a.price)?a.price:Infinity)-
    (Number.isFinite(b.price)?b.price:Infinity)
  );

  const table=document.createElement('table');
  table.className='rates-table';

  table.innerHTML=`
    <thead>
      <tr>
        <th>Hotel</th>
        <th>Room</th>
        <th>View</th>
        <th>Board</th>
        <th>Cancellation</th>
        <th>Price</th>
        <th>Availability</th>
        <th>Supplier</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody=table.querySelector('tbody');

  rates.forEach(r=>{
    const tr=document.createElement('tr');

    const price=
      Number.isFinite(r.price)&&r.price>0
        ? `${r.currency||''} ${r.price.toFixed(2)}`
        : 'Price on supplier';

    tr.innerHTML=`
      <td>${r.hotel||'Hotel'}</td>
      <td>${r.room||'—'}</td>
      <td>${r.view||'—'}</td>
      <td>${r.board||'—'}</td>
      <td>${r.cancellation||'—'}</td>
      <td><strong>${price}</strong></td>
      <td>${r.availability||'—'}</td>
      <td>${r.supplier||'—'}</td>
    `;

    tbody.appendChild(tr);
  });

  box.appendChild(table);
}

$('search-form').addEventListener('submit',async e=>{
  e.preventDefault();

  const button=e.target.querySelector('button[type="submit"]');
  button.disabled=true;
  button.textContent='Searching all sources...';

  show('results-section');

  $('search-summary').textContent=
    `Searching ${$('s-destination').value} • ${$('s-checkin').value} to ${$('s-checkout').value}`;

  $('supplier-status').innerHTML=
    '<div class="searching-status">Checking APIs + authenticated browser portals…</div>';

  $('live-results').innerHTML=
    '<p class="hint">Waiting for live responses…</p>';

  $('links-list').innerHTML='';

  try{
    const d=await api('/api/search',{
      method:'POST',
      body:JSON.stringify({
        destination:$('s-destination').value.trim(),
        checkin:$('s-checkin').value,
        checkout:$('s-checkout').value,
        guests:Number($('s-guests').value),
        rooms:Number($('s-rooms').value),
        board:$('s-board').value
      })
    });

    currentSearchId=d.searchId;

    $('search-summary').textContent=
      `${$('s-destination').value} • ${$('s-checkin').value} to ${$('s-checkout').value} • ${$('s-guests').value} guests • ${$('s-rooms').value} room${Number($('s-rooms').value)===1?'':'s'} • ${$('s-board').selectedOptions[0].text}`;

    renderResults(d.results,d.connectorStatuses);

    /*
      Read-only portal:
      Do not display external supplier links or booking actions.
    */
    $('links-list').innerHTML='';

  }catch(err){
    $('supplier-status').innerHTML='';
    $('live-results').innerHTML=
      `<p class="error">${err.message}</p>`;
  }finally{
    button.disabled=false;
    button.textContent='Search';
  }
});

(async()=>{
  try{
    const me=await api('/api/auth/me');
    $('who').textContent=me.username;
    hide('login-view');
    show('app-view');
    applyRole(me.role);
    loadSources();
  }catch{}
})();
const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/i;
function price(v) {
  const m = clean(v).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : NaN;
}
async function allFrames(page) { return page.frames(); }
async function visible(frame, selector) {
  try { const l = frame.locator(selector).first(); if (await l.count() && await l.isVisible()) return l; } catch {}
  return null;
}
async function find(page, selectors) {
  for (const frame of await allFrames(page)) for (const s of selectors.filter(Boolean)) {
    const l = await visible(frame, s); if (l) return l;
  }
  return null;
}
async function frameWith(page, selector) {
  for (const frame of await allFrames(page)) if (await frame.locator(selector).count().catch(() => 0)) return frame;
  return null;
}
async function inputCandidates(page) {
  const out = [];
  for (const frame of await allFrames(page)) {
    const els = frame.locator('input:visible,select:visible,textarea:visible');
    const n = await els.count().catch(() => 0);
    for (let i=0;i<n;i++) {
      const el=els.nth(i);
      const a=await Promise.all(['type','name','id','placeholder','value'].map(x=>el.getAttribute(x).catch(()=>'')));
      out.push({frame,el,meta:a.join(' ').toLowerCase()});
    }
  }
  return out;
}
async function ranked(page, purpose) {
  let best=null, score=0;
  for (const x of await inputCandidates(page)) {
    let s=0, m=x.meta;
    if (purpose==='destination') { if (/destination|city|zone|location|going to/.test(m)) s+=100; if (/hotel name|contains/.test(m)) s-=30; }
    if (purpose==='checkin') { if (/check.?in|arrival/.test(m)) s+=100; else if (/date/.test(m)) s+=10; }
    if (purpose==='checkout') { if (/check.?out|departure/.test(m)) s+=100; else if (/date/.test(m)) s+=10; }
    if (purpose==='guests') { if (/adult|guest|travell?er|pax/.test(m)) s+=80; }
    if (purpose==='rooms') { if (/room/.test(m)) s+=80; }
    if (s>score) { score=s; best=x.el; }
  }
  return best;
}
async function fill(page,purpose,value,selectors) {
  const el=await find(page,selectors)||await ranked(page,purpose);
  if(!el) return false;
  try { await el.fill(String(value)); await el.press('Tab').catch(()=>{}); return true; } catch { return false; }
}
async function blocked(page) {
  let body=''; for(const f of await allFrames(page)) body+=' '+clean(await f.locator('body').innerText().catch(()=>''));
  if(/captcha|verify you are human|access denied|unusual traffic|security check/i.test(body)) throw new Error('Supplier presented a security verification step; automated bypass is not supported');
}
async function login(page,source,password,cfg) {
  const started=Date.now(), waitMs=Number(cfg.login_frame_timeout_ms)||15000;
  let f=null; while(!f && Date.now()-started<waitMs){ f=await frameWith(page,'#tbUserName'); if(!f) await page.waitForTimeout(400); }
  if(!f) throw new Error('Hadaf login iframe could not be detected');
  const user=await visible(f,'#tbUserName'), pass=await visible(f,'#tbPassword'), terms=await visible(f,'#chkTermCondn'), btn=await visible(f,'#btnLogin1');
  if(!user||!pass||!btn) throw new Error('Hadaf login fields could not be detected');
  await user.fill(String(source.site_username||'')); await pass.fill(String(password||''));
  if(terms && !(await terms.isChecked().catch(()=>false))) await terms.check().catch(()=>{});
  await btn.click({timeout:10000}); await page.waitForTimeout(Number(cfg.post_login_wait_ms)||5000); await blocked(page);
}
async function searchPortal(page,s,cfg) {
  if(cfg.search_url_template){
    await page.goto(String(cfg.search_url_template).replaceAll('{destination}',encodeURIComponent(s.destination)).replaceAll('{checkin}',s.checkin).replaceAll('{checkout}',s.checkout).replaceAll('{guests}',String(s.guests)).replaceAll('{rooms}',String(s.rooms||1)),{waitUntil:'domcontentloaded',timeout:30000}); return;
  }
  if(!await fill(page,'destination',s.destination,[cfg.destination_selector,'#txtDestination','input[name*="destination" i]','input[id*="destination" i]'])) throw new Error('Hadaf destination field could not be detected');
  const ci=await fill(page,'checkin',s.checkin,[cfg.checkin_selector,'input[name*="checkin" i]','input[id*="checkin" i]','input[name*="arrival" i]','input[id*="arrival" i]']);
  const co=await fill(page,'checkout',s.checkout,[cfg.checkout_selector,'input[name*="checkout" i]','input[id*="checkout" i]','input[name*="departure" i]','input[id*="departure" i]']);
  if(!ci||!co) throw new Error('Hadaf check-in/check-out fields could not be detected');
  await fill(page,'guests',s.guests,[cfg.guests_selector,'select[name*="adult" i]','select[id*="adult" i]','input[name*="adult" i]','input[id*="adult" i]']);
  await fill(page,'rooms',s.rooms||1,[cfg.rooms_selector,'select[name*="room" i]','select[id*="room" i]','input[name*="room" i]','input[id*="room" i]']);
  const btn=await find(page,[cfg.search_button_selector,'#btnSearch','input[value*="search" i]','button:has-text("Search")','a:has-text("Search")','input[type="submit"]']);
  if(!btn) throw new Error('Hadaf search button could not be detected'); await btn.click({timeout:10000});
}
function parseRate(text, defaultCurrency='AED') {
  const t=clean(text), pm=t.match(PRICE_RE); if(!pm) return null;
  const p=price(pm[0]); if(!Number.isFinite(p)||p<=0)return null;
  const cur=(pm[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i)||[''])[0] || defaultCurrency;
  const board=(t.match(/Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i)||[''])[0];
  const cancel=(t.match(/Non[- ]?refundable|Free Cancellation|Refundable/i)||[''])[0];
  const avail=(t.match(/Available|On Request|Sold Out|Not Available/i)||[''])[0]||'Available';
  const room=(t.match(/(?:Triple|Twin|Double|Single|Quadruple|Family|Deluxe|Standard|Superior|King|Queen|Suite|Apartment|Villa)[^|]*?(?:Room|Suite|Bed|Only|Included)?/i)||[''])[0];
  return {price:p,currency:clean(cur),board:clean(board),cancellation:clean(cancel),availability:clean(avail),room:clean(room),raw:t};
}
async function extract(page,cfg) {
  const out=[];
  for(const frame of await allFrames(page)) {
    const items=await frame.locator('tr:visible').evaluateAll(rows=>rows.map((row,i)=>{
      const text=String(row.innerText||row.textContent||'').replace(/\s+/g,' ').trim();
      if(!PRICE_RE.test(text)) return null;
      let hotel=''; let node=row;
      for(let d=0;node&&d<10;d++,node=node.parentElement){
        const pool=[];
        for(const e of node.querySelectorAll('h1,h2,h3,h4,h5,h6,.hotelName,.hotel-name,[class*="hotel" i]')){
          const x=String(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
          if(x && x.length<180 && !/hotel search|room type|price|status|non-refundable|available/i.test(x)) pool.push(x);
        }
        if(pool.length){ hotel=pool[pool.length-1]; break; }
        let p=row.previousElementSibling, steps=0;
        while(p&&steps++<12){ const x=String(p.innerText||p.textContent||'').replace(/\s+/g,' ').trim(); if(x&&x.length<180&&!PRICE_RE.test(x)&&/makkah|hotel|resort|suites|residence/i.test(x)){hotel=x;break;} p=p.previousElementSibling; }
        if(hotel) break;
      }
      return {i,text,hotel};
    }).filter(Boolean)).catch(()=>[]);
    for(const x of items){const r=parseRate(x.text,cfg.default_currency||'AED'); if(r) out.push({hotel:clean(x.hotel),...r});}

    const els=await frame.locator('body *:visible').evaluateAll(nodes=>nodes.map((e,i)=>{const t=String(e.innerText||'').replace(/\s+/g,' ').trim();return t&&t.length<500&&PRICE_RE.test(t)?{i,t}:null}).filter(Boolean).slice(0,3000)).catch(()=>[]);
    for(const x of els){ if(x.t.length>220) continue; const r=parseRate(x.t,cfg.default_currency||'AED'); if(r) out.push({hotel:'',...r}); }

    const bodyText=await frame.locator('body').innerText().catch(()=> '');
    const lines=String(bodyText).split(/\r?\n/).map(clean).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      if(!PRICE_RE.test(lines[i])) continue;
      const r=parseRate(lines[i],cfg.default_currency||'AED');
      if(r) out.push({hotel:'',...r});
    }
  }
  const seen=new Set();
  return out.filter(r=>Number.isFinite(r.price)&&r.price>0).filter(r=>{const k=`${clean(r.hotel)}|${clean(r.room)}|${clean(r.board)}|${r.price}|${clean(r.currency)}|${clean(r.cancellation)}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,Number(cfg.max_results)||500);
}
async function searchHadafSource(source,search) {
  const cfg=source.browser_config||{};
  if(!source.login_url||!source.site_username||!source.site_password_enc)return{configured:false,results:[],error:null};
  let password; try{password=decrypt(source.site_password_enc);}catch(e){return{configured:true,results:[],error:`Credential decryption failed: ${e.message}`};}
  let browser,context;
  try{
    browser=await chromium.launch({headless:true}); context=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await context.newPage(); page.setDefaultTimeout(Number(cfg.timeout_ms)||15000);
    await page.goto(source.login_url,{waitUntil:'domcontentloaded',timeout:30000}); await login(page,source,password,cfg); await searchPortal(page,search,cfg);
    await page.waitForTimeout(Number(cfg.results_wait_ms)||10000);
    await blocked(page);
    const pages=[...context.pages()];
    const all=[];
    for(const p of pages){
      try{ await blocked(p); const rows=await extract(p,cfg); all.push(...rows); }catch{}
    }
    const rows=all; const results=rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number(r.price),currency:r.currency||cfg.default_currency||'AED',availability:r.availability||'Available',raw:r.raw||r,image:'',bookingUrl:''}));
    if(!results.length)return{configured:true,results:[],error:'Hadaf login/search completed but no priced rates were extracted'};
    return{configured:true,results,error:null};
  }catch(e){return{configured:true,results:[],error:e.name==='TimeoutError'?'Hadaf browser timed out':e.message};}
  finally{if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});}
}
module.exports={searchHadafSource};

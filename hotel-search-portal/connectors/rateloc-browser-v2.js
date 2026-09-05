const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function finite(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : NaN; }
function currencyOf(v) {
  const m = clean(v).match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
  return m ? m[0].toUpperCase().replace('US$', 'USD').replace('$', 'USD') : '';
}
function priceOf(v) {
  const s = clean(v).replace(/\s+/g, '');
  let m = s.match(/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/i);
  if (!m) m = s.match(/(?:^|[^0-9])([0-9]+(?:\.[0-9]{1,2})?)(?:[^0-9]|$)/);
  return m ? finite(m[1].replace(/,/g, '')) : NaN;
}
function displayDate(iso) {
  const [y,m,d] = String(iso || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(iso || '');
}

async function firstVisible(page, selectors) {
  for (const s of selectors.filter(Boolean)) {
    try { const loc = page.locator(s).first(); if (await loc.count() && await loc.isVisible()) return loc; } catch {}
  }
  return null;
}

async function rankedInputs(page, purpose) {
  const els = page.locator('input:visible, textarea:visible');
  const out = [];
  const n = await els.count().catch(() => 0);
  for (let i=0;i<n;i++) {
    const el = els.nth(i);
    const meta = clean([
      await el.getAttribute('type').catch(()=>''),
      await el.getAttribute('name').catch(()=>''),
      await el.getAttribute('id').catch(()=>''),
      await el.getAttribute('placeholder').catch(()=>''),
      await el.getAttribute('aria-label').catch(()=>''),
      await el.getAttribute('autocomplete').catch(()=>'')
    ].join(' ')).toLowerCase();
    let score=0;
    if (purpose==='username') { if (/email|user|login|account/.test(meta)) score+=20; if (/password|date|search|guest|room/.test(meta)) score-=10; if (/email/.test(meta)) score+=5; }
    if (purpose==='password') { if ((await el.getAttribute('type').catch(()=>''))==='password') score+=50; if (/pass|pwd/.test(meta)) score+=10; }
    if (purpose==='destination') { if (/destination|location|city|hotel|property|search/.test(meta)) score+=15; if (/date|guest|room|nationality|promo/.test(meta)) score-=10; }
    if (purpose==='date') { if (/check.?in|check.?out|arrival|departure|date/.test(meta)) score+=18; if (/destination|location|guest|room|search/.test(meta)) score-=6; }
    out.push({el,score,index:i,meta});
  }
  return out.sort((a,b)=>b.score-a.score||a.index-b.index);
}

async function fillLogin(page, source, cfg) {
  const user = await firstVisible(page,[cfg.username_selector,'input[type="email"]:visible','input[autocomplete="username"]:visible','input[name*="email" i]:visible','input[name*="user" i]:visible','input[id*="email" i]:visible','input[id*="user" i]:visible']) || (await rankedInputs(page,'username'))[0]?.el;
  const pass = await firstVisible(page,[cfg.password_selector,'input[type="password"]:visible','input[autocomplete="current-password"]:visible','input[name*="pass" i]:visible','input[id*="pass" i]:visible']) || (await rankedInputs(page,'password'))[0]?.el;
  if (!user || !pass) throw new Error('RateLoc login fields could not be detected');
  await user.fill(source.site_username);
  await pass.fill(source._password);
  const button = await firstVisible(page,[cfg.login_button_selector,'button:has-text("LOGIN")','button:has-text("Login")','button:has-text("Log in")','input[type="submit"]:visible','button[type="submit"]:visible']);
  if (button) await button.click(); else await pass.press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await sleep(Number(cfg.post_login_wait_ms)||3000);
}

async function checkSecurityAndAuth(page) {
  const text = clean(await page.locator('body').innerText().catch(()=>''));
  const url = page.url();
  if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)) throw new Error('RateLoc presented a security verification step; automated bypass is not supported');
  if (/login|sign.?in/i.test(url) && /password|email|username/i.test(text)) return false;
  return /Accommodation|Total Properties|Dashboard|dashboard/i.test(text+' '+url);
}

async function setDestination(page, value, cfg) {
  const loc = await firstVisible(page,[cfg.destination_selector,'input[placeholder*="hotel name or area" i]:visible','input[placeholder*="location" i]:visible','input[placeholder*="search" i]:visible','input[name*="destination" i]:visible','input[id*="destination" i]:visible','input[name*="location" i]:visible','input[id*="location" i]:visible']) || (await rankedInputs(page,'destination'))[0]?.el;
  if (!loc) throw new Error('RateLoc destination field could not be detected');
  await loc.fill(value);
  await sleep(700);
  const suggestions = page.locator('[role="option"]:visible, .autocomplete-suggestion:visible, .suggestion:visible, li:visible').filter({hasText:value});
  if (await suggestions.count().catch(()=>0)) await suggestions.first().click().catch(()=>{}); else { await loc.press('ArrowDown').catch(()=>{}); await loc.press('Enter').catch(()=>{}); }
}

async function setDates(page, checkin, checkout, cfg) {
  const explicitIn = await firstVisible(page,[cfg.checkin_selector].filter(Boolean));
  const explicitOut = await firstVisible(page,[cfg.checkout_selector].filter(Boolean));
  let inputs=[];
  if (explicitIn) inputs.push(explicitIn); if (explicitOut) inputs.push(explicitOut);
  if (inputs.length<2) {
    for (const x of await rankedInputs(page,'date')) { if (!inputs.length || x.el!==inputs[0]) inputs.push(x.el); if(inputs.length===2) break; }
  }
  if (inputs.length>=2) {
    for (let i=0;i<2;i++) { const el=inputs[i]; const vals=[i===0?checkin:checkout,i===0?displayDate(checkin):displayDate(checkout),i===0?checkin.replace(/-/g,'/'):checkout.replace(/-/g,'/')]; for(const v of vals){ try{await el.fill(v); await el.press('Tab').catch(()=>{}); if((await el.inputValue()).trim()) break;}catch{} } }
    return;
  }
  const range = await firstVisible(page,['input[placeholder*="date" i]:visible','input[placeholder*="check" i]:visible','input[name*="date" i]:visible','input[id*="date" i]:visible']);
  if (range) { await range.fill(`${displayDate(checkin)} - ${displayDate(checkout)}`).catch(()=>{}); await range.press('Tab').catch(()=>{}); return; }
}

async function setGuestsRooms(page, guests, rooms, cfg) {
  for (const selector of [cfg.guests_selector,cfg.rooms_selector]) if (selector) { const el=await firstVisible(page,[selector]); if(el) await el.fill(String(selector===cfg.rooms_selector?rooms:guests)).catch(()=>{}); }
  const nums=page.locator('input[type="number"]:visible');
  const n=await nums.count().catch(()=>0);
  for(let i=0;i<n;i++){
    const el=nums.nth(i); const meta=clean([await el.getAttribute('name').catch(()=>''),await el.getAttribute('id').catch(()=>''),await el.getAttribute('aria-label').catch(()=>''),await el.getAttribute('placeholder').catch(()=>'' )].join(' ')).toLowerCase();
    if(/room/.test(meta)) await el.fill(String(rooms)).catch(()=>{}); else if(/adult|guest|passenger/.test(meta)) await el.fill(String(guests)).catch(()=>{});
  }
}

async function clickSearch(page,cfg){
  const btn=await firstVisible(page,[cfg.search_button_selector,'button:has-text("SEARCH")','button:has-text("Search")','button:has-text("Find")','button[type="submit"]:visible','input[type="submit"]:visible']);
  if(!btn) throw new Error('RateLoc search button could not be detected');
  await btn.click();
}

function collectCurrencyPrices(text) {
  const re=/(AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/gi; const out=[]; let m; while((m=re.exec(text||''))) out.push({price:finite(m[2].replace(/,/g,'')),currency:m[1].toUpperCase().replace('US$','USD').replace('$','USD')}); return out.filter(x=>Number.isFinite(x.price));
}

async function extractDomRates(page) {
  return page.evaluate(() => {
    const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
    const money=/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?/i;
    const standalone=/(?<![0-9])(?:[0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\.[0-9]{2}(?![0-9])/;
    const board=/\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|with breakfast|no meal)\b/i;
    const cancel=/\b(non.?refundable|free cancellation|cancellation policy|refundable|cancel(?:l)?ation)\b/i;
    const room=/\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const view=/\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const avail=/\b(available|rooms? left|on request|sold out)\b/i;
    const seen=new Set(), out=[];
    const nodes=[...document.querySelectorAll('body *')].filter(el=>{const t=clean(el.textContent);return (money.test(t)||standalone.test(t))&&(el.children.length===0||t.length<300);});
    for(const node of nodes){
      let root=node; for(let d=0;d<14&&root.parentElement;d++){const t=clean(root.innerText);if(t.length>=60&&t.length<=2200&&(money.test(t)||standalone.test(t))) break; root=root.parentElement;}
      const raw=clean(root.innerText); if(!raw||raw.length>2400) continue;
      const mm=raw.match(money)||raw.match(standalone); if(!mm) continue;
      let amount=NaN,cur=''; const cm=mm[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i); cur=cm?(cm[0].toUpperCase().replace('US$','USD').replace('$','USD')):''; const pm=mm[0].match(/([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.([0-9]{1,2}))?/); if(pm) amount=Number(pm[0].replace(/,/g,'')); if(!Number.isFinite(amount)||amount<=0) continue;
      if(!cur && !/(?:price|rate|total|amount|currency|aed|sar|usd|eur|gbp|pkr)/i.test(raw)) continue;
      const lines=(root.innerText||'').split(/\n+/).map(clean).filter(Boolean);
      const hotel=lines.find(x=>x.length>=3&&x.length<=140&&!money.test(x)&&!standalone.test(x)&&!board.test(x)&&!cancel.test(x)&&!room.test(x)&&!view.test(x)&&!/^more prices/i.test(x))||lines[0]||'Hotel';
      out.push({hotel,room:lines.find(x=>room.test(x)&&!money.test(x))||'',view:lines.find(x=>view.test(x))||'',board:lines.find(x=>board.test(x))||'',cancellation:lines.find(x=>cancel.test(x))||'',availability:lines.find(x=>avail.test(x))||'Available',price:amount,currency:cur,raw});
    }
    return out;
  });
}

function walkObject(obj, ctx, out, depth=0, seen=new Set()) {
  if(depth>7 || obj==null) return;
  if(typeof obj==='string') { const prices=collectCurrencyPrices(obj); for(const p of prices) out.push({...ctx,...p}); return; }
  if(typeof obj!=='object') return;
  if(seen.has(obj)) return; seen.add(obj);
  if(Array.isArray(obj)) { for(const v of obj) walkObject(v,ctx,out,depth+1,seen); return; }
  const local={...ctx};
  for(const [k,v] of Object.entries(obj)) {
    const key=k.toLowerCase();
    if(typeof v==='string') {
      if(/hotel|property/.test(key)) local.hotel=v;
      else if(/room(name|type|category)?/.test(key)) local.room=v;
      else if(/view/.test(key)) local.view=v;
      else if(/board|meal/.test(key)) local.board=v;
      else if(/cancel|policy|terms/.test(key)) local.cancellation=v;
      else if(/avail|status/.test(key)) local.availability=v;
      else if(/currency/.test(key)) local.currency=currencyOf(v);
    }
    if(/price|rate|amount|total|net|gross|sell|selling|cost|value/.test(key) && (typeof v==='number'||typeof v==='string')) {
      const p=priceOf(v); if(Number.isFinite(p)) out.push({...local,price:p,currency:local.currency||currencyOf(v)});
    }
  }
  for(const [k,v] of Object.entries(obj)) walkObject(v,local,out,depth+1,seen);
}

async function captureJsonResponses(page, bucket) {
  const events=[];
  const handler=async response=>{
    try{
      const u=response.url(); if(!/^https?:/i.test(u)) return;
      const ct=(await response.header('content-type').catch(()=>''))||'';
      const interesting=/(json|javascript|text|xml)/i.test(ct)||/search|availability|hotel|room|rate|price|booking/i.test(u);
      if(!interesting) return;
      const req=response.request(); if(['image','font','stylesheet','media'].includes(req.resourceType())) return;
      const text=await response.text().catch(()=>'' ); if(!text||text.length>150000) return;
      if(!/(price|rate|amount|total|hotel|room|availability|currency|more prices|boards|AED|SAR|USD|EUR|GBP|PKR|\$)/i.test(text)) return;
      events.push({url:u,text}); if(events.length>80) events.shift();
    }catch{}
  };
  page.on('response',handler); bucket.handlers.push([page,handler]);
}

async function getBestPages(context) {
  const pages=context.pages().filter(p=>!p.isClosed()); const scored=[];
  for(const p of pages){
    const text=clean(await p.locator('body').innerText().catch(()=>'')); let score=0;
    if(/Total Properties|Recommended|More Prices/i.test(text)) score+=20;
    if(collectCurrencyPrices(text).length) score+=30;
    if(/results/i.test(p.url())) score+=8;
    if(/Accommodation/i.test(text)) score+=4;
    scored.push({p,score,text});
  }
  return scored.sort((a,b)=>b.score-a.score).map(x=>x.p);
}

async function searchRateLocSource(source, search) {
  if(!source?.login_url || !source?.site_username || !source?.site_password_enc) return {configured:false,results:[],error:null};
  let password; try { password=decrypt(source.site_password_enc); } catch(e) { return {configured:true,results:[],error:`Credential decryption failed: ${e.message}`}; }
  let browser=null,context=null; const captured={events:[],handlers:[]};
  try{
    browser=await chromium.launch({headless:true});
    context=await browser.newContext({viewport:{width:1440,height:1100},locale:'en-US'});
    const pages=[await context.newPage()];
    for(const p of pages) await captureJsonResponses(p,captured);
    context.on('page',async p=>{await captureJsonResponses(p,captured);});
    const page=pages[0]; page.setDefaultTimeout(Number(source.browser_config?.timeout_ms)||15000);
    const cfg={...(source.browser_config||{})}; source._password=password;
    await page.goto(source.login_url,{waitUntil:'domcontentloaded',timeout:30000});
    let auth=await checkSecurityAndAuth(page); if(!auth) { await fillLogin(page,source,cfg); auth=await checkSecurityAndAuth(page); }
    if(!auth) throw new Error('RateLoc login did not complete with the stored credentials');
    await setDestination(page,search.destination,cfg);
    await setDates(page,search.checkin,search.checkout,cfg);
    await setGuestsRooms(page,search.guests,search.rooms||1,cfg);
    if(cfg.board_selector) { const board=await firstVisible(page,[cfg.board_selector]); if(board) await board.selectOption(String(search.board||'ROOM_ONLY')).catch(()=>{}); }
    await clickSearch(page,cfg);
    await sleep(Number(cfg.results_wait_ms)||5000);

    let best=await getBestPages(context); let bestPage=best[0]||page;
    for(let i=0;i<14;i++){
      await sleep(700);
      best=await getBestPages(context); bestPage=best[0]||bestPage;
      const txt=clean(await bestPage.locator('body').innerText().catch(()=>''));
      if(collectCurrencyPrices(txt).length || /More Prices|Total Properties|Recommended/i.test(txt)) break;
    }
    for(const p of await getBestPages(context)){
      await p.locator('body').evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{});
      await sleep(300);
      const more=p.getByText(/More Prices(?: & Boards)?|More Prices and Boards/i); const n=await more.count().catch(()=>0);
      for(let i=0;i<n;i++){const el=more.nth(i);if(await el.isVisible().catch(()=>false)) await el.click({timeout:3000}).catch(()=>{});}
    }
    await sleep(1200);

    const domRows=[]; const seenPages=new Set();
    for(const p of await getBestPages(context)){ if(seenPages.has(p)) continue; seenPages.add(p); for(const f of p.frames()) { const rows=await extractDomRates(f).catch(()=>[]); domRows.push(...rows); } }
    const jsonRows=[];
    for(const ev of captured.events){
      try{ walkObject(JSON.parse(ev.text),{},jsonRows); }catch{ const prices=collectCurrencyPrices(ev.text); for(const x of prices) jsonRows.push({...x,raw:ev.text.slice(0,2000)}); }
    }
    const rows=[...domRows,...jsonRows]; const dedupe=new Set(); const results=[];
    for(const r of rows){ const price=finite(r.price); if(!Number.isFinite(price)||price<=0) continue; const key=[clean(r.hotel||'Hotel'),clean(r.room||''),clean(r.view||''),clean(r.board||''),price,clean(r.currency||'')].join('|'); if(dedupe.has(key)) continue; dedupe.add(key); results.push({id:`${source.id}-${results.length}`,supplier:source.name||'RateLoc',hotel:clean(r.hotel||'Hotel'),room:clean(r.room||''),view:clean(r.view||''),board:clean(r.board||search.board||''),cancellation:clean(r.cancellation||''),price,currency:clean(r.currency||cfg.default_currency||''),availability:clean(r.availability||'Available'),image:'',bookingUrl:'',raw:r.raw||r}); if(results.length>=Number(cfg.max_results)||500) break; }
    if(!results.length) return {configured:true,results:[],error:'RateLoc results loaded, but no priced rates were exposed in the page or captured rate data'};
    results.sort((a,b)=>a.price-b.price); return {configured:true,results,error:null};
  } catch(e) { return {configured:true,results:[],error:e?.name==='TimeoutError'?'RateLoc timed out':e.message||String(e)}; }
  finally {
    for(const [p,h] of captured.handlers) p.off('response',h);
    if(context) await context.close().catch(()=>{}); if(browser) await browser.close().catch(()=>{});
  }
}

module.exports={searchRateLocSource};

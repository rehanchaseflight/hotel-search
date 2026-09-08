const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');
const rezliveSession = require('./rezlive-session');

function fillTemplate(template, search) {
  return String(template || '')
    .replaceAll('{destination}', encodeURIComponent(search.destination))
    .replaceAll('{checkin}', search.checkin)
    .replaceAll('{checkout}', search.checkout)
    .replaceAll('{guests}', String(search.guests))
    .replaceAll('{rooms}', String(search.rooms || 1))
    .replaceAll('{board}', encodeURIComponent(search.board || 'ROOM_ONLY'));
}
function text(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function number(v) { const m = text(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; }
function sourceSelector(explicit, fallbacks) { return explicit || fallbacks[0] || null; }

async function allFrames(page) { try { return page.frames(); } catch { return [page.mainFrame()]; } }

async function firstVisibleAnyFrame(page, selectors) {
  for (const frame of await allFrames(page)) {
    for (const selector of selectors.filter(Boolean)) {
      try {
        const loc = frame.locator(selector).first();
        if (await loc.count() && await loc.isVisible()) return loc;
      } catch {}
    }
  }
  return null;
}

async function scoreInputs(page, purpose) {
  const rows = [];
  for (const frame of await allFrames(page)) {
    let inputs;
    try { inputs = frame.locator('input:visible, textarea:visible'); } catch { continue; }
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      const meta = text([
        await el.getAttribute('type').catch(() => ''),
        await el.getAttribute('name').catch(() => ''),
        await el.getAttribute('id').catch(() => ''),
        await el.getAttribute('placeholder').catch(() => ''),
        await el.getAttribute('aria-label').catch(() => ''),
        await el.getAttribute('autocomplete').catch(() => '')
      ].join(' ')).toLowerCase();
      let score = 0;
      if (purpose === 'username') {
        if (/email|user|login|account|agent/.test(meta)) score += 20;
        if (/password|date|check|guest|room|search/.test(meta)) score -= 10;
        if ((await el.getAttribute('type').catch(() => '')) === 'email') score += 8;
      } else if (purpose === 'password') {
        if ((await el.getAttribute('type').catch(() => '')) === 'password') score += 50;
        if (/pass|pwd/.test(meta)) score += 10;
      } else if (purpose === 'destination') {
        if (/destination|location|city|area|hotel|property|going to|search/.test(meta)) score += 20;
        if (/date|check|guest|room|nationality|promo|email|password/.test(meta)) score -= 12;
      } else if (purpose === 'date') {
        if (/check.?in|check.?out|arrival|departure|date/.test(meta)) score += 20;
        if (/destination|location|guest|room|nationality|email|password/.test(meta)) score -= 10;
      } else if (purpose === 'guests') {
        if (/guest|adult|traveller|traveler|pax|passenger/.test(meta)) score += 20;
        if (/room|date|destination|email|password/.test(meta)) score -= 8;
      } else if (purpose === 'rooms') {
        if (/room/.test(meta)) score += 25;
        if (/guest|adult|date|destination|email|password/.test(meta)) score -= 8;
      }
      rows.push({ el, score, index: i, meta });
    }
  }
  return rows.sort((a,b) => b.score-a.score || a.index-b.index);
}

async function clickEntryPoint(page, patterns) {
  for (const frame of await allFrames(page)) {
    for (const pattern of patterns) {
      try {
        const b = frame.getByRole('button', { name: pattern }).first();
        if (await b.count() && await b.isVisible()) { await b.click({ timeout: 5000 }); return true; }
      } catch {}
      try {
        const t = frame.getByText(pattern).first();
        if (await t.count() && await t.isVisible()) { await t.click({ timeout: 5000 }); return true; }
      } catch {}
    }
  }
  return false;
}

async function blockedReason(page) {
  const chunks = [];
  for (const frame of await allFrames(page)) {
    try { chunks.push(text(await frame.locator('body').innerText())); } catch {}
  }
  const body = chunks.join(' ').toLowerCase();
  if (/captcha|verify you are human|access denied|unusual traffic|security check|enable javascript and cookies/.test(body)) {
    return 'Supplier presented a security verification step; automated bypass is not supported';
  }
  return null;
}

async function loginGeneric(page, source, cfg, password) {
  let user = await firstVisibleAnyFrame(page, [
    cfg.username_selector,'input[type="email"]:visible','input[autocomplete="username"]:visible',
    'input[name*="email" i]:visible','input[name*="user" i]:visible','input[id*="email" i]:visible','input[id*="user" i]:visible'
  ]);
  let pass = await firstVisibleAnyFrame(page, [
    cfg.password_selector,'input[type="password"]:visible','input[autocomplete="current-password"]:visible',
    'input[name*="pass" i]:visible','input[id*="pass" i]:visible'
  ]);

  if (!user || !pass) {
    const blocked = await blockedReason(page);
    if (blocked) throw new Error(blocked);
    await clickEntryPoint(page,[/login/i,/sign\s*in/i,/agent\s*login/i,/partner\s*login/i]);
    await page.waitForTimeout(1200);
    user = user || await firstVisibleAnyFrame(page,[cfg.username_selector,'input[type="email"]:visible','input[autocomplete="username"]:visible','input[name*="email" i]:visible','input[name*="user" i]:visible','input[id*="email" i]:visible','input[id*="user" i]:visible']);
    pass = pass || await firstVisibleAnyFrame(page,[cfg.password_selector,'input[type="password"]:visible','input[autocomplete="current-password"]:visible','input[name*="pass" i]:visible','input[id*="pass" i]:visible']);
  }
  if (!user) user = (await scoreInputs(page,'username'))[0]?.el;
  if (!pass) pass = (await scoreInputs(page,'password'))[0]?.el;
  if (!user || !pass) throw new Error('Supplier login fields could not be detected');

  await user.fill(String(source.site_username || ''));
  await pass.fill(String(password || ''));
  const button = await firstVisibleAnyFrame(page,[cfg.login_button_selector,'button:has-text("LOGIN")','button:has-text("Login")','button:has-text("Sign in")','input[type="submit"]:visible','button[type="submit"]:visible']);
  if (button) await button.click(); else await pass.press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms)||3000);
  const after = await blockedReason(page); if(after) throw new Error(after);
}

async function fillSmart(page,purpose,value,explicitSelector){
  const loc=await firstVisibleAnyFrame(page,[explicitSelector]);
  const ranked=loc||(await scoreInputs(page,purpose))[0]?.el;
  if(!ranked)return false;
  try{await ranked.fill(String(value));await ranked.press('Tab').catch(()=>{});return true;}catch{return false;}
}

async function navigateGenericSearch(page,search,cfg){
  const url=cfg.search_url_template?fillTemplate(cfg.search_url_template,search):'';
  if(url){await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return;}
  if(!await fillSmart(page,'destination',search.destination,cfg.destination_selector)) throw new Error('Supplier destination field could not be detected');
  await fillSmart(page,'date',search.checkin,cfg.checkin_selector);await fillSmart(page,'date',search.checkout,cfg.checkout_selector);
  await fillSmart(page,'guests',search.guests,cfg.guests_selector);await fillSmart(page,'rooms',search.rooms||1,cfg.rooms_selector);
  if(cfg.board_selector){const b=await firstVisibleAnyFrame(page,[cfg.board_selector]);if(b)await b.selectOption(String(search.board||'ROOM_ONLY')).catch(()=>{});}
  const btn=await firstVisibleAnyFrame(page,[cfg.search_button_selector,'button:has-text("SEARCH")','button:has-text("Search")','button:has-text("Find")','button:has-text("CHECK AVAILABILITY")','input[type="submit"]:visible','button[type="submit"]:visible']);
  if(!btn)throw new Error('Supplier search button could not be detected');await btn.click();
}

async function extractRatesFromFrame(frame,cfg){
  if(cfg.result_row_selector){try{return await frame.locator(cfg.result_row_selector).evaluateAll((nodes,c)=>{const clean=v=>String(v||'').replace(/\s+/g,' ').trim();const get=(root,s)=>{if(!s)return '';const e=root.querySelector(s);return e?clean(e.innerText||e.textContent):''};return nodes.slice(0,Number(c.max_results)||500).map((root,index)=>({index,hotel:get(root,c.hotel_selector),room:get(root,c.room_selector),view:get(root,c.view_selector),board:get(root,c.board_selector),price:get(root,c.price_selector),currency:get(root,c.currency_selector),cancellation:get(root,c.cancellation_selector),availability:get(root,c.availability_selector)}));},cfg)}catch{return[]}}
  return frame.evaluate(()=>{const clean=v=>String(v??'').replace(/\s+/g,' ').trim();const priceRe=/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;const boardRe=/\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|with breakfast|no meal)\b/i;const cancelRe=/\b(non.?refundable|free cancellation|cancellation policy|refundable|cancel(?:l)ation)\b/i;const roomRe=/\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;const viewRe=/\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;const availRe=/\b(available|rooms? left|on request|sold out)\b/i;const out=[];const seen=new Set();const nodes=[...document.querySelectorAll('body *')].filter(e=>{const t=clean(e.textContent);return priceRe.test(t)&&(e.children.length===0||t.length<300)});for(const n of nodes){let root=n;for(let i=0;i<12&&root.parentElement;i++){const t=clean(root.innerText||root.textContent);if(t.length>=80&&t.length<=2200&&priceRe.test(t))break;root=root.parentElement;}const raw=clean(root.innerText||root.textContent);if(!raw||seen.has(raw))continue;seen.add(raw);const m=raw.match(priceRe);if(!m)continue;const price=Number(m[0].replace(/[^0-9.]/g,''));if(!Number.isFinite(price)||price<=0)continue;const lines=raw.split(/\n+/).map(clean).filter(Boolean);const cm=m[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);out.push({hotel:lines.find(x=>/hotel|resort|inn|suites/i.test(x))||lines[0]||'Hotel',room:lines.find(x=>roomRe.test(x)&&!priceRe.test(x))||'',view:lines.find(x=>viewRe.test(x))||'',board:lines.find(x=>boardRe.test(x))||'',cancellation:lines.find(x=>cancelRe.test(x))||'',availability:lines.find(x=>availRe.test(x))||'Available',price,currency:cm?cm[0].replace('US$','USD').replace('$','USD').toUpperCase():'',raw});}return out.slice(0,500);}).catch(()=>[]);
}

async function searchBrowserSource(source,search){
  const cfg=source.browser_config||{};if(!source.login_url||!source.site_username||!source.site_password_enc)return{configured:false,results:[],error:null};
  let password;try{password=decrypt(source.site_password_enc);}catch(e){return{configured:true,results:[],error:`Credential decryption failed: ${e.message}`};}
  let browser=null,context=null;
  try{
    if(cfg.preset==='rezlive'&&rezliveSession.hasRezLiveSession()){
      browser=await chromium.launch({headless:true});context=await browser.newContext({storageState:rezliveSession.STORAGE_PATH,viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(Number(cfg.timeout_ms)||12000);const rows=await searchRezLive(page,search,{...cfg,_authenticated:true});return{configured:true,results:rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number.isFinite(r.price)?r.price:number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r})).filter(r=>Number.isFinite(r.price)&&r.price>0),error:null};
    }
    browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(Number(cfg.timeout_ms)||12000);await page.goto(source.login_url,{waitUntil:'domcontentloaded',timeout:30000});
    if(cfg.preset==='rezlive'){const rows=await searchRezLive(page,search,{...cfg,_username:source.site_username,_password:password});return{configured:true,results:rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number.isFinite(r.price)?r.price:number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r})).filter(r=>Number.isFinite(r.price)&&r.price>0),error:null};}
    await loginGeneric(page,source,cfg,password);await navigateGenericSearch(page,search,cfg);
    if(cfg.results_wait_for_selector){const loc=await firstVisibleAnyFrame(page,[cfg.results_wait_for_selector]);if(loc)await loc.waitFor({state:'visible',timeout:Number(cfg.results_timeout_ms)||20000});}else await page.waitForTimeout(Number(cfg.results_wait_ms)||4000);
    const blocked=await blockedReason(page);if(blocked)throw new Error(blocked);
    let rows=[];for(const frame of await allFrames(page))rows.push(...await extractRatesFromFrame(frame,cfg));const seen=new Set();rows=rows.filter(r=>{const p=Number(r.price);if(!Number.isFinite(p)||p<=0)return false;const k=`${r.hotel}|${r.room}|${r.board}|${p}|${r.currency}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,Number(cfg.max_results)||500);
    const results=rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r}));
    if(!results.length)return{configured:true,results:[],error:'Supplier login/search completed but no priced rates were extracted'};
    return{configured:true,results,error:null};
  }catch(e){return{configured:true,results:[],error:e.name==='TimeoutError'?'Supplier browser timed out':e.message};}finally{if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});}
}

module.exports={searchBrowserSource,fillTemplate};

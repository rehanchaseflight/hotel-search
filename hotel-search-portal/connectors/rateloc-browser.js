const { chromium } = require('playwright');

let persistentContext = null;
let rateLocPage = null;
let loginWait = null;

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function parseDateForDisplay(iso) { const [y,m,d] = String(iso).split('-'); return `${d}/${m}/${y}`; }

async function firstVisible(frame, selectors) {
  for (const selector of selectors) {
    const loc = frame.locator(selector).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}
async function fillFirst(frame, selectors, value) { const loc=await firstVisible(frame,selectors); if(!loc)return false; try{await loc.fill(String(value));return true;}catch{return false;} }
async function clickFirst(frame, selectors) { const loc=await firstVisible(frame,selectors); if(!loc)return false; try{await loc.click();return true;}catch{return false;} }
function dashboardLooksAuthenticated(text,url){return /Accommodation/i.test(text)&&(/Dashboard/i.test(text)||/dashboard/i.test(url||''));}

async function bestRateLocPage() {
  const pages = (persistentContext?.pages?.() || []).filter(p => !p.isClosed());
  let best = null, bestScore = -1;
  for (const p of pages) {
    const text = clean(await p.locator('body').innerText().catch(() => ''));
    const url = p.url();
    let score = 0;
    if (/Total Properties\s+\d+/i.test(text)) score += 20;
    if (/Recommended/i.test(text)) score += 8;
    if (/Free Cancellation|Room Only|Breakfast|Half Board|Full Board|All Inclusive/i.test(text)) score += 3;
    if (/(?:AED|SAR|USD|EUR|GBP|PKR|\$)\s*[0-9][0-9,]*(?:\.\d{1,2})?/i.test(text)) score += 15;
    if (/results/i.test(url)) score += 6;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best || rateLocPage || null;
}

async function ensureRateLocSession() {
  const existing = await bestRateLocPage();
  if (existing && dashboardLooksAuthenticated(clean(await existing.locator('body').innerText().catch(() => '')), existing.url())) { rateLocPage=existing; return existing; }

  if (!persistentContext) {
    persistentContext = await chromium.launchPersistentContext('', { headless:false, viewport:{width:1440,height:1200}, locale:'en-US' });
    persistentContext.on('page', page => { rateLocPage = page; });
  }
  rateLocPage = persistentContext.pages()[0] || await persistentContext.newPage();
  await rateLocPage.goto('https://www.rateloc.com/',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  const currentText=clean(await rateLocPage.locator('body').innerText().catch(()=>''));
  if(dashboardLooksAuthenticated(currentText,rateLocPage.url())) return rateLocPage;
  if(!loginWait){
    loginWait=(async()=>{const started=Date.now();while(Date.now()-started<180000){const p=await bestRateLocPage();if(p){const text=clean(await p.locator('body').innerText().catch(()=>''));if(dashboardLooksAuthenticated(text,p.url())){rateLocPage=p;return true;}}await new Promise(r=>setTimeout(r,1000));}throw new Error('RateLoc manual login timed out. Please log in once in the RateLoc browser window.');})().finally(()=>{loginWait=null;});
  }
  await loginWait; return rateLocPage;
}

async function setDateRange(page,checkin,checkout){
  const values=[`${parseDateForDisplay(checkin)} - ${parseDateForDisplay(checkout)}`,`${parseDateForDisplay(checkin)} – ${parseDateForDisplay(checkout)}`,`${checkin} - ${checkout}`,`${checkin} – ${checkout}`];
  const selectors=['input[placeholder*="date" i]','input[placeholder*="check" i]','input[name*="date" i]','input[id*="date" i]','input[name*="check" i]','input[id*="check" i]'];
  for(const frame of page.frames()) for(const selector of selectors){const loc=frame.locator(selector).first();if(!(await loc.count().catch(()=>0))||!(await loc.isVisible().catch(()=>false)))continue;try{await loc.click();for(const value of values){try{await loc.fill(value);if((await loc.inputValue().catch(()=>''))===value){await loc.press('Tab').catch(()=>{});return true;}}catch{}}}catch{}}
  return false;
}
async function setPassengers(page,guests,rooms){
  const labels=['Passengers','Guests'];
  for(const frame of page.frames()) for(const label of labels){const byText=frame.getByText(label,{exact:false}).first();if(!(await byText.count().catch(()=>0)))continue;try{if(!await byText.isVisible().catch(()=>false))continue;await byText.click();await page.waitForTimeout(250);const nums=frame.locator('input[type="number"]');const count=await nums.count().catch(()=>0);for(let i=0;i<count;i++){const loc=nums.nth(i);const meta=`${await loc.getAttribute('name').catch(()=> '')} ${await loc.getAttribute('id').catch(()=> '')} ${await loc.getAttribute('aria-label').catch(()=> '')} ${await loc.getAttribute('placeholder').catch(()=> '')}`.toLowerCase();if(/room/.test(meta))await loc.fill(String(rooms)).catch(()=>{});else if(/adult|guest|passenger/.test(meta))await loc.fill(String(guests)).catch(()=>{});}await page.keyboard.press('Escape').catch(()=>{});return true;}catch{}}
  return false;
}

async function expandMorePricesAndBoards(page){
  const selectors=['button:has-text("More Prices & Boards")','button:has-text("More Prices")','text=More Prices & Boards','text=More Prices'];
  for(let pass=0;pass<5;pass++){let clicked=false;for(const frame of page.frames())for(const selector of selectors){const loc=frame.locator(selector);const count=await loc.count().catch(()=>0);for(let i=0;i<count;i++){const target=loc.nth(i);if(await target.isVisible().catch(()=>false)){await target.click({timeout:3000}).catch(()=>{});clicked=true;await page.waitForTimeout(300);}}}if(!clicked)break;}
}
async function scrollResults(page){for(let i=0;i<12;i++){await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{});await page.waitForTimeout(400);}await page.evaluate(()=>window.scrollTo(0,0)).catch(()=>{});}

async function extractFrameResults(frame){
  return frame.evaluate(() => {
    const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
    const priceRe=/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.\d{1,2})?/i;
    const boardRe=/\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|ultra all inclusive|with breakfast|no meal)\b/i;
    const cancelRe=/\b(non.?refundable|free cancellation|cancellation|cancel(?:l)?ation policy|refundable)\b/i;
    const roomRe=/\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const viewRe=/\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const availRe=/\b(available|rooms? left|on request|sold out)\b/i;
    const genericRe=/^(quote|view currencies|more prices.*|recommended|dashboard|results|breakfast|total properties\s+\d+)$/i;
    const seen=new Set(),out=[];
    const priceNodes=Array.from(document.querySelectorAll('body *')).filter(el=>priceRe.test(clean(el.textContent)) && (el.children.length===0 || clean(el.textContent).length<250));
    for(const node of priceNodes){
      let root=node;
      for(let d=0;d<10&&root.parentElement;d++){
        const raw=clean(root.innerText);
        if(raw.length>=90&&raw.length<=1800&&priceRe.test(raw)) break;
        root=root.parentElement;
      }
      const raw=clean(root.innerText); if(!raw||raw.length>2000||!priceRe.test(raw))continue;
      const key=raw.slice(0,1800); if(seen.has(key))continue; seen.add(key);
      const lines=(root.innerText||'').split(/\n+/).map(clean).filter(Boolean);
      const priceMatch=raw.match(priceRe); if(!priceMatch)continue;
      const price=Number(priceMatch[0].replace(/[^0-9.]/g,'')); if(!Number.isFinite(price)||price<=0)continue;
      const hotel=lines.find(x=>x.length>=3&&x.length<=120&&!priceRe.test(x)&&!boardRe.test(x)&&!cancelRe.test(x)&&!viewRe.test(x)&&!roomRe.test(x)&&!genericRe.test(x))||lines[0]||'Hotel';
      const room=lines.find(x=>roomRe.test(x)&&!priceRe.test(x)&&!boardRe.test(x)&&!viewRe.test(x))||'';
      const view=lines.find(x=>viewRe.test(x)&&!cancelRe.test(x))||'';
      const board=lines.find(x=>boardRe.test(x))||'';
      const cancellation=lines.find(x=>cancelRe.test(x))||'';
      const availability=lines.find(x=>availRe.test(x))||'Available';
      const currency=(priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i)||['USD'])[0].replace('US$','USD').replace('$','USD');
      out.push({hotel,room,view,board,cancellation,availability,price,currency,raw});
    }
    return out;
  });
}

async function extractRateLocResults(page){
  const combined=[]; const seen=new Set();
  for(const frame of page.frames()){
    const rows=await extractFrameResults(frame).catch(()=>[]);
    for(const r of rows){const key=JSON.stringify([r.hotel,r.room,r.view,r.board,r.price,r.raw]);if(!seen.has(key)){seen.add(key);combined.push(r);}}
  }
  return combined.slice(0,1000);
}

async function searchRateLocSource(source,search){
  if(!source.login_url||!source.site_username)return{configured:false,results:[],error:null};
  try{
    const page=await ensureRateLocSession(); page.setDefaultTimeout(15000);
    if(!dashboardLooksAuthenticated(clean(await page.locator('body').innerText().catch(()=>'')),page.url()))return{configured:true,results:[],error:'RateLoc session is not authenticated'};

    const before=new Set(persistentContext.pages());
    const destination=await fillFirst(page.mainFrame(),['input[placeholder="Search"]','input[placeholder*="hotel name or area" i]','input[placeholder*="search for a hotel" i]','input[placeholder*="location" i]','input[name*="location" i]','input[name*="destination" i]'],search.destination);
    if(!destination)throw new Error('RateLoc location field could not be detected on dashboard');
    await page.waitForTimeout(500); await setDateRange(page,search.checkin,search.checkout); await setPassengers(page,search.guests,search.rooms||1);
    if(!await clickFirst(page.mainFrame(),['button:has-text("SEARCH")','button:has-text("Search")','button[type="submit"]']))throw new Error('RateLoc search button could not be detected on dashboard');

    await page.waitForTimeout(2500);
    let resultPage=await bestRateLocPage();
    for(let i=0;i<20;i++){
      const candidates=persistentContext.pages().filter(p=>!p.isClosed());
      const newPage=candidates.find(p=>!before.has(p));
      if(newPage){resultPage=newPage;break;}
      const candidate=await bestRateLocPage();
      if(candidate)resultPage=candidate;
      const text=clean(await resultPage?.locator('body').innerText().catch(()=>''));
      if(/Total Properties\s+\d+|Recommended/i.test(text))break;
      await page.waitForTimeout(500);
    }
    if(!resultPage)resultPage=page;
    await resultPage.waitForLoadState('domcontentloaded').catch(()=>{});
    await resultPage.waitForTimeout(3000);
    await expandMorePricesAndBoards(resultPage); await scrollResults(resultPage); await resultPage.waitForTimeout(800);
    const rows=await extractRateLocResults(resultPage);
    const results=rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:'RateLoc',hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number(r.price),currency:r.currency||'USD',availability:r.availability||'Available',image:'',bookingUrl:'',raw:r.raw||r})).filter(r=>Number.isFinite(r.price)&&r.price>0);
    return{configured:true,results,error:results.length?'': 'RateLoc returned a results page but no priced rates could be extracted'};
  }catch(e){return{configured:true,results:[],error:e.name==='TimeoutError'?'RateLoc timed out':e.message};}
}
process.once('exit',()=>{persistentContext?.close().catch?.(()=>{});});
process.once('SIGINT',async()=>{await persistentContext?.close().catch(()=>{});process.exit(0);});
process.once('SIGTERM',async()=>{await persistentContext?.close().catch(()=>{});process.exit(0);});
module.exports={searchRateLocSource};

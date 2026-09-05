const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');
function fillTemplate(template,search){return String(template||'').replaceAll('{destination}',encodeURIComponent(search.destination)).replaceAll('{checkin}',search.checkin).replaceAll('{checkout}',search.checkout).replaceAll('{guests}',String(search.guests)).replaceAll('{rooms}',String(search.rooms||1)).replaceAll('{board}',encodeURIComponent(search.board||'ROOM_ONLY'))}
function text(v){return String(v??'').replace(/\s+/g,' ').trim()}
function number(v){const m=text(v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):NaN}
async function searchBrowserSource(source,search){
 if(!source.login_url||!source.site_username||!source.site_password_enc)return{configured:false,results:[],error:null};
 let password;try{password=decrypt(source.site_password_enc)}catch(e){return{configured:true,results:[],error:`Credential decryption failed: ${e.message}`}}
 const cfg=source.browser_config||{};let browser=null,context=null;
 try{
  browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(Number(cfg.timeout_ms)||12000);
  await page.goto(source.login_url,{waitUntil:'domcontentloaded',timeout:30000});
  if(cfg.agent_code_selector&&source.agent_code)await page.locator(cfg.agent_code_selector).fill(source.agent_code);
  if(cfg.username_selector)await page.locator(cfg.username_selector).fill(source.site_username);
  if(cfg.password_selector)await page.locator(cfg.password_selector).fill(password);
  if(cfg.login_button_selector)await page.locator(cfg.login_button_selector).click();else if(cfg.password_selector)await page.locator(cfg.password_selector).press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});if(cfg.post_login_wait_ms)await page.waitForTimeout(Number(cfg.post_login_wait_ms));
  const searchUrl=fillTemplate(cfg.search_url_template,search);
  if(searchUrl)await page.goto(searchUrl,{waitUntil:'domcontentloaded',timeout:30000});else{
   if(cfg.destination_selector)await page.locator(cfg.destination_selector).fill(search.destination);if(cfg.checkin_selector)await page.locator(cfg.checkin_selector).fill(search.checkin);if(cfg.checkout_selector)await page.locator(cfg.checkout_selector).fill(search.checkout);if(cfg.guests_selector)await page.locator(cfg.guests_selector).fill(String(search.guests));if(cfg.rooms_selector)await page.locator(cfg.rooms_selector).fill(String(search.rooms||1));if(cfg.board_selector)await page.locator(cfg.board_selector).selectOption(String(search.board||'ROOM_ONLY')).catch(()=>{});if(cfg.search_button_selector)await page.locator(cfg.search_button_selector).click();
  }
  if(cfg.results_wait_for_selector)await page.locator(cfg.results_wait_for_selector).first().waitFor({state:'visible',timeout:Number(cfg.results_timeout_ms)||20000});else if(cfg.results_wait_ms)await page.waitForTimeout(Number(cfg.results_wait_ms));
  const rows=await page.locator(cfg.result_row_selector||'body').evaluateAll((nodes,c)=>{const get=(root,sel)=>{if(!sel)return'';const el=root.querySelector(sel);return el?(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim():''};return nodes.slice(0,Number(c.max_results)||300).map((root,i)=>({index:i,hotel:get(root,c.hotel_selector),room:get(root,c.room_selector),board:get(root,c.board_selector),price:get(root,c.price_selector),currency:get(root,c.currency_selector),cancellation:get(root,c.cancellation_selector),bookingUrl:root.querySelector(c.booking_url_selector||'a[href]')?.href||'',image:root.querySelector(c.image_selector||'img')?.src||''}))},cfg);
  const results=rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',board:r.board||search.board,price:number(r.price),currency:r.currency||cfg.default_currency||'',cancellation:r.cancellation||'',bookingUrl:r.bookingUrl||'',image:r.image||'',raw:r})).filter(r=>r.hotel!=='Hotel'||Number.isFinite(r.price));
  return{configured:true,results,error:null};
 }catch(e){return{configured:true,results:[],error:e.name==='TimeoutError'?'Supplier browser timed out':e.message}}finally{if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{})}
}
module.exports={searchBrowserSource,fillTemplate};
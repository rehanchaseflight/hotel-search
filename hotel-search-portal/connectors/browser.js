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

async function searchRezLive(page, search, cfg) {
  if (!cfg._authenticated) {
    const username = sourceSelector(cfg.username_selector, [
      'input[placeholder*="Username/Email" i]',
      'input[name="username"]',
      'input[name*="user" i]:not([type="hidden"])',
      'input[id*="user" i]:not([type="hidden"])',
      'input[placeholder*="user" i]'
    ]);
    const password = sourceSelector(cfg.password_selector, ['input[type="password"]']);
    if (!username || !password) throw new Error('RezLive login fields could not be detected');
    await page.locator(username).first().fill(cfg._username);
    await page.locator(password).first().fill(cfg._password);
    const loginButton = sourceSelector(cfg.login_button_selector, ['button:has-text("Login")', 'input[type="submit"]', 'button[type="submit"]']);
    if (loginButton) await page.locator(loginButton).first().click(); else await page.locator(password).first().press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 2500);
  }

  const searchUrl = cfg.search_url_template
    ? fillTemplate(cfg.search_url_template, search)
    : 'https://www.rezlive.com/agency/hotels/action/searchhotel';
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const destination = sourceSelector(cfg.destination_selector, [
    'input[name*="destination" i]', 'input[id*="destination" i]', 'input[placeholder*="destination" i]', 'input[placeholder*="property" i]'
  ]);
  const checkin = sourceSelector(cfg.checkin_selector, [
    'input[name*="checkin" i]', 'input[name*="check-in" i]', 'input[id*="checkin" i]', 'input[id*="check-in" i]'
  ]);
  const checkout = sourceSelector(cfg.checkout_selector, [
    'input[name*="checkout" i]', 'input[name*="check-out" i]', 'input[id*="checkout" i]', 'input[id*="check-out" i]'
  ]);
  const guests = sourceSelector(cfg.guests_selector, ['input[name*="guest" i]', 'input[id*="guest" i]']);
  const rooms = sourceSelector(cfg.rooms_selector, ['input[name*="room" i]', 'input[id*="room" i]']);

  if (destination) await page.locator(destination).first().fill(search.destination);
  if (checkin) await page.locator(checkin).first().fill(search.checkin);
  if (checkout) await page.locator(checkout).first().fill(search.checkout);
  if (guests) await page.locator(guests).first().fill(String(search.guests));
  if (rooms) await page.locator(rooms).first().fill(String(search.rooms || 1));

  const searchButton = sourceSelector(cfg.search_button_selector, [
    'button:has-text("Let’s Find")', 'button:has-text("Let\'s Find")', 'button:has-text("Find")', 'input[type="submit"]'
  ]);
  if (searchButton) await page.locator(searchButton).first().click(); else throw new Error('RezLive search button could not be detected');

  if (cfg.results_wait_for_selector) {
    await page.locator(cfg.results_wait_for_selector).first().waitFor({ state: 'visible', timeout: Number(cfg.results_timeout_ms) || 20000 });
  } else await page.waitForTimeout(Number(cfg.results_wait_ms) || 4000);

  return extractRezLiveRates(page, cfg);
}

async function extractRezLiveRates(page, cfg) {
  if (cfg.result_row_selector) return extractConfiguredRows(page, cfg);
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const priceRe = /(?:USD|US\$|EUR|GBP|AED|SAR|PKR)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
    const seen = new Set(), out = [];
    const availableNodes = [...document.querySelectorAll('body *')].filter(el => {
      const t = clean(el.innerText); return t.length >= 40 && t.length <= 2500 && /\bavailable\b/i.test(t) && priceRe.test(t);
    });
    for (const el of availableNodes) {
      let root = el;
      for (let i = 0; i < 5 && root.parentElement; i++) { const t = clean(root.innerText); if (t.length >= 100 && t.length <= 1800 && priceRe.test(t)) break; root = root.parentElement; }
      const raw = clean(root.innerText); if (!raw || seen.has(raw)) continue; seen.add(raw);
      const priceMatch = raw.match(priceRe); const lines = raw.split(/\n+/).map(clean).filter(Boolean);
      const boardLine = lines.find(x => /\b(breakfast|room only|half board|full board|all inclusive)\b/i.test(x)) || '';
      const roomLine = lines.find(x => /\b(twin|double|king|queen|classic|deluxe|suite|room|family|triple|quad|single)\b/i.test(x) && !priceRe.test(x)) || '';
      const viewLine = lines.find(x => /\b(no view|city view|kaaba view|sea view|garden view|pool view|partial view|view)\b/i.test(x)) || '';
      const cancellation = lines.find(x => /\b(cancellation|non.?refundable|refundable|free cancel|cancel)\b/i.test(x)) || '';
      const availability = lines.find(x => /^available$/i.test(x)) || 'Available';
      const hotel = lines.find(x => /hotel/i.test(x)) || lines[0] || 'Hotel';
      const currency = priceMatch ? (priceMatch[0].match(/USD|US\$|EUR|GBP|AED|SAR|PKR/i) || [''])[0].replace('US$','USD') : '';
      const price = priceMatch ? Number(priceMatch[0].replace(/[^0-9.]/g, '')) : NaN;
      out.push({ hotel, room: roomLine, view: viewLine, board: boardLine, price, currency, cancellation, availability, raw });
    }
    return out.slice(0, 500);
  });
}

async function extractConfiguredRows(page, cfg) {
  return page.locator(cfg.result_row_selector).evaluateAll((nodes, c) => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const get = (root, selector) => { if (!selector) return ''; const el = root.querySelector(selector); return el ? clean(el.innerText || el.textContent) : ''; };
    return nodes.slice(0, Number(c.max_results) || 500).map((root, index) => ({ index, hotel: get(root,c.hotel_selector), room: get(root,c.room_selector), view: get(root,c.view_selector), board: get(root,c.board_selector), price: get(root,c.price_selector), currency: get(root,c.currency_selector), cancellation: get(root,c.cancellation_selector), availability: get(root,c.availability_selector) }));
  }, cfg);
}

async function searchBrowserSource(source, search) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) return { configured: false, results: [], error: null };
  let password;
  try { password = decrypt(source.site_password_enc); } catch (e) { return { configured: true, results: [], error: `Credential decryption failed: ${e.message}` }; }

  let browser = null, context = null;
  try {
    if (cfg.preset === 'rezlive' && rezliveSession.hasRezLiveSession()) {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ storageState: rezliveSession.STORAGE_PATH, viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(Number(cfg.timeout_ms) || 12000);
      const rows = await searchRezLive(page, search, { ...cfg, _authenticated: true });
      const results = rows.map((r,i) => ({ id:`${source.id}-${i}`, supplier:source.name, hotel:r.hotel||'Hotel', room:r.room||'', view:r.view||'', board:r.board||search.board||'', cancellation:r.cancellation||'', price:Number.isFinite(r.price)?r.price:number(r.price), currency:r.currency||cfg.default_currency||'', availability:r.availability||'', raw:r.raw||r })).filter(r=>r.hotel!=='Hotel'||r.room||Number.isFinite(r.price));
      return { configured:true, results, error:null };
    }

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(cfg.timeout_ms) || 12000);
    await page.goto(source.login_url, { waitUntil:'domcontentloaded', timeout:30000 });
    let rows;
    if (cfg.preset === 'rezlive') {
      rows = await searchRezLive(page, search, { ...cfg, _username:source.site_username, _password:password });
    } else {
      if (cfg.agent_code_selector && source.agent_code) await page.locator(cfg.agent_code_selector).fill(source.agent_code);
      if (cfg.username_selector) await page.locator(cfg.username_selector).fill(source.site_username);
      if (cfg.password_selector) await page.locator(cfg.password_selector).fill(password);
      if (cfg.login_button_selector) await page.locator(cfg.login_button_selector).click(); else if (cfg.password_selector) await page.locator(cfg.password_selector).press('Enter');
      await page.waitForLoadState('domcontentloaded').catch(()=>{});
      if (cfg.post_login_wait_ms) await page.waitForTimeout(Number(cfg.post_login_wait_ms));
      const searchUrl = fillTemplate(cfg.search_url_template, search);
      if (searchUrl) await page.goto(searchUrl,{waitUntil:'domcontentloaded',timeout:30000});
      else {
        if (cfg.destination_selector) await page.locator(cfg.destination_selector).fill(search.destination);
        if (cfg.checkin_selector) await page.locator(cfg.checkin_selector).fill(search.checkin);
        if (cfg.checkout_selector) await page.locator(cfg.checkout_selector).fill(search.checkout);
        if (cfg.guests_selector) await page.locator(cfg.guests_selector).fill(String(search.guests));
        if (cfg.rooms_selector) await page.locator(cfg.rooms_selector).fill(String(search.rooms||1));
        if (cfg.board_selector) await page.locator(cfg.board_selector).selectOption(String(search.board||'ROOM_ONLY')).catch(()=>{});
        if (cfg.search_button_selector) await page.locator(cfg.search_button_selector).click();
      }
      if (cfg.results_wait_for_selector) await page.locator(cfg.results_wait_for_selector).first().waitFor({state:'visible',timeout:Number(cfg.results_timeout_ms)||20000}); else if (cfg.results_wait_ms) await page.waitForTimeout(Number(cfg.results_wait_ms));
      rows = cfg.result_row_selector ? await extractConfiguredRows(page,cfg) : [];
    }
    const results = rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number.isFinite(r.price)?r.price:number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r})).filter(r=>r.hotel!=='Hotel'||r.room||Number.isFinite(r.price));
    return {configured:true,results,error:null};
  } catch(e) {
    return {configured:true,results:[],error:e.name==='TimeoutError'?'Supplier browser timed out':e.message};
  } finally {
    if (context) await context.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
}

module.exports = { searchBrowserSource, fillTemplate };

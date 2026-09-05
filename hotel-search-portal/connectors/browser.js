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

async function firstVisible(page, selectors) {
  for (const selector of selectors.filter(Boolean)) {
    try {
      const loc = page.locator(selector).filter({ visible: true }).first();
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch {}
    try {
      const loc = page.locator(selector).first();
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch {}
  }
  return null;
}

async function scoreInputs(page, purpose) {
  const inputs = page.locator('input:visible, textarea:visible');
  const count = await inputs.count().catch(() => 0);
  const rows = [];
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
  return rows.sort((a, b) => b.score - a.score || a.index - b.index);
}

async function fillSmart(page, purpose, value, explicitSelector) {
  const explicit = await firstVisible(page, [explicitSelector]);
  const ranked = explicit || (await scoreInputs(page, purpose))[0]?.el;
  if (!ranked) return false;
  try {
    await ranked.fill(String(value));
    await ranked.press('Tab').catch(() => {});
    return true;
  } catch {}
  return false;
}

async function loginGeneric(page, source, cfg, password) {
  const username = await firstVisible(page, [
    cfg.username_selector,
    'input[type="email"]:visible',
    'input[autocomplete="username"]:visible',
    'input[name*="email" i]:visible',
    'input[name*="user" i]:visible',
    'input[id*="email" i]:visible',
    'input[id*="user" i]:visible'
  ]);
  const passwordLoc = await firstVisible(page, [
    cfg.password_selector,
    'input[type="password"]:visible',
    'input[autocomplete="current-password"]:visible'
  ]);
  const userSmart = username || (await scoreInputs(page, 'username'))[0]?.el;
  const passSmart = passwordLoc || (await scoreInputs(page, 'password'))[0]?.el;
  if (!userSmart || !passSmart) throw new Error('Supplier login fields could not be detected');

  await userSmart.fill(String(source.site_username || ''));
  await passSmart.fill(String(password || ''));

  const loginButton = await firstVisible(page, [
    cfg.login_button_selector,
    'button:has-text("LOGIN")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button[type="submit"]:visible',
    'input[type="submit"]:visible'
  ]);
  if (loginButton) await loginButton.click(); else await passSmart.press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 2500);
}

async function navigateGenericSearch(page, search, cfg) {
  const searchUrl = cfg.search_url_template ? fillTemplate(cfg.search_url_template, search) : '';
  if (searchUrl) {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return;
  }

  await fillSmart(page, 'destination', search.destination, cfg.destination_selector);
  await fillSmart(page, 'date', search.checkin, cfg.checkin_selector);
  await fillSmart(page, 'date', search.checkout, cfg.checkout_selector);
  await fillSmart(page, 'guests', search.guests, cfg.guests_selector);
  await fillSmart(page, 'rooms', search.rooms || 1, cfg.rooms_selector);

  if (cfg.board_selector) {
    const board = await firstVisible(page, [cfg.board_selector]);
    if (board) await board.selectOption(String(search.board || 'ROOM_ONLY')).catch(() => {});
  }

  const searchButton = await firstVisible(page, [
    cfg.search_button_selector,
    'button:has-text("SEARCH")',
    'button:has-text("Search")',
    'button:has-text("Find")',
    'button:has-text("CHECK AVAILABILITY")',
    'button[type="submit"]:visible',
    'input[type="submit"]:visible'
  ]);
  if (!searchButton) throw new Error('Supplier search button could not be detected');
  await searchButton.click();
}

async function extractGenericRates(page, cfg) {
  if (cfg.result_row_selector) return extractConfiguredRows(page, cfg);
  return page.evaluate(() => {
    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
    const boardRe = /\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|with breakfast|no meal)\b/i;
    const cancelRe = /\b(non.?refundable|free cancellation|cancellation policy|refundable|cancel(?:l)ation)\b/i;
    const roomRe = /\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const viewRe = /\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const availabilityRe = /\b(available|rooms? left|on request|sold out)\b/i;
    const seen = new Set();
    const out = [];
    const leaves = Array.from(document.querySelectorAll('body *')).filter(el => {
      const t = clean(el.textContent);
      return priceRe.test(t) && (el.children.length === 0 || t.length < 300);
    });
    for (const leaf of leaves) {
      let root = leaf;
      for (let i = 0; i < 12 && root.parentElement; i++) {
        const t = clean(root.innerText || root.textContent);
        if (t.length >= 100 && t.length <= 2200 && priceRe.test(t)) break;
        root = root.parentElement;
      }
      const raw = clean(root.innerText || root.textContent);
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      const priceMatch = raw.match(priceRe);
      if (!priceMatch) continue;
      const lines = raw.split(/\n+/).map(clean).filter(Boolean);
      const price = Number(priceMatch[0].replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(price) || price <= 0) continue;
      const currencyMatch = priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
      const hotel = lines.find(x => /hotel|resort|inn|suites/i.test(x)) || lines[0] || 'Hotel';
      const room = lines.find(x => roomRe.test(x) && !priceRe.test(x)) || '';
      const view = lines.find(x => viewRe.test(x)) || '';
      const board = lines.find(x => boardRe.test(x)) || '';
      const cancellation = lines.find(x => cancelRe.test(x)) || '';
      const availability = lines.find(x => availabilityRe.test(x)) || 'Available';
      out.push({ hotel, room, view, board, cancellation, availability, price, currency: currencyMatch ? currencyMatch[0].replace('US$','USD').replace('$','USD').toUpperCase() : '', raw });
    }
    return out.slice(0, 500);
  });
}

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

    await loginGeneric(page, source, cfg, password);

    const searchUrl = cfg.search_url_template ? fillTemplate(cfg.search_url_template, search) : '';
    if (searchUrl) await page.goto(searchUrl,{waitUntil:'domcontentloaded',timeout:30000});
    else await navigateGenericSearch(page, search, cfg);

    if (cfg.results_wait_for_selector) {
      await page.locator(cfg.results_wait_for_selector).first().waitFor({state:'visible',timeout:Number(cfg.results_timeout_ms)||20000});
    } else await page.waitForTimeout(Number(cfg.results_wait_ms) || 5000);

    const rows = await extractGenericRates(page, cfg);
    const results = rows.map((r,i)=>({
      id:`${source.id}-${i}`,
      supplier:source.name,
      hotel:r.hotel||'Hotel',
      room:r.room||'',
      view:r.view||'',
      board:r.board||search.board||'',
      cancellation:r.cancellation||'',
      price:Number.isFinite(r.price)?r.price:number(r.price),
      currency:r.currency||cfg.default_currency||'',
      availability:r.availability||'Available',
      raw:r.raw||r
    })).filter(r=>Number.isFinite(r.price) && r.price>0);

    if (!results.length) throw new Error('Supplier returned no priced hotel rates');
    return { configured:true, results, error:null };
  } catch(e) {
    return { configured:true, results:[], error:e.name==='TimeoutError'?'Supplier browser timed out':e.message };
  } finally {
    if (context) await context.close().catch(()=>{});
    if (browser) await browser.close().catch(()=>{});
  }
}

module.exports = { searchBrowserSource, fillTemplate };

const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseNumber(value) {
  const m = clean(value).replace(/,/g, '').match(/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  return m ? Number(m[1]) : NaN;
}
function parseCurrency(value) {
  const m = clean(value).match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
  if (!m) return '';
  return m[0].toUpperCase().replace('US$', 'USD').replace('$', 'USD');
}
function displayDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(iso || '');
}

async function visibleLoc(page, candidates) {
  for (const candidate of candidates) {
    try {
      const loc = typeof candidate === 'string' ? page.locator(candidate).first() : candidate;
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch {}
  }
  return null;
}

async function clickByText(page, patterns) {
  for (const pattern of patterns) {
    try {
      const loc = page.getByRole('button', { name: pattern }).first();
      if (await loc.count() && await loc.isVisible()) {
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {}
    try {
      const loc = page.getByText(pattern).first();
      if (await loc.count() && await loc.isVisible()) {
        await loc.click({ timeout: 5000 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function scoreInputs(page, purpose) {
  const inputs = page.locator('input:visible, textarea:visible');
  const count = await inputs.count().catch(() => 0);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    const meta = clean([
      await el.getAttribute('type').catch(() => ''),
      await el.getAttribute('name').catch(() => ''),
      await el.getAttribute('id').catch(() => ''),
      await el.getAttribute('placeholder').catch(() => ''),
      await el.getAttribute('aria-label').catch(() => ''),
      await el.getAttribute('autocomplete').catch(() => '')
    ].join(' ')).toLowerCase();
    let score = 0;
    if (purpose === 'username') {
      if (/user|email|login|account/.test(meta)) score += 10;
      if (/password|search|date|guest|room/.test(meta)) score -= 8;
      if (await el.getAttribute('type').catch(() => '') === 'email') score += 6;
    } else if (purpose === 'password') {
      if ((await el.getAttribute('type').catch(() => '')) === 'password') score += 50;
      if (/pass|password|pwd/.test(meta)) score += 10;
    } else if (purpose === 'destination') {
      if (/destination|location|city|hotel|property|search/.test(meta)) score += 12;
      if (/date|guest|room|nationality|promo/.test(meta)) score -= 8;
    } else if (purpose === 'date') {
      if (/date|check.?in|check.?out|arrival|departure/.test(meta)) score += 14;
      if (/destination|location|guest|room|search/.test(meta)) score -= 5;
    }
    rows.push({ el, score, index: i, meta });
  }
  return rows.sort((a, b) => b.score - a.score || a.index - b.index);
}

async function fillInput(loc, value) {
  if (!loc) return false;
  try {
    await loc.fill(String(value));
    await loc.press('Tab').catch(() => {});
    return true;
  } catch {}
  return false;
}

async function fillLogin(page, username, password, cfg) {
  const usernameLoc = await visibleLoc(page, [
    cfg.username_selector,
    'input[type="email"]:visible',
    'input[name*="email" i]:visible',
    'input[name*="user" i]:visible',
    'input[id*="email" i]:visible',
    'input[id*="user" i]:visible',
    'input[autocomplete="username"]:visible'
  ].filter(Boolean));
  const rankedUser = usernameLoc || (await scoreInputs(page, 'username'))[0]?.el;
  const passwordLoc = await visibleLoc(page, [
    cfg.password_selector,
    'input[type="password"]:visible',
    'input[name*="pass" i]:visible',
    'input[id*="pass" i]:visible',
    'input[autocomplete="current-password"]:visible'
  ].filter(Boolean));
  const rankedPassword = passwordLoc || (await scoreInputs(page, 'password'))[0]?.el;

  if (!rankedUser || !rankedPassword) throw new Error('RateLoc login fields could not be detected');
  await rankedUser.fill(username);
  await rankedPassword.fill(password);

  const loginButton = await visibleLoc(page, [
    cfg.login_button_selector,
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'input[type="submit"]:visible',
    'button[type="submit"]:visible'
  ].filter(Boolean));
  if (loginButton) await loginButton.click();
  else await rankedPassword.press('Enter');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 2500);
}

async function isLoginPage(page) {
  const text = clean(await page.locator('body').innerText().catch(() => ''));
  const url = page.url();
  return /login|sign.?in/i.test(url) || (/password/i.test(text) && /login|sign.?in/i.test(text));
}

async function isAuthenticated(page) {
  const text = clean(await page.locator('body').innerText().catch(() => ''));
  const url = page.url();
  if (!text) return false;
  if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)) {
    throw new Error('RateLoc presented a security verification step; automated bypass is not supported');
  }
  return /Accommodation/i.test(text) || /Total Properties/i.test(text) || /dashboard/i.test(url);
}

async function setDestination(page, destination, cfg) {
  const loc = await visibleLoc(page, [
    cfg.destination_selector,
    'input[placeholder*="hotel name or area" i]:visible',
    'input[placeholder*="location" i]:visible',
    'input[placeholder*="search" i]:visible',
    'input[name*="destination" i]:visible',
    'input[id*="destination" i]:visible',
    'input[name*="location" i]:visible',
    'input[id*="location" i]:visible'
  ].filter(Boolean));
  const ranked = loc || (await scoreInputs(page, 'destination'))[0]?.el;
  if (!ranked) throw new Error('RateLoc destination field could not be detected');
  await ranked.fill(destination);
  await page.waitForTimeout(600);
  await ranked.press('ArrowDown').catch(() => {});
  await ranked.press('Enter').catch(() => {});
  return true;
}

async function setDateValue(loc, iso) {
  if (!loc) return false;
  const candidates = [iso, displayDate(iso), iso.replace(/-/g, '/')];
  for (const value of candidates) {
    try {
      await loc.fill(value);
      await loc.press('Tab').catch(() => {});
      const current = await loc.inputValue().catch(() => '');
      if (current === value || current.includes(value) || value === iso) return true;
    } catch {}
  }
  return false;
}

async function setDates(page, checkin, checkout, cfg) {
  const dateInputs = [];
  const explicitIn = await visibleLoc(page, [cfg.checkin_selector].filter(Boolean));
  const explicitOut = await visibleLoc(page, [cfg.checkout_selector].filter(Boolean));
  if (explicitIn) dateInputs.push(explicitIn);
  if (explicitOut) dateInputs.push(explicitOut);

  if (dateInputs.length < 2) {
    const ranked = await scoreInputs(page, 'date');
    for (const item of ranked) {
      if (dateInputs.some(x => x && x === item.el)) continue;
      dateInputs.push(item.el);
      if (dateInputs.length === 2) break;
    }
  }
  if (dateInputs.length >= 2) {
    await setDateValue(dateInputs[0], checkin);
    await setDateValue(dateInputs[1], checkout);
    return true;
  }

  const datePicker = await visibleLoc(page, [
    'input[placeholder*="date" i]:visible',
    'input[placeholder*="check in" i]:visible',
    'input[placeholder*="check-in" i]:visible',
    'input[name*="date" i]:visible',
    'input[id*="date" i]:visible'
  ].filter(Boolean));
  if (!datePicker) return false;

  try {
    await datePicker.fill(`${displayDate(checkin)} - ${displayDate(checkout)}`);
    await datePicker.press('Tab').catch(() => {});
    return true;
  } catch {}
  return false;
}

async function setGuestsAndRooms(page, guests, rooms, cfg) {
  if (cfg.guests_selector) await fillInput(await visibleLoc(page, [cfg.guests_selector].filter(Boolean)), guests);
  if (cfg.rooms_selector) await fillInput(await visibleLoc(page, [cfg.rooms_selector].filter(Boolean)), rooms);

  const numberInputs = page.locator('input[type="number"]:visible');
  const count = await numberInputs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = numberInputs.nth(i);
    const meta = clean([
      await el.getAttribute('name').catch(() => ''),
      await el.getAttribute('id').catch(() => ''),
      await el.getAttribute('aria-label').catch(() => ''),
      await el.getAttribute('placeholder').catch(() => '')
    ].join(' ')).toLowerCase();
    if (/room/.test(meta)) await fillInput(el, rooms);
    else if (/guest|adult|passenger/.test(meta)) await fillInput(el, guests);
  }

  const passengerControl = page.getByText(/Passengers|Guests|Rooms/i).first();
  if (await passengerControl.count().catch(() => 0) && await passengerControl.isVisible().catch(() => false)) {
    await passengerControl.click().catch(() => {});
    await page.waitForTimeout(200);
    const controls = page.locator('input[type="number"]:visible');
    const total = await controls.count().catch(() => 0);
    for (let i = 0; i < total; i++) {
      const el = controls.nth(i);
      const meta = clean([
        await el.getAttribute('name').catch(() => ''),
        await el.getAttribute('id').catch(() => ''),
        await el.getAttribute('aria-label').catch(() => ''),
        await el.getAttribute('placeholder').catch(() => '')
      ].join(' ')).toLowerCase();
      if (/room/.test(meta)) await fillInput(el, rooms);
      else if (/adult|guest|passenger/.test(meta)) await fillInput(el, guests);
    }
    await page.keyboard.press('Escape').catch(() => {});
  }
}

async function runSearch(page, search, cfg) {
  const directSearchUrl = cfg.search_url_template
    ? String(cfg.search_url_template)
        .replaceAll('{destination}', encodeURIComponent(search.destination))
        .replaceAll('{checkin}', search.checkin)
        .replaceAll('{checkout}', search.checkout)
        .replaceAll('{guests}', String(search.guests))
        .replaceAll('{rooms}', String(search.rooms || 1))
        .replaceAll('{board}', encodeURIComponent(search.board || 'ROOM_ONLY'))
    : '';

  if (directSearchUrl) {
    await page.goto(directSearchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return;
  }

  await setDestination(page, search.destination, cfg);
  await setDates(page, search.checkin, search.checkout, cfg);
  await setGuestsAndRooms(page, search.guests, search.rooms || 1, cfg);

  if (cfg.board_selector) {
    const board = await visibleLoc(page, [cfg.board_selector].filter(Boolean));
    if (board) await board.selectOption(String(search.board || 'ROOM_ONLY')).catch(() => {});
  }

  const searchButton = await visibleLoc(page, [
    cfg.search_button_selector,
    'button:has-text("SEARCH")',
    'button:has-text("Search")',
    'button:has-text("Find")',
    'button[type="submit"]:visible',
    'input[type="submit"]:visible'
  ].filter(Boolean));
  if (!searchButton) throw new Error('RateLoc search button could not be detected');
  await searchButton.click();
}

async function expandMorePrices(page) {
  for (let pass = 0; pass < 6; pass++) {
    let clicked = false;
    const buttons = page.getByText(/More Prices(?: & Boards)?|More Prices and Boards/i);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = buttons.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(300);
      }
    }
    if (!clicked) break;
  }
}

async function scrollAll(page) {
  for (let i = 0; i < 14; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(250);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function extractRates(page) {
  return page.evaluate(() => {
    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
    const boardRe = /\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|with breakfast|no meal)\b/i;
    const cancelRe = /\b(non.?refundable|free cancellation|cancellation policy|refundable|cancel(?:l)?ation)\b/i;
    const roomRe = /\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const viewRe = /\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const availabilityRe = /\b(available|rooms? left|on request|sold out)\b/i;
    const seen = new Set();
    const out = [];

    const priceNodes = Array.from(document.querySelectorAll('body *')).filter(el => {
      const t = clean(el.textContent);
      return priceRe.test(t) && (el.children.length === 0 || t.length < 260);
    });

    for (const node of priceNodes) {
      let root = node;
      for (let d = 0; d < 12 && root.parentElement; d++) {
        const t = clean(root.innerText);
        if (t.length >= 100 && t.length <= 1800 && priceRe.test(t)) break;
        root = root.parentElement;
      }

      const raw = clean(root.innerText);
      if (!raw || raw.length > 2000 || !priceRe.test(raw)) continue;
      const priceMatch = raw.match(priceRe);
      if (!priceMatch) continue;
      const key = raw.slice(0, 1800);
      if (seen.has(key)) continue;
      seen.add(key);

      const lines = String(root.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const price = Number(priceMatch[0].replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(price) || price <= 0) continue;

      const hotel = lines.find(x => x.length >= 3 && x.length <= 140 && !priceRe.test(x) && !boardRe.test(x) && !cancelRe.test(x) && !viewRe.test(x) && !roomRe.test(x)) || 'Hotel';
      const room = lines.find(x => roomRe.test(x) && !priceRe.test(x) && !boardRe.test(x) && !viewRe.test(x)) || '';
      const view = lines.find(x => viewRe.test(x) && !cancelRe.test(x)) || '';
      const board = lines.find(x => boardRe.test(x)) || '';
      const cancellation = lines.find(x => cancelRe.test(x)) || '';
      const availability = lines.find(x => availabilityRe.test(x)) || 'Available';
      const currencyMatch = priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
      const currency = currencyMatch ? currencyMatch[0].toUpperCase().replace('US$', 'USD').replace('$', 'USD') : '';

      out.push({ hotel, room, view, board, cancellation, availability, price, currency, raw });
    }
    return out.slice(0, 1000);
  });
}

async function searchRateLocSource(source, search) {
  if (!source.login_url || !source.site_username || !source.site_password_enc) {
    return { configured: false, results: [], error: null };
  }

  let password;
  try {
    password = decrypt(source.site_password_enc);
  } catch (e) {
    return { configured: true, results: [], error: `Credential decryption failed: ${e.message}` };
  }

  let browser = null;
  let context = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage']
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      locale: 'en-US'
    });
    const page = await context.newPage();
    const cfg = source.browser_config || {};
    page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);

    await page.goto(source.login_url || 'https://www.rateloc.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (await isLoginPage(page)) {
      await fillLogin(page, source.site_username, password, cfg);
    }

    let authenticated = await isAuthenticated(page);
    if (!authenticated) {
      for (let i = 0; i < 10 && !authenticated; i++) {
        await sleep(700);
        authenticated = await isAuthenticated(page);
      }
    }
    if (!authenticated) throw new Error('RateLoc login did not reach the authenticated dashboard');

    await runSearch(page, search, cfg);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(Number(cfg.results_wait_ms) || 3500);

    if (await isLoginPage(page)) throw new Error('RateLoc redirected back to login after search');
    await expandMorePrices(page);
    await scrollAll(page);
    await page.waitForTimeout(600);

    const rows = await extractRates(page);
    const results = rows
      .map((r, i) => ({
        id: `${source.id}-${i}`,
        supplier: source.name || 'RateLoc',
        hotel: r.hotel || 'Hotel',
        room: r.room || '',
        view: r.view || '',
        board: r.board || search.board || '',
        cancellation: r.cancellation || '',
        price: Number(r.price),
        currency: r.currency || cfg.default_currency || '',
        availability: r.availability || 'Available',
        image: '',
        bookingUrl: '',
        raw: r.raw || r
      }))
      .filter(r => Number.isFinite(r.price) && r.price > 0);

    return {
      configured: true,
      results,
      error: results.length ? null : 'RateLoc returned a results page but no priced rates could be extracted'
    };
  } catch (e) {
    return {
      configured: true,
      results: [],
      error: e.name === 'TimeoutError' ? 'RateLoc browser timed out' : e.message
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { searchRateLocSource, parseNumber, parseCurrency };

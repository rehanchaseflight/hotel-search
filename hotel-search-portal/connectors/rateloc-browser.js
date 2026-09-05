const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      try {
        if (await locator.isVisible().catch(() => false)) {
          await locator.fill(String(value));
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function fillLoginIdentifier(page, value) {
  const semantic = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[aria-label*="email" i]',
    'input[name*="username" i]',
    'input[id*="username" i]',
    'input[placeholder*="username" i]',
    'input[aria-label*="username" i]'
  ];
  if (await fillFirst(page, semantic, value)) return true;

  // RateLoc may render the email field as a plain text input with no semantic attributes.
  const candidates = page.locator('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([readonly])');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const loc = candidates.nth(i);
    if (!await loc.isVisible().catch(() => false)) continue;
    const meta = `${await loc.getAttribute('name').catch(() => '')} ${await loc.getAttribute('id').catch(() => '')} ${await loc.getAttribute('placeholder').catch(() => '')} ${await loc.getAttribute('aria-label').catch(() => '')}`.toLowerCase();
    if (/(search|location|destination|hotel name|area)/.test(meta)) continue;
    try { await loc.fill(String(value)); return true; } catch {}
  }
  return false;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      try {
        if (await locator.isVisible().catch(() => false)) {
          await locator.click();
          return true;
        }
      } catch {}
    }
  }
  return false;
}

function parseDateForDisplay(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

async function setDateRange(page, checkin, checkout) {
  const values = [
    `${parseDateForDisplay(checkin)} - ${parseDateForDisplay(checkout)}`,
    `${checkin} - ${checkout}`,
    `${parseDateForDisplay(checkin)} – ${parseDateForDisplay(checkout)}`,
    `${checkin} – ${checkout}`
  ];
  const selectors = [
    'input[placeholder*="date" i]', 'input[placeholder*="check" i]',
    'input[name*="date" i]', 'input[id*="date" i]',
    'input[name*="check" i]', 'input[id*="check" i]',
    'input[type="text"]'
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (!(await loc.count().catch(() => 0))) continue;
    try {
      await loc.click();
      for (const value of values) {
        try {
          await loc.fill(value);
          if ((await loc.inputValue().catch(() => '')) === value) return true;
        } catch {}
      }
      await loc.press('Escape').catch(() => {});
    } catch {}
  }
  return false;
}

async function setPassengers(page, guests, rooms) {
  const labels = ['Passengers', 'passengers', 'Guests', 'guests'];
  for (const label of labels) {
    const byText = page.getByText(label, { exact: false }).first();
    if (!(await byText.count().catch(() => 0))) continue;
    try {
      await byText.click();
      await page.waitForTimeout(250);
      const inputs = page.locator('input[type="number"]');
      const n = await inputs.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const input = inputs.nth(i);
        const name = clean(await input.getAttribute('name').catch(() => ''));
        const aria = clean(await input.getAttribute('aria-label').catch(() => ''));
        const ph = clean(await input.getAttribute('placeholder').catch(() => ''));
        const meta = `${name} ${aria} ${ph}`.toLowerCase();
        if (/room/.test(meta)) await input.fill(String(rooms)).catch(() => {});
        else if (/adult|guest|passenger/.test(meta)) await input.fill(String(guests)).catch(() => {});
      }
      await page.keyboard.press('Escape').catch(() => {});
      return;
    } catch {}
  }
}

async function expandMorePricesAndBoards(page) {
  const selectors = [
    'button:has-text("More Prices & Boards")',
    'button:has-text("More Prices")',
    'text=More Prices & Boards',
    'text=More Prices'
  ];
  for (let pass = 0; pass < 3; pass++) {
    let clicked = false;
    for (const selector of selectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const target = loc.nth(i);
        if (await target.isVisible().catch(() => false)) {
          await target.click({ timeout: 3000 }).catch(() => {});
          clicked = true;
          await page.waitForTimeout(250);
        }
      }
    }
    if (!clicked) break;
  }
}

async function extractRateLocResults(page) {
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.\d{1,2})?/i;
    const availabilityRe = /\bavailable\b|\brooms? left\b|\bon request\b|\bsold out\b/i;
    const boardRe = /\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|ultra all inclusive|with breakfast|no meal)\b/i;
    const cancelRe = /\b(non.?refundable|free cancellation|cancellation|cancel(?:l)?ation policy|refundable)\b/i;
    const roomRe = /\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const viewRe = /\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const seen = new Set();
    const out = [];

    const roots = Array.from(document.querySelectorAll('tr, [role="row"], article, li, [class*="card" i], [class*="room" i], [class*="rate" i], [class*="hotel" i], [class*="property" i]'));
    for (const root of roots) {
      const raw = clean(root.innerText);
      if (!raw || raw.length < 25 || raw.length > 3500 || !priceRe.test(raw)) continue;
      const key = raw.slice(0, 1500);
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = (root.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const priceMatch = raw.match(priceRe);
      const hotel = lines.find(x => !priceRe.test(x) && !boardRe.test(x) && !cancelRe.test(x) && !viewRe.test(x) && x.length <= 120) || lines[0] || 'Hotel';
      const room = lines.find(x => roomRe.test(x) && !priceRe.test(x) && !boardRe.test(x) && !viewRe.test(x)) || '';
      const view = lines.find(x => viewRe.test(x) && !cancelRe.test(x)) || '';
      const board = lines.find(x => boardRe.test(x)) || '';
      const cancellation = lines.find(x => cancelRe.test(x)) || '';
      const availability = lines.find(x => availabilityRe.test(x)) || (availabilityRe.test(raw) ? 'Available' : '');
      const currency = priceMatch ? (priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i) || [''])[0].replace('US$', 'USD').replace('$', 'USD') : '';
      const price = priceMatch ? Number(priceMatch[0].replace(/[^0-9.]/g, '')) : NaN;
      out.push({ hotel, room, view, board, cancellation, availability, price, currency, raw });
    }

    if (!out.length) {
      const blocks = Array.from(document.querySelectorAll('body *')).filter(el => {
        const raw = clean(el.innerText);
        return raw.length >= 45 && raw.length <= 2400 && priceRe.test(raw);
      });
      for (const el of blocks.slice(0, 800)) {
        const raw = clean(el.innerText);
        const key = raw.slice(0, 1500);
        if (seen.has(key)) continue;
        seen.add(key);
        const lines = (el.innerText || '').split(/\n+/).map(clean).filter(Boolean);
        const priceMatch = raw.match(priceRe);
        const board = lines.find(x => boardRe.test(x)) || '';
        const cancellation = lines.find(x => cancelRe.test(x)) || '';
        const room = lines.find(x => roomRe.test(x) && !priceRe.test(x)) || '';
        const view = lines.find(x => viewRe.test(x)) || '';
        const hotel = lines.find(x => !priceRe.test(x) && !boardRe.test(x) && !cancelRe.test(x) && !viewRe.test(x) && x.length <= 120) || lines[0] || 'Hotel';
        const currency = priceMatch ? (priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i) || [''])[0].replace('US$', 'USD').replace('$', 'USD') : '';
        const price = priceMatch ? Number(priceMatch[0].replace(/[^0-9.]/g, '')) : NaN;
        const availability = lines.find(x => availabilityRe.test(x)) || '';
        out.push({ hotel, room, view, board, cancellation, availability, price, currency, raw });
      }
    }
    return out.slice(0, 500);
  });
}

async function searchRateLocSource(source, search) {
  if (!source.login_url || !source.site_username || !source.site_password_enc) return { configured: false, results: [], error: null };
  let password;
  try { password = decrypt(source.site_password_enc); } catch (e) { return { configured: true, results: [], error: `Credential decryption failed: ${e.message}` }; }
  let browser = null, context = null;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(source.login_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!await fillLoginIdentifier(page, source.site_username)) throw new Error('RateLoc email field could not be detected');
    if (!await fillFirst(page, ['input[type="password"]','input[name="password"]','input[id*="password" i]'], password)) throw new Error('RateLoc password field could not be detected');
    if (!await clickFirst(page, ['button:has-text("LOGIN")','button:has-text("Log in")','button:has-text("Login")','input[type="submit"]'])) throw new Error('RateLoc login button could not be detected');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
    const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
    if (/invalid password|invalid credentials|incorrect password|login failed/i.test(bodyText)) throw new Error('RateLoc login was rejected');
    if (!await fillFirst(page, ['input[placeholder="Search"]','input[placeholder*="hotel name or area" i]','input[placeholder*="search for a hotel" i]','input[placeholder*="location" i]','input[name*="location" i]','input[name*="destination" i]','input[id*="location" i]','input[id*="destination" i]'], search.destination)) throw new Error('RateLoc location field could not be detected');
    await page.waitForTimeout(400);
    await setDateRange(page, search.checkin, search.checkout);
    await setPassengers(page, search.guests, search.rooms || 1);
    if (!await clickFirst(page, ['button:has-text("SEARCH")','button:has-text("Search")','button[type="submit"]','input[value*="Search" i]'])) throw new Error('RateLoc search button could not be detected');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(6000);
    await expandMorePricesAndBoards(page);
    await page.waitForTimeout(1000);
    const rows = await extractRateLocResults(page);
    const results = rows.map((r, i) => ({
      id: `${source.id}-${i}`,
      supplier: source.name || 'RateLoc',
      hotel: r.hotel || 'Hotel',
      room: r.room || '',
      view: r.view || '',
      board: r.board || search.board || '',
      cancellation: r.cancellation || '',
      price: Number.isFinite(Number(r.price)) ? Number(r.price) : NaN,
      currency: r.currency || 'USD',
      availability: r.availability || 'Available',
      image: '',
      bookingUrl: '',
      raw: r.raw || r
    })).filter(r => r.hotel !== 'Hotel' || r.room || Number.isFinite(r.price));
    return { configured: true, results, error: null };
  } catch (e) {
    return { configured: true, results: [], error: e.name === 'TimeoutError' ? 'RateLoc browser timed out' : e.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { searchRateLocSource };

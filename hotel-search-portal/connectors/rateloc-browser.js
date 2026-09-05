const { chromium } = require('playwright');

let persistentContext = null;
let rateLocPage = null;
let loginWait = null;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseDateForDisplay(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

async function firstVisible(frame, selectors) {
  for (const selector of selectors) {
    const loc = frame.locator(selector).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

async function fillFirst(frame, selectors, value) {
  const loc = await firstVisible(frame, selectors);
  if (!loc) return false;
  try { await loc.fill(String(value)); return true; } catch { return false; }
}

async function clickFirst(frame, selectors) {
  const loc = await firstVisible(frame, selectors);
  if (!loc) return false;
  try { await loc.click(); return true; } catch { return false; }
}

function dashboardLooksAuthenticated(text, url) {
  return /Accommodation/i.test(text) && (/Dashboard/i.test(text) || /dashboard/i.test(url || ''));
}

async function ensureRateLocSession() {
  if (rateLocPage && !rateLocPage.isClosed()) {
    const text = clean(await rateLocPage.locator('body').innerText().catch(() => ''));
    if (dashboardLooksAuthenticated(text, rateLocPage.url())) return rateLocPage;
  }

  if (!persistentContext) {
    persistentContext = await chromium.launchPersistentContext('', {
      headless: false,
      viewport: { width: 1440, height: 1200 },
      locale: 'en-US'
    });
    persistentContext.on('page', page => {
      rateLocPage = page;
    });
  }

  rateLocPage = persistentContext.pages()[0] || await persistentContext.newPage();
  await rateLocPage.goto('https://www.rateloc.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const currentText = clean(await rateLocPage.locator('body').innerText().catch(() => ''));
  if (dashboardLooksAuthenticated(currentText, rateLocPage.url())) return rateLocPage;

  if (!loginWait) {
    loginWait = (async () => {
      // One-time manual login in the visible RateLoc browser window.
      // We never type, capture, or transmit the supplier password.
      const started = Date.now();
      while (Date.now() - started < 180000) {
        const text = clean(await rateLocPage.locator('body').innerText().catch(() => ''));
        if (dashboardLooksAuthenticated(text, rateLocPage.url())) return true;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error('RateLoc manual login timed out. Please log in once in the RateLoc browser window.');
    })().finally(() => { loginWait = null; });
  }

  await loginWait;
  return rateLocPage;
}

async function setDateRange(page, checkin, checkout) {
  const values = [
    `${parseDateForDisplay(checkin)} - ${parseDateForDisplay(checkout)}`,
    `${parseDateForDisplay(checkin)} – ${parseDateForDisplay(checkout)}`,
    `${checkin} - ${checkout}`,
    `${checkin} – ${checkout}`
  ];
  const selectors = [
    'input[placeholder*="date" i]', 'input[placeholder*="check" i]',
    'input[name*="date" i]', 'input[id*="date" i]',
    'input[name*="check" i]', 'input[id*="check" i]'
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const loc = frame.locator(selector).first();
      if (!(await loc.count().catch(() => 0)) || !(await loc.isVisible().catch(() => false))) continue;
      try {
        await loc.click();
        for (const value of values) {
          try {
            await loc.fill(value);
            if ((await loc.inputValue().catch(() => '')) === value) { await loc.press('Tab').catch(() => {}); return true; }
          } catch {}
        }
      } catch {}
    }
  }
  return false;
}

async function setPassengers(page, guests, rooms) {
  const selectors = [
    '[aria-label*="passenger" i]', '[aria-label*="guest" i]',
    '[placeholder*="passenger" i]', '[placeholder*="guest" i]'
  ];
  for (const frame of page.frames()) {
    const label = await firstVisible(frame, ['text=Passengers', 'text=Guests']);
    if (!label) continue;
    try { await label.click(); } catch {}
    await page.waitForTimeout(250);
    const nums = frame.locator('input[type="number"]');
    const count = await nums.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const loc = nums.nth(i);
      const meta = `${await loc.getAttribute('name').catch(() => '')} ${await loc.getAttribute('id').catch(() => '')} ${await loc.getAttribute('aria-label').catch(() => '')} ${await loc.getAttribute('placeholder').catch(() => '')}`.toLowerCase();
      if (/room/.test(meta)) await loc.fill(String(rooms)).catch(() => {});
      else if (/adult|guest|passenger/.test(meta)) await loc.fill(String(guests)).catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    return true;
  }
  // RateLoc defaults to 2 adults / 1 room in the visible portal; keep those values when no editable popup is exposed.
  return selectors.length > 0;
}

async function expandMorePricesAndBoards(page) {
  const selectors = [
    'button:has-text("More Prices & Boards")',
    'button:has-text("More Prices")',
    'text=More Prices & Boards',
    'text=More Prices'
  ];
  for (let pass = 0; pass < 4; pass++) {
    let clicked = false;
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const loc = frame.locator(selector);
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
    }
    if (!clicked) break;
  }
}

async function scrollResults(page) {
  let previousHeight = 0;
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
    const height = await page.evaluate(() => document.body.scrollHeight).catch(() => previousHeight);
    if (height === previousHeight) break;
    previousHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function extractRateLocResults(page) {
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.\d{1,2})?/i;
    const boardRe = /\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|ultra all inclusive|with breakfast|no meal)\b/i;
    const cancelRe = /\b(non.?refundable|free cancellation|cancellation|cancel(?:l)?ation policy|refundable)\b/i;
    const roomRe = /\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;
    const viewRe = /\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;
    const availabilityRe = /\b(available|rooms? left|on request|sold out)\b/i;
    const genericRe = /^(quote|view currencies|more prices.*|recommended|dashboard|results|breakfast)$/i;
    const seen = new Set();
    const out = [];

    const priceNodes = Array.from(document.querySelectorAll('body *')).filter(el => {
      const direct = clean(el.children.length ? el.childNodes && Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') : el.textContent);
      return priceRe.test(direct) || (el.children.length === 0 && priceRe.test(clean(el.textContent)));
    });

    for (const node of priceNodes) {
      let root = node;
      for (let depth = 0; depth < 8 && root.parentElement; depth++) {
        const raw = clean(root.innerText);
        if (raw.length >= 90 && raw.length <= 1500 && priceRe.test(raw)) break;
        root = root.parentElement;
      }
      const raw = clean(root.innerText);
      if (!raw || raw.length > 1600 || !priceRe.test(raw)) continue;
      const key = raw.slice(0, 1400);
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = (root.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const priceMatch = raw.match(priceRe);
      if (!priceMatch) continue;

      const hotel = lines.find(x => x.length >= 3 && x.length <= 120 && !priceRe.test(x) && !boardRe.test(x) && !cancelRe.test(x) && !viewRe.test(x) && !roomRe.test(x) && !genericRe.test(x)) || lines[0] || 'Hotel';
      const room = lines.find(x => roomRe.test(x) && !priceRe.test(x) && !boardRe.test(x) && !viewRe.test(x)) || '';
      const view = lines.find(x => viewRe.test(x) && !cancelRe.test(x)) || '';
      const board = lines.find(x => boardRe.test(x)) || '';
      const cancellation = lines.find(x => cancelRe.test(x)) || '';
      const availability = lines.find(x => availabilityRe.test(x)) || 'Available';
      const currency = (priceMatch[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i) || ['USD'])[0].replace('US$', 'USD').replace('$', 'USD');
      const price = Number(priceMatch[0].replace(/[^0-9.]/g, ''));
      out.push({ hotel, room, view, board, cancellation, availability, price, currency, raw });
    }

    return out.slice(0, 1000);
  });
}

async function searchRateLocSource(source, search) {
  if (!source.login_url || !source.site_username) return { configured: false, results: [], error: null };

  let page;
  try {
    page = await ensureRateLocSession();
    page.setDefaultTimeout(15000);

    const isDashboard = dashboardLooksAuthenticated(clean(await page.locator('body').innerText().catch(() => '')), page.url());
    if (!isDashboard) return { configured: true, results: [], error: 'RateLoc session is not authenticated' };

    const destination = await fillFirst(page.mainFrame(), [
      'input[placeholder="Search"]',
      'input[placeholder*="hotel name or area" i]',
      'input[placeholder*="search for a hotel" i]',
      'input[placeholder*="location" i]',
      'input[name*="location" i]',
      'input[name*="destination" i]'
    ], search.destination);
    if (!destination) throw new Error('RateLoc location field could not be detected on dashboard');

    await page.waitForTimeout(500);
    await setDateRange(page, search.checkin, search.checkout);
    await setPassengers(page, search.guests, search.rooms || 1);

    if (!await clickFirst(page.mainFrame(), ['button:has-text("SEARCH")','button:has-text("Search")','button[type="submit"]'])) {
      throw new Error('RateLoc search button could not be detected on dashboard');
    }

    await page.waitForTimeout(6500);
    await expandMorePricesAndBoards(page);
    await scrollResults(page);
    await page.waitForTimeout(800);

    const rows = await extractRateLocResults(page);
    const results = rows.map((r, i) => ({
      id: `${source.id}-${i}`,
      supplier: 'RateLoc',
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
    return { configured: true, results: [], error: e.name === 'TimeoutError' ? 'RateLoc timed out' : e.message };
  }
}

process.once('exit', () => { persistentContext?.close().catch?.(() => {}); });
process.once('SIGINT', async () => { await persistentContext?.close().catch(() => {}); process.exit(0); });
process.once('SIGTERM', async () => { await persistentContext?.close().catch(() => {}); process.exit(0); });

module.exports = { searchRateLocSource };

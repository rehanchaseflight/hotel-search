const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/i;
const DEFAULT_LOGIN_FRAME_URL = 'https://iolglobalb2bcloudssl.iolcloud.com/login.aspx?SourceXid=MTE3NTNTM=';

const frames = page => page.frames();

async function visible(frame, selector) {
  try {
    const x = frame.locator(selector).first();
    if (await x.count() && await x.isVisible()) return x;
  } catch {}
  return null;
}

async function blocked(page) {
  let text = '';
  for (const frame of frames(page)) {
    text += ' ' + clean(await frame.locator('body').innerText().catch(() => ''));
  }
  if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)) {
    throw new Error('Supplier presented a security verification step; automated bypass is not supported');
  }
}

async function loggedIn(page) {
  let text = '';
  for (const frame of frames(page)) {
    text += ' ' + clean(await frame.locator('body').innerText().catch(() => ''));
  }
  return /welcome\b|\blogout\b/i.test(text);
}

async function findFrame(page, selector) {
  for (const frame of frames(page)) {
    try {
      if (await frame.locator(selector).count()) return frame;
    } catch {}
  }
  return null;
}

async function login(page, source, password, cfg) {
  const end = Date.now() + (Number(cfg.login_frame_timeout_ms) || 30000);
  let frame = null;

  while (!frame && Date.now() < end) {
    frame = await findFrame(page, '#tbUserName');
    if (!frame) {
      const n = await page.locator('iframe').count().catch(() => 0);
      for (let i = 0; i < n && !frame; i++) {
        try {
          const child = page.locator('iframe').nth(i).contentFrame();
          if (child && await child.locator('#tbUserName').count()) frame = child;
        } catch {}
      }
    }
    if (!frame) frame = frames(page).find(f => /login\.aspx/i.test(f.url())) || null;
    if (!frame) await page.waitForTimeout(500);
  }

  if (!frame) {
    try {
      await page.goto(cfg.login_frame_url || DEFAULT_LOGIN_FRAME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await page.waitForTimeout(1500);
    } catch {}
    frame = await findFrame(page, '#tbUserName');
  }

  if (!frame) {
    if (await loggedIn(page)) return;
    throw new Error('Hadaf login iframe/fields could not be detected');
  }

  const user = await visible(frame, '#tbUserName') || frame.locator('#tbUserName').first();
  const pass = await visible(frame, '#tbPassword') || frame.locator('#tbPassword').first();
  const terms = await visible(frame, '#chkTermCondn') || frame.locator('#chkTermCondn').first();
  const button = await visible(frame, '#btnLogin1') || frame.locator('#btnLogin1').first();

  await user.fill(String(source.site_username || ''));
  await pass.fill(String(password || ''));
  if (await terms.count().catch(() => 0) && !(await terms.isChecked().catch(() => false))) {
    await terms.check().catch(() => {});
  }
  await button.click({ timeout: 10000 });
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 5000);
  await blocked(page);

  if (!await loggedIn(page)) {
    throw new Error('Hadaf login was submitted but the portal did not show a logged-in state');
  }
}

async function openHadaf(source) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) {
    return { configured: false, live: false, error: 'Hadaf credentials are not configured' };
  }

  let password;
  try {
    password = decrypt(source.site_password_enc);
  } catch (e) {
    return { configured: true, live: false, error: `Credential decryption failed: ${e.message}` };
  }

  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);
    await page.goto(source.login_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(Number(cfg.initial_wait_ms) || 2000);
    await blocked(page);
    await login(page, source, password, cfg);
    return { configured: true, live: true, page, context, browser };
  } catch (e) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    return { configured: true, live: false, error: e.name === 'TimeoutError' ? 'Hadaf browser timed out' : e.message };
  }
}

async function healthHadafSource(source) {
  const result = await openHadaf(source);
  if (result.context) await result.context.close().catch(() => {});
  if (result.browser) await result.browser.close().catch(() => {});
  return { configured: result.configured, live: result.live, error: result.error || null };
}

async function findSearchPage(context, cfg) {
  const end = Date.now() + (Number(cfg.search_page_timeout_ms) || 30000);
  while (Date.now() < end) {
    for (const page of context.pages()) {
      for (const frame of frames(page)) {
        const text = clean(await frame.locator('body').innerText().catch(() => ''));
        if (/Destination City\s*\/\s*Zone|Hotel Search/i.test(text)) return page;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return context.pages()[context.pages().length - 1] || null;
}

async function fieldByLabel(page, label, kind) {
  for (const frame of frames(page)) {
    const labels = frame.getByText(label, { exact: false });
    const count = await labels.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const labelNode = labels.nth(i);
      const paths = kind === 'select'
        ? ['xpath=following::select[1]', 'xpath=..//select[1]']
        : ['xpath=following::input[1]', 'xpath=..//input[1]'];
      for (const path of paths) {
        try {
          const x = labelNode.locator(path).first();
          if (await x.count() && await x.isVisible()) return x;
        } catch {}
      }
    }
  }
  return null;
}

async function firstVisible(page, selectors) {
  for (const frame of frames(page)) {
    for (const selector of selectors.filter(Boolean)) {
      const x = await visible(frame, selector);
      if (x) return x;
    }
  }
  return null;
}

function date(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || '');
}

async function fillField(page, label, value, selectors) {
  const x = await fieldByLabel(page, label, 'input') || await firstVisible(page, selectors);
  if (!x) return false;
  try {
    await x.fill(String(value));
    await x.press('Tab').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function selectField(page, label, value, selectors) {
  const x = await fieldByLabel(page, label, 'select') || await firstVisible(page, selectors);
  if (!x) return false;
  try {
    await x.selectOption({ label: String(value) });
    return true;
  } catch {
    try {
      await x.selectOption(String(value));
      return true;
    } catch {
      return false;
    }
  }
}

async function searchPortal(page, search, cfg) {
  const destination = await fillField(page, 'Destination City / Zone', search.destination, [
    cfg.destination_selector,
    'input[name*="destination" i]',
    'input[id*="destination" i]'
  ]);
  if (!destination) throw new Error('Hadaf destination field could not be detected');

  const ci = await fillField(page, 'Check-in Date', date(search.checkin), [
    cfg.checkin_selector,
    'input[name*="checkin" i]',
    'input[id*="checkin" i]',
    'input[name*="arrival" i]',
    'input[id*="arrival" i]'
  ]);
  const co = await fillField(page, 'Check-out Date', date(search.checkout), [
    cfg.checkout_selector,
    'input[name*="checkout" i]',
    'input[id*="checkout" i]',
    'input[name*="departure" i]',
    'input[id*="departure" i]'
  ]);
  if (!ci || !co) throw new Error('Hadaf check-in/check-out fields could not be detected');

  await selectField(page, 'Room/s', search.rooms || 1, [cfg.rooms_selector, 'select[name*="room" i]', 'select[id*="room" i]']);
  await selectField(page, 'Room 1 Adults', search.guests || 2, [cfg.guests_selector, 'select[name*="adult" i]', 'select[id*="adult" i]']);

  const button = await firstVisible(page, [
    cfg.search_button_selector,
    'button:has-text("Search")',
    'input[value*="search" i]',
    'a:has-text("Search")',
    'input[type="submit"]'
  ]);
  if (!button) throw new Error('Hadaf search button could not be detected');
  await button.click({ timeout: 10000 });
}

function parseRate(text, defaultCurrency = 'AED') {
  const value = clean(text);
  const match = value.match(PRICE_RE);
  if (!match) return null;
  const numberMatch = clean(match[0]).match(/[0-9][0-9,]*(?:\.[0-9]{1,2})?/);
  const price = Number(numberMatch?.[0]?.replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return null;
  const currency = (match[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i) || [defaultCurrency])[0];
  return {
    price,
    currency: clean(currency),
    room: clean((value.match(/(?:Triple|Twin|Double|Single|Quadruple|Family|Deluxe|Standard|Superior|King|Queen|Suite|Apartment|Villa)[^|]*?(?:Room|Suite|Bed|Only|Included)?/i) || [''])[0]),
    board: clean((value.match(/Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i) || [''])[0]),
    cancellation: clean((value.match(/Non[- ]?refundable|Free Cancellation|Refundable/i) || [''])[0]),
    availability: clean((value.match(/Available|On Request|Sold Out|Not Available/i) || ['Available'])[0]),
    raw: value
  };
}

function hotelLike(text) {
  return text.length >= 4 && text.length <= 180 && !PRICE_RE.test(text) && /hotel|resort|suites|residence|makkah|madinah|riyadh|jeddah/i.test(text);
}

async function extractFrame(frame, cfg) {
  const body = await frame.locator('body').innerText().catch(() => '');
  const lines = String(body).split(/\r?\n/).map(clean).filter(Boolean);
  const output = [];

  for (let i = 0; i < lines.length; i++) {
    if (!PRICE_RE.test(lines[i])) continue;
    const rate = parseRate(lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 7)).join(' | '), cfg.default_currency || 'AED');
    if (!rate) continue;
    let hotel = '';
    for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
      if (hotelLike(lines[j])) {
        hotel = lines[j];
        break;
      }
    }
    output.push({ hotel, ...rate });
  }

  return output;
}

async function extract(context, cfg) {
  const all = [];
  for (const page of context.pages()) {
    for (const frame of frames(page)) all.push(...await extractFrame(frame, cfg));
  }
  const seen = new Set();
  return all.filter(rate => rate.price > 0).filter(rate => {
    const key = [rate.hotel, rate.room, rate.board, rate.price, rate.currency, rate.cancellation].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Number(cfg.max_results) || 500);
}

async function hasResults(context) {
  for (const page of context.pages()) {
    for (const frame of frames(page)) {
      const text = clean(await frame.locator('body').innerText().catch(() => ''));
      if (/Hotels In|Room Type|Dynamic Inventory|Non-refundable/i.test(text)) return true;
    }
  }
  return false;
}

async function searchHadafSource(source, search) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) {
    return { configured: false, results: [], error: null };
  }

  let password;
  try {
    password = decrypt(source.site_password_enc);
  } catch (e) {
    return { configured: true, results: [], error: `Credential decryption failed: ${e.message}` };
  }

  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const loginPage = await context.newPage();
    loginPage.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);
    await loginPage.goto(source.login_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await loginPage.waitForTimeout(Number(cfg.initial_wait_ms) || 2000);
    await blocked(loginPage);
    await login(loginPage, source, password, cfg);

    const page = await findSearchPage(context, cfg);
    if (!page) throw new Error('Hadaf search page could not be detected');
    await searchPortal(page, search, cfg);

    const end = Date.now() + (Number(cfg.results_wait_ms) || 20000);
    while (Date.now() < end && !(await hasResults(context))) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await blocked(page);
    const results = (await extract(context, cfg)).map((rate, i) => ({
      id: `${source.id}-${i}`,
      supplier: source.name,
      hotel: rate.hotel || 'Hotel',
      room: rate.room || '',
      view: rate.view || '',
      board: rate.board || search.board || '',
      cancellation: rate.cancellation || '',
      price: Number(rate.price),
      currency: rate.currency || cfg.default_currency || 'AED',
      availability: rate.availability || 'Available',
      raw: rate.raw || rate,
      image: '',
      bookingUrl: ''
    }));

    if (!results.length) return { configured: true, results: [], error: 'Hadaf login/search completed but no priced rates were extracted' };
    return { configured: true, results, error: null };
  } catch (e) {
    return { configured: true, results: [], error: e.name === 'TimeoutError' ? 'Hadaf browser timed out' : e.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { searchHadafSource, healthHadafSource };

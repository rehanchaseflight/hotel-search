const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function num(v) {
  const m = clean(v).replace(/,/g, '').match(/(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  return m ? Number(m[1]) : NaN;
}
async function frames(page) { return page.frames(); }
async function visible(frame, selector) {
  try { const l = frame.locator(selector).first(); if (await l.count() && await l.isVisible()) return l; } catch {}
  return null;
}
async function findInFrames(page, selectors) {
  for (const frame of await frames(page)) {
    for (const selector of selectors) {
      const l = await visible(frame, selector);
      if (l) return l;
    }
  }
  return null;
}
async function frameWith(page, selector) {
  for (const frame of await frames(page)) {
    if (await frame.locator(selector).count().catch(() => 0)) return frame;
  }
  return null;
}
async function inputMeta(frame) {
  const out = [];
  const inputs = frame.locator('input:visible, textarea:visible, select:visible');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    out.push({
      el,
      type: (await el.getAttribute('type').catch(() => '')) || '',
      name: (await el.getAttribute('name').catch(() => '')) || '',
      id: (await el.getAttribute('id').catch(() => '')) || '',
      placeholder: (await el.getAttribute('placeholder').catch(() => '')) || '',
      value: (await el.getAttribute('value').catch(() => '')) || ''
    });
  }
  return out;
}
async function findRanked(page, purpose) {
  const rows = [];
  for (const frame of await frames(page)) {
    for (const x of await inputMeta(frame)) {
      const meta = `${x.type} ${x.name} ${x.id} ${x.placeholder} ${x.value}`.toLowerCase();
      let score = 0;
      if (purpose === 'destination') {
        if (/destination|location|city|hotel|property|going to|where/.test(meta)) score += 40;
        if (/date|check|guest|room|nationality|promo/.test(meta)) score -= 15;
      }
      if (purpose === 'checkin') {
        if (/check.?in|arrival|from|start/.test(meta)) score += 50;
        else if (/date/.test(meta)) score += 10;
      }
      if (purpose === 'checkout') {
        if (/check.?out|departure|to|end/.test(meta)) score += 50;
        else if (/date/.test(meta)) score += 10;
      }
      if (purpose === 'guests') {
        if (/adult|guest|travell?er|pax/.test(meta)) score += 40;
        if (/room/.test(meta)) score -= 10;
      }
      if (purpose === 'rooms') {
        if (/room/.test(meta)) score += 40;
      }
      if (score > 0) rows.push({ ...x, score, frame });
    }
  }
  return rows.sort((a, b) => b.score - a.score)[0] || null;
}
async function blocked(page) {
  let body = '';
  for (const f of await frames(page)) body += ' ' + clean(await f.locator('body').innerText().catch(() => ''));
  if (/captcha|verify you are human|access denied|unusual traffic|security check|enable javascript and cookies/i.test(body)) {
    throw new Error('Supplier presented a security verification step; automated bypass is not supported');
  }
}
async function login(page, source, password, cfg) {
  let loginFrame = await frameWith(page, '#tbUserName');
  if (!loginFrame) {
    await page.waitForTimeout(1500);
    loginFrame = await frameWith(page, '#tbUserName');
  }
  if (!loginFrame) throw new Error('Hadaf login iframe could not be detected');

  const user = await visible(loginFrame, '#tbUserName');
  const pass = await visible(loginFrame, '#tbPassword');
  const terms = await visible(loginFrame, '#chkTermCondn');
  const button = await visible(loginFrame, '#btnLogin1');
  if (!user || !pass || !button) throw new Error('Hadaf login fields could not be detected');

  await user.fill(String(source.site_username || ''));
  await pass.fill(String(password || ''));
  if (terms && !(await terms.isChecked().catch(() => false))) await terms.check().catch(() => {});

  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }),
    button.click({ timeout: 10000 })
  ]);
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 5000);
  await blocked(page);
}
async function fillField(page, purpose, value, selectors) {
  const direct = await findInFrames(page, selectors || []);
  const ranked = direct ? { el: direct } : await findRanked(page, purpose);
  if (!ranked) return false;
  try { await ranked.el.fill(String(value)); await ranked.el.press('Tab').catch(() => {}); return true; } catch { return false; }
}
async function search(page, search, cfg) {
  if (cfg.search_url_template) {
    const url = String(cfg.search_url_template)
      .replaceAll('{destination}', encodeURIComponent(search.destination))
      .replaceAll('{checkin}', search.checkin)
      .replaceAll('{checkout}', search.checkout)
      .replaceAll('{guests}', String(search.guests))
      .replaceAll('{rooms}', String(search.rooms || 1));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return;
  }

  const destination = await fillField(page, 'destination', search.destination, [cfg.destination_selector, '#txtDestination', 'input[name*="destination" i]', 'input[id*="destination" i]'].filter(Boolean));
  if (!destination) throw new Error('Hadaf destination field could not be detected');
  const checkin = await fillField(page, 'checkin', search.checkin, [cfg.checkin_selector, 'input[name*="checkin" i]', 'input[id*="checkin" i]', 'input[name*="arrival" i]', 'input[id*="arrival" i]'].filter(Boolean));
  const checkout = await fillField(page, 'checkout', search.checkout, [cfg.checkout_selector, 'input[name*="checkout" i]', 'input[id*="checkout" i]', 'input[name*="departure" i]', 'input[id*="departure" i]'].filter(Boolean));
  if (!checkin || !checkout) throw new Error('Hadaf check-in/check-out fields could not be detected');
  await fillField(page, 'guests', search.guests, [cfg.guests_selector, 'input[name*="adult" i]', 'input[id*="adult" i]', 'input[name*="guest" i]', 'input[id*="guest" i]'].filter(Boolean));
  await fillField(page, 'rooms', search.rooms || 1, [cfg.rooms_selector, 'input[name*="room" i]', 'input[id*="room" i]'].filter(Boolean));

  const button = await findInFrames(page, [cfg.search_button_selector, '#btnSearch', 'input[value*="search" i]', 'button:has-text("Search")', 'input[type="submit"]', 'button[type="submit"]'].filter(Boolean));
  if (!button) throw new Error('Hadaf search button could not be detected');
  await button.click({ timeout: 10000 });
}
async function extract(page, cfg) {
  const out = [];
  const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
  for (const frame of await frames(page)) {
    if (cfg.result_row_selector) {
      try {
        const rows = await frame.locator(cfg.result_row_selector).evaluateAll((nodes, c) => nodes.slice(0, Number(c.max_results) || 500).map((root, i) => {
          const get = s => { if (!s) return ''; const e = root.querySelector(s); return e ? String(e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
          return { index: i, hotel: get(c.hotel_selector), room: get(c.room_selector), view: get(c.view_selector), board: get(c.board_selector), price: get(c.price_selector), currency: get(c.currency_selector), cancellation: get(c.cancellation_selector), availability: get(c.availability_selector) };
        }), cfg);
        for (const r of rows) { const p = num(r.price); if (Number.isFinite(p) && p > 0) out.push({ ...r, price: p }); }
      } catch {}
    }

    const text = clean(await frame.locator('body').innerText().catch(() => ''));
    if (!text) continue;
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!priceRe.test(lines[i])) continue;
      const raw = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 8)).join(' | ');
      const p = num(lines[i]);
      if (!Number.isFinite(p) || p <= 0) continue;
      const currency = (lines[i].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i) || [])[0] || '';
      out.push({ hotel: lines[i - 5] || 'Hotel', room: '', view: '', board: '', cancellation: '', availability: 'Available', price: p, currency, raw });
    }
  }
  const seen = new Set();
  return out.filter(r => {
    const key = `${r.hotel}|${r.room}|${r.view}|${r.board}|${r.price}|${r.currency}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, Number(cfg.max_results) || 500);
}
async function searchHadafSource(source, search) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) return { configured: false, results: [], error: null };
  let password;
  try { password = decrypt(source.site_password_enc); } catch (e) { return { configured: true, results: [], error: `Credential decryption failed: ${e.message}` }; }

  let browser, context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);
    await page.goto(source.login_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await login(page, source, password, cfg);
    await search(page, search, cfg);
    if (cfg.results_wait_for_selector) {
      const r = await findInFrames(page, [cfg.results_wait_for_selector]);
      if (r) await r.waitFor({ state: 'visible', timeout: Number(cfg.results_timeout_ms) || 20000 });
    } else {
      await page.waitForTimeout(Number(cfg.results_wait_ms) || 6000);
    }
    await blocked(page);
    const rows = await extract(page, cfg);
    const results = rows.filter(r => Number.isFinite(Number(r.price)) && Number(r.price) > 0).map((r, i) => ({
      id: `${source.id}-${i}`, supplier: source.name, hotel: r.hotel || 'Hotel', room: r.room || '', view: r.view || '', board: r.board || search.board || '', cancellation: r.cancellation || '', price: Number(r.price), currency: r.currency || cfg.default_currency || '', availability: r.availability || 'Available', raw: r.raw || r, image: '', bookingUrl: ''
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
module.exports = { searchHadafSource };

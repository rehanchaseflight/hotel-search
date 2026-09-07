const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

const HOME_URL = 'https://wanderbeds.com/?setlang=en';
const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/i;
const BOARD_RE = /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;
const CANCEL_RE = /Non[- ]?refundable|Free Cancellation|Refundable/i;
const ROOM_RE = /((?:Double|Twin|Triple|Quadruple|Quintuple|Family|Standard|Deluxe|Superior|King|Queen|Single)[A-Za-z0-9 /-]{1,100}?)\s*-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const date = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || ''); };

function price(text) {
  const m = clean(text).match(PRICE_RE); if (!m) return null;
  const n = Number(m[0].replace(/[^0-9.]/g, '')); if (!(n > 0)) return null;
  const c = m[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
  return { price: n, currency: c ? c[0].toUpperCase() : 'AED' };
}
function room(text) { const m = clean(text).match(ROOM_RE); return m ? clean(m[1]) : ''; }
function board(text) { const m = clean(text).match(BOARD_RE); return m ? clean(m[0]) : ''; }
function cancellation(text) { const m = clean(text).match(CANCEL_RE); return m ? clean(m[0]) : ''; }
function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => { const k = [norm(r.hotel), norm(r.room), norm(r.board), norm(r.cancellation), Number(r.price).toFixed(2), norm(r.currency)].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function bodyText(page) { return clean(await page.locator('body').innerText().catch(() => '')); }
async function blocked(page) {
  const text = await bodyText(page);
  if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)) throw new Error('WanderBeds presented a security verification step; automated bypass is not supported');
}

async function clickAgentLogin(page) {
  const candidates = [
    page.getByText(/^Agent Login$/i),
    page.getByRole('link', { name: /Agent Login/i }),
    page.getByRole('button', { name: /Agent Login/i })
  ];
  for (const locator of candidates) {
    if (await locator.count().catch(() => 0) && await locator.first().isVisible().catch(() => false)) {
      await locator.first().click().catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function login(page, source, password, cfg) {
  await clickAgentLogin(page);
  const end = Date.now() + (Number(cfg.login_timeout_ms) || 30000);
  let form = null;
  while (!form && Date.now() < end) {
    for (const frame of page.frames()) {
      const agent = frame.locator('input').filter({ has: undefined });
      const inputs = await frame.locator('input').count().catch(() => 0);
      if (inputs >= 3) {
        const texts = await frame.locator('input').evaluateAll((els) => els.map((e) => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder }))).catch(() => []);
        if (texts.some((x) => /agent/i.test(`${x.name} ${x.id} ${x.placeholder}`)) && texts.some((x) => x.type === 'password')) { form = frame; break; }
      }
    }
    if (!form) await page.waitForTimeout(300);
  }
  if (!form) throw new Error('WanderBeds Agent Login form could not be detected');

  const fields = await form.locator('input').evaluateAll((els) => els.map((e) => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, value: e.value })));
  const agentField = form.locator('input').filter({ hasText: '' });
  const find = async (regex, type) => {
    const all = form.locator('input');
    const count = await all.count();
    for (let i = 0; i < count; i++) {
      const el = all.nth(i); const meta = fields[i] || {};
      if ((!type || meta.type === type) && regex.test(`${meta.name || ''} ${meta.id || ''} ${meta.placeholder || ''}`)) return el;
    }
    return null;
  };
  const agent = await find(/agent.*code|agentcode/i, 'text') || await find(/agent.*code|agentcode/i);
  const username = await find(/user.?name|username|login/i, 'text') || await find(/user.?name|username|login/i);
  const pass = await find(/password|pass/i, 'password') || await find(/password|pass/i);
  if (!agent || !username || !pass) throw new Error('WanderBeds login fields could not be identified');

  await agent.fill(String(source.agent_code || source.site_agent_code || cfg.agent_code || ''));
  await username.fill(String(source.site_username || ''));
  await pass.fill(String(password || ''));

  const submit = form.getByRole('button', { name: /sign in|login/i }).first();
  if (await submit.count()) await submit.click({ noWaitAfter: true }).catch(() => {});
  else await form.locator('input[type="submit"],button[type="submit"]').first().click({ noWaitAfter: true }).catch(() => {});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 5000);
  await blocked(page);
}

async function findSearchPage(page, cfg) {
  if (cfg.search_page_url) {
    await page.goto(cfg.search_page_url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const end = Date.now() + (Number(cfg.search_page_timeout_ms) || 30000);
  while (Date.now() < end) {
    const text = await bodyText(page);
    if (/hotel|check.?in|check.?out|destination|going to|travellers/i.test(text)) return page;
    await page.waitForTimeout(500);
  }
  return page;
}

async function fillByLabel(page, labels, value) {
  for (const label of labels) {
    const loc = page.getByLabel(label, { exact: false }).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) { await loc.fill(String(value)); return true; }
  }
  return false;
}

async function fillSearch(page, search) {
  await fillByLabel(page, ['Going to', 'Destination City', 'Destination'], search.destination);
  await fillByLabel(page, ['Check-in Date', 'Check-in'], date(search.checkin));
  await fillByLabel(page, ['Check-out Date', 'Check-out'], date(search.checkout));
  await fillByLabel(page, ['Nationality', 'Country of Residence'], search.country || 'United States of America');
  const travellers = page.getByLabel(/Travellers/i).first();
  if (await travellers.count().catch(() => 0) && await travellers.isVisible().catch(() => false)) await travellers.click().catch(() => {});
  await page.waitForTimeout(300);
  const inputs = page.locator('input');
  const metas = await inputs.evaluateAll((els) => els.map((e) => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, value: e.value })));
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    if (/adult/i.test(`${m.name} ${m.id} ${m.placeholder}`) && /number|text/i.test(m.type)) await inputs.nth(i).fill(String(search.guests || 2)).catch(() => {});
    if (/child/i.test(`${m.name} ${m.id} ${m.placeholder}`) && /number|text/i.test(m.type)) await inputs.nth(i).fill(String(search.children || 0)).catch(() => {});
  }
  const searchButton = page.getByRole('button', { name: /^Search$/i }).first();
  if (await searchButton.count().catch(() => 0)) await searchButton.click({ noWaitAfter: true }).catch(() => {});
  else await page.getByText(/^Search$/i).first().click({ noWaitAfter: true }).catch(() => {});
}

async function extractResults(page, search, cfg) {
  await page.waitForTimeout(Number(cfg.results_wait_ms) || 10000);
  const text = await page.locator('body').innerText().catch(() => '');
  const lines = String(text).split(/\r?\n/).map(clean).filter(Boolean);
  const rows = [];
  let hotel = search.hotel_name || '';
  for (let i = 0; i < lines.length; i++) {
    const p = price(lines[i]);
    if (!p) continue;
    let context = lines.slice(Math.max(0, i - 8), Math.min(lines.length, i + 8)).join(' | ');
    let r = room(context);
    let b = board(context);
    let c = cancellation(context);
    const hotelLine = lines.slice(Math.max(0, i - 12), i + 1).reverse().find((x) => /hotel|resort|inn|suites|grand|makkah|madinah/i.test(x) && !price(x) && x.length < 120);
    if (hotelLine && !/^hotel$|^rooms?$|^search$/i.test(hotelLine)) hotel = hotel || hotelLine;
    if (r && b) rows.push({ hotel, room: r, view: '', board: b, cancellation: c, price: p.price, currency: p.currency, availability: /sold out|unavailable|no availability/i.test(context) ? 'Unavailable' : 'Available', supplier: 'WanderBeds' });
  }
  return dedupe(rows).filter((r) => r.price > 0 && r.room && r.board).slice(0, Number(cfg.max_results) || 1000);
}

async function searchWanderBedsSource(source, search) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc || !(source.agent_code || source.site_agent_code || cfg.agent_code)) return { configured: false, results: [], error: 'WanderBeds requires login URL, agent code, username and encrypted password' };
  let password; try { password = decrypt(source.site_password_enc); } catch (error) { return { configured: true, results: [], error: `Credential decryption failed: ${error.message}` }; }
  let browser; let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);
    await page.goto(source.login_url || HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(Number(cfg.initial_wait_ms) || 3000); await blocked(page);
    await login(page, source, password, cfg);
    await findSearchPage(page, cfg);
    await fillSearch(page, search);
    const results = await extractResults(page, search, cfg);
    if (!results.length) throw new Error(`WanderBeds returned no complete priced hotel rates. URL: ${page.url()}`);
    return { configured: true, results, error: null };
  } catch (error) { return { configured: true, results: [], error: error.message || String(error) }; }
  finally { try { if (context) await context.close(); } catch (_) {} try { if (browser) await browser.close(); } catch (_) {} }
}
async function healthWanderBedsSource(source) { const r = await searchWanderBedsSource(source, { destination: 'Madinah - Saudi Arabia', checkin: '2026-10-02', checkout: '2026-10-03', nights: 1, rooms: 1, guests: 2, children: 0 }); return { configured: r.configured, live: !r.error && r.results.length > 0, error: r.error || null }; }
module.exports = { searchWanderBedsSource, healthWanderBedsSource };

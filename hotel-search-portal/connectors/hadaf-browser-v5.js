const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

const SEARCH_PAGE = 'https://iolglobalb2bcloudssl.iolcloud.com/HotelSearch.aspx?CallFrom=AWBE';
const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/i;
const BOARDS = /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const date = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || ''); };
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseDisplayedPrice(text, def = 'AED') { const m = clean(text).match(PRICE_RE); if (!m) return null; const q = m[0].replace(/,/g, '').match(/[0-9]+(?:\.[0-9]{1,2})?/); if (!q) return null; const n = Number(q[0]); if (!(n > 0)) return null; const cm = m[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i); return { price: n, currency: cm ? cm[0].toUpperCase() : def }; }
function board(text) { const m = clean(text).match(BOARDS); return m ? clean(m[0]) : ''; }
function cancel(text) { const m = clean(text).match(/Non[- ]?refundable|Free Cancellation|Refundable/i); return m ? clean(m[0]) : ''; }
function parseRoom(text) { let x = clean(text).replace(/^.*?Pax:\s*\d+A\d+C\s*/i, '').replace(/\s+(?:Non[- ]?refundable|Free Cancellation|Refundable|Package Rate|Show All Room Types|Live Search Results)\b.*$/i, ''); const m = x.match(/^(.+?)\s*-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i); return clean(m ? m[1] : x); }
function dedupe(rows) { const seen = new Set(); return rows.filter((r) => { const key = [norm(r.hotel), norm(r.room), norm(r.board), norm(r.cancellation), Number(r.price).toFixed(2), norm(r.currency)].join('|'); if (seen.has(key)) return false; seen.add(key); return true; }); }
async function bodyText(frame) { return clean(await frame.locator('body').innerText().catch(() => '')); }
async function blocked(page) { for (const frame of page.frames()) { const text = await bodyText(frame); if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)) throw new Error('Supplier presented a security verification step; automated bypass is not supported'); } }
async function findLoginFrame(page) { for (const frame of page.frames()) if (await frame.locator('#tbUserName').count().catch(() => 0)) return frame; return null; }
async function login(page, source, password, cfg) { let frame = null; const end = Date.now() + (Number(cfg.login_frame_timeout_ms) || 45000); while (!frame && Date.now() < end) { frame = await findLoginFrame(page); if (!frame) await page.waitForTimeout(500); } if (!frame) throw new Error('Hadaf login iframe could not be detected'); await frame.locator('#tbUserName').fill(String(source.site_username || '')); await frame.locator('#tbPassword').fill(String(password || '')); const terms = frame.locator('#chkTermCondn').first(); if (await terms.count() && !(await terms.isChecked().catch(() => false))) await terms.check().catch(() => {}); await frame.locator('#btnLogin1').click({ timeout: 10000, noWaitAfter: true }).catch(() => {}); await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 7000); }
async function searchForm(page) { const end = Date.now() + 30000; while (Date.now() < end) { for (const frame of page.frames()) { if (await frame.locator('#lpPannel_txtV5City').count().catch(() => 0) && await frame.locator('#lpPannel_txtFromDate').count().catch(() => 0)) return frame; } await page.waitForTimeout(300); } return null; }
async function chooseDestination(frame, value) { const input = frame.locator('#lpPannel_txtV5City').first(); await input.fill(clean(value)); await frame.waitForTimeout(1200); const pattern = new RegExp(escapeRegex(clean(value)), 'i'); const options = frame.locator('li:visible, [role="option"]:visible').filter({ hasText: pattern }); if (await options.count()) await options.first().click().catch(() => {}); else { await input.press('ArrowDown').catch(() => {}); await input.press('Enter').catch(() => {}); } await frame.waitForTimeout(500); }
async function fillSearch(frame, search) { const nationality = frame.locator('#lpPannel_sel_nationality'); if (await nationality.count()) await nationality.selectOption({ label: String(search.country || 'United States of America') }).catch(() => {}); await chooseDestination(frame, search.destination); await frame.locator('#lpPannel_txtFromDate').fill(date(search.checkin)); await frame.locator('#lpPannel_txtToDate').fill(date(search.checkout)); await frame.locator('#lpPannel_txtNights').fill(String(Math.max(1, Number(search.nights || 1)))); await frame.locator('#sel_NoOfRooms').selectOption(String(search.rooms || 1)).catch(() => {}); await frame.locator('#sel_NoOfAdult_1').selectOption(String(search.guests || 2)).catch(() => {}); await frame.locator('#sel_NoOfChild_1').selectOption(String(search.children ?? 0)).catch(() => {}); if (search.hotel_name) { const hotel = frame.locator('#lpPannel_txtHotel').first(); if (await hotel.count()) { const name = String(search.hotel_name); await hotel.evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, name).catch(() => {}); } } }
async function clickSearch(frame) { const searchLink = frame.locator('a#lpPannel_btnModifySearch').first(); if (!await searchLink.count()) throw new Error('Hadaf search button not found'); await searchLink.click({ timeout: 10000, noWaitAfter: true }); }
function flattenJson(value, out = []) { if (Array.isArray(value)) { value.forEach((item) => flattenJson(item, out)); return out; } if (!value || typeof value !== 'object') return out; if (value.n && value.rlst) for (const group of value.rlst || []) for (const rate of group.rdlst || []) out.push({ hotel: clean(value.n), room: clean(rate.rt), board: clean(rate.mp), cancellation: '', supplierRoomCode: clean(rate.ThirdPartyRoomCode), rateFrom: clean(rate.fd), rateTo: clean(rate.td) }); for (const key of Object.keys(value)) if (key !== 'rlst') flattenJson(value[key], out); return out; }
function captureJson(context, state) { context.on('response', async (response) => { try { if (/GetHotelsJson\.aspx/i.test(response.url()) && response.status() === 200) { state.json = flattenJson(JSON.parse(await response.text()), []); state.jsonResponse = true; } } catch (_) {} }); }
function matchJson(state, room, boardName, hotel) { if (!room && !boardName && !hotel) return null; let best = null; let score = -1; for (const item of state.json || []) { let value = 0; if (hotel && norm(item.hotel) === norm(hotel)) value += 20; if (room && norm(item.room) === norm(room)) value += 10; else if (room && (norm(item.room).includes(norm(room)) || norm(room).includes(norm(item.room)))) value += 6; if (boardName && norm(item.board) === norm(boardName)) value += 8; if (value > score) { score = value; best = item; } } return score > 0 ? best : null; }
function makeRate(search, best, room, boardName, price, cancellation = '') { return { hotel: search.hotel_name || best?.hotel || '', room, view: '', board: boardName, cancellation, price: price.price, currency: price.currency, availability: 'Available', supplier: 'Hadaf Holidays', supplierRoomCode: best?.supplierRoomCode || '', rateFrom: best?.rateFrom || '', rateTo: best?.rateTo || '' }; }
async function expandRooms(context) { for (const page of context.pages()) for (const frame of page.frames()) { const locator = frame.getByText(/Show All Room Types/i); const count = await locator.count().catch(() => 0); for (let i = 0; i < count; i++) if (await locator.nth(i).isVisible().catch(() => false)) await locator.nth(i).click({ noWaitAfter: true, timeout: 3000 }).catch(() => {}); } }

async function extractRendered(context, cfg, search, state) {
  const out = [];
  for (const page of context.pages()) for (const frame of page.frames()) {
    const links = frame.locator('a[href*="RatePopup"]');
    const count = await links.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const info = await link.evaluate((el) => {
        const priceRe = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/ig;
        const textOf = (n) => (n?.innerText || '').replace(/\s+/g, ' ').trim();
        const attrText = (n) => { if (!n || !n.getAttribute) return ''; return [n.getAttribute('alt'), n.getAttribute('title'), n.getAttribute('src'), n.getAttribute('href')].filter(Boolean).join(' '); };
        const candidates = [];
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const text = textOf(node);
          const prices = text.match(priceRe) || [];
          if (text) candidates.push(text);
          if (node.previousElementSibling) candidates.push(textOf(node.previousElementSibling));
          if (node.previousElementSibling?.previousElementSibling) candidates.push(textOf(node.previousElementSibling.previousElementSibling));
          if (node.parentElement?.previousElementSibling) candidates.push(textOf(node.parentElement.previousElementSibling));
          if (node.parentElement?.previousElementSibling?.previousElementSibling) candidates.push(textOf(node.parentElement.previousElementSibling.previousElementSibling));
          const attrs = attrText(node) + ' ' + Array.from(node.querySelectorAll ? node.querySelectorAll('img,a,span') : []).map(attrText).join(' ');
          if (prices.length === 1) candidates.push(`${text} ${attrs}`.trim());
        }
        return { anchor: textOf(el), candidates: candidates.filter(Boolean) };
      }).catch(() => ({ anchor: '', candidates: [] }));

      const price = parseDisplayedPrice(info.anchor);
      if (!price) continue;

      let room = '';
      let boardName = '';
      let cancellation = '';
      for (const candidate of info.candidates || []) {
        if (!boardName) boardName = board(candidate);
        if (!cancellation) cancellation = cancel(candidate);
        if (!room && /\s-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i.test(candidate)) room = parseRoom(candidate);
      }

      const best = matchJson(state, room, boardName, search.hotel_name || '');
      if (!room && best) room = best.room;
      if (!boardName && best) boardName = best.board;
      if (room && boardName) out.push(makeRate(search, best, room, boardName, price, cancellation));
    }
  }
  return dedupe(out).filter((item) => item.price > 0 && item.room && item.board).slice(0, Number(cfg.max_results) || 1000);
}

async function searchHadafSource(source, search) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) return { configured: false, results: [], error: null };
  let password; try { password = decrypt(source.site_password_enc); } catch (error) { return { configured: true, results: [], error: `Credential decryption failed: ${error.message}` }; }
  let browser; let context;
  try {
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const state = { json: [], jsonResponse: false }; captureJson(context, state);
    const page = await context.newPage(); page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);
    await page.goto(source.login_url, { waitUntil: 'commit', timeout: 60000 }); await page.waitForTimeout(Number(cfg.initial_wait_ms) || 3000); await blocked(page); await login(page, source, password, cfg);
    await page.goto(cfg.search_page_url || SEARCH_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await page.waitForTimeout(Number(cfg.search_page_wait_ms) || 2500);
    const frame = await searchForm(page); if (!frame) throw new Error(`Hadaf hotel search form could not be detected. URL: ${page.url()}`);
    await fillSearch(frame, search); await clickSearch(frame);
    const end = Date.now() + (Number(cfg.results_wait_ms) || 90000);
    while (Date.now() < end) { await blocked(page); if (state.jsonResponse && state.json.length) break; await new Promise((resolve) => setTimeout(resolve, 1000)); }
    if (!state.jsonResponse && !context.pages().some((p) => /HotelResults\.aspx/i.test(p.url()))) throw new Error(`Hadaf search did not return results. URL: ${page.url()}`);
    await page.waitForTimeout(Number(cfg.json_settle_wait_ms) || 10000); await expandRooms(context);
    const results = await extractRendered(context, cfg, search, state);
    if (!results.length) throw new Error(`Hadaf returned results but no complete priced rate elements were found. JSON rates: ${state.json.length}. URL: ${page.url()}`);
    return { configured: true, results, error: null };
  } catch (error) { return { configured: true, results: [], error: error.message || String(error) }; }
  finally { try { if (context) await context.close(); } catch (_) {} try { if (browser) await browser.close(); } catch (_) {} }
}

async function healthHadafSource(source) { try { const r = await searchHadafSource(source, { destination: 'Madinah - Saudi Arabia', checkin: '2026-10-02', checkout: '2026-10-03', nights: 1, rooms: 1, guests: 2, children: 0 }); return { configured: r.configured, live: !r.error && r.results.length > 0, error: r.error || null }; } catch (error) { return { configured: true, live: false, error: error.message || String(error) }; } }
module.exports = { searchHadafSource, healthHadafSource };

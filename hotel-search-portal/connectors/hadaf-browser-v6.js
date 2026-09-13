const { chromium } = require('playwright');
const { decrypt } = require('../crypto-util');

const SEARCH_PAGE = 'https://iolglobalb2bcloudssl.iolcloud.com/HotelSearch.aspx?CallFrom=AWBE';
const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/i;
const BOARD_RE = /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;
const CANCEL_RE = /Non[- ]?refundable|Free Cancellation|Refundable/i;
const ROOM_RE = /((?:Double|Twin|Triple|Quadruple|Quintuple|Family|Standard|Deluxe|Superior|King|Queen|Single)[A-Za-z0-9 /-]{1,100}?)\s*-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const date = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || ''); };
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parsePrice(text, def = 'AED') {
  const m = clean(text).match(PRICE_RE); if (!m) return null;
  const n = Number(m[0].replace(/[^0-9.]/g, '')); if (!(n > 0)) return null;
  const c = m[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);
  return { price: n, currency: c ? c[0].toUpperCase() : def };
}
function roomFrom(text) { const m = clean(text).match(ROOM_RE); return m ? clean(m[1]) : ''; }
function boardFrom(text) { const m = clean(text).match(BOARD_RE); return m ? clean(m[0]) : ''; }
function cancelFrom(text) { const m = clean(text).match(CANCEL_RE); return m ? clean(m[0]) : ''; }
function isPriceOnly(text) { const x = clean(text); return !!x && !roomFrom(x) && !boardFrom(x) && /^\s*(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)?\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*$/i.test(x); }
function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => { const k = [norm(r.hotel), norm(r.room), norm(r.board), norm(r.cancellation), r.price == null ? 'NO_PRICE' : Number(r.price).toFixed(2), norm(r.currency)].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function bodyText(frame) { return clean(await frame.locator('body').innerText().catch(() => '')); }
async function blocked(page) { for (const frame of page.frames()) if (/captcha|verify you are human|access denied|unusual traffic|security check/i.test(await bodyText(frame))) throw new Error('Supplier presented a security verification step; automated bypass is not supported'); }
async function findLoginFrame(page) { for (const frame of page.frames()) if (await frame.locator('#tbUserName').count().catch(() => 0)) return frame; return null; }
async function login(page, source, password, cfg) {
  let frame = null; const end = Date.now() + (Number(cfg.login_frame_timeout_ms) || 45000);
  while (!frame && Date.now() < end) { frame = await findLoginFrame(page); if (!frame) await page.waitForTimeout(500); }
  if (!frame) throw new Error('Hadaf login iframe could not be detected');
  await frame.locator('#tbUserName').fill(String(source.site_username || ''));
  await frame.locator('#tbPassword').fill(String(password || ''));
  const terms = frame.locator('#chkTermCondn').first();
  if (await terms.count() && !(await terms.isChecked().catch(() => false))) await terms.check().catch(() => {});
  await frame.locator('#btnLogin1').click({ timeout: 10000, noWaitAfter: true }).catch(() => {});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms) || 7000);
}
async function searchForm(page) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { for (const frame of page.frames()) if (await frame.locator('#lpPannel_txtV5City').count().catch(() => 0) && await frame.locator('#lpPannel_txtFromDate').count().catch(() => 0)) return frame; await page.waitForTimeout(300); }
  return null;
}
async function chooseDestination(frame, value) {
  const input = frame.locator('#lpPannel_txtV5City').first();

  if (!await input.count()) {
    throw new Error('Hadaf destination input not found');
  }

  const rawValue = clean(value);

  const parts = rawValue
    .split(/\s+-\s+/)
    .map(x => clean(x))
    .filter(Boolean);

  const requestedCity = parts[0] || rawValue;
  const requestedCountry =
    parts.length >= 2
      ? parts.slice(1).join(' - ')
      : '';

  const cityNorm = norm(requestedCity);
  const countryNorm = norm(requestedCountry);

  console.log('========================================');
  console.log('HADAF DESTINATION SELECTION');
  console.log('Hadaf destination raw:', rawValue);
  console.log('Hadaf requested city:', requestedCity);
  console.log('Hadaf requested country:', requestedCountry);

  await input.fill(requestedCity);
  await frame.waitForTimeout(1500);

  const suggestions = await frame.locator(
    'li:visible, [role="option"]:visible'
  ).evaluateAll((els) =>
    els.map((el, index) => ({
      index,
      text: (el.innerText || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
    }))
    .filter(x => x.text)
  ).catch(() => []);

  console.log(
    'Hadaf destination suggestions:',
    JSON.stringify(suggestions, null, 2)
  );

  if (!suggestions.length) {
    throw new Error(
      `Hadaf destination autocomplete returned no suggestions for "${requestedCity}"`
    );
  }

  const scored = suggestions.map(item => {
    const textNorm = norm(item.text);

    let score = 0;

    const cityExact =
      textNorm === cityNorm ||
      textNorm.startsWith(cityNorm + ' ');

    const cityContains =
      textNorm.includes(cityNorm);

    const countryMatches =
      countryNorm &&
      textNorm.includes(countryNorm);

    if (cityExact) score += 100;
    else if (cityContains) score += 50;

    if (countryMatches) score += 200;

    if (
      countryNorm &&
      !countryMatches &&
      textNorm.includes('spain')
    ) {
      score -= 500;
    }

    return {
      ...item,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    'Hadaf destination scored:',
    JSON.stringify(scored, null, 2)
  );

  const best = scored[0];

  if (!best || best.score < 50) {
    throw new Error(
      `Hadaf could not safely match destination "${rawValue}". Suggestions: ${JSON.stringify(suggestions)}`
    );
  }

  console.log(
    'Hadaf destination selected:',
    best.text,
    'score:',
    best.score
  );

  const option = frame.locator(
    'li:visible, [role="option"]:visible'
  ).filter({
    hasText: new RegExp(escapeRegex(best.text), 'i')
  }).first();

  if (!await option.count()) {
    throw new Error(
      `Hadaf selected destination option disappeared: "${best.text}"`
    );
  }

  await option.click();

  await frame.waitForTimeout(700);

  const selectedValue = clean(
    await input.inputValue().catch(() => '')
  );

  console.log(
    'Hadaf destination input after selection:',
    selectedValue
  );

  console.log('========================================');
}
async function fillSearch(frame, search) {
  const nationality = frame.locator('#lpPannel_sel_nationality');
  if (await nationality.count()) await nationality.selectOption({ label: String(search.country || 'United States of America') }).catch(() => {});
  await chooseDestination(frame, search.destination);
  await frame.locator('#lpPannel_txtFromDate').fill(date(search.checkin));
  await frame.locator('#lpPannel_txtToDate').fill(date(search.checkout));
  await frame.locator('#lpPannel_txtNights').fill(String(Math.max(1, Number(search.nights || 1))));
  await frame.locator('#sel_NoOfRooms').selectOption(String(search.rooms || 1)).catch(() => {});
  await frame.locator('#sel_NoOfAdult_1').selectOption(String(search.guests || 2)).catch(() => {});
  await frame.locator('#sel_NoOfChild_1').selectOption(String(search.children ?? 0)).catch(() => {});
  if (search.hotel_name) {
    const hotel = frame.locator('#lpPannel_txtHotel').first();
    if (await hotel.count()) await hotel.evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(search.hotel_name)).catch(() => {});
  }
}
async function clickSearch(frame) {
  const link = frame.locator('a#lpPannel_btnModifySearch').first();

  if (!await link.count()) {
    throw new Error('Hadaf search button not found');
  }

  console.log('========================================');
  console.log('HADAF SEARCH CLICK DIAGNOSTIC');

  const info = await link.evaluate((el) => ({
    tag: el.tagName,
    id: el.id || '',
    href: el.getAttribute('href') || '',
    target: el.getAttribute('target') || '',
    onclick: el.getAttribute('onclick') || '',
    className: el.className || '',
    text: (el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim(),
    outerHTML: el.outerHTML.slice(0, 5000)
  })).catch((e) => ({
    error: e.message
  }));

  console.log(
    'HADAF SEARCH BUTTON:',
    JSON.stringify(info, null, 2)
  );

  console.log(
    'HADAF SEARCH FRAME BEFORE:',
    frame.url()
  );

  const page = frame.page();

  const beforePages = page.context().pages().map((p) => p.url());

  console.log(
    'HADAF PAGES BEFORE:',
    JSON.stringify(beforePages, null, 2)
  );

  /*
   * Capture requests generated by the search click.
   */
  const requests = [];

  const requestHandler = (request) => {
    const url = request.url();

    if (
      /Hotel|Search|Result|GetHotels|availability|ajax/i.test(url)
    ) {
      requests.push({
        method: request.method(),
        url
      });
    }
  };

  page.context().on('request', requestHandler);

  try {
    await link.click({
      timeout: 10000,
      noWaitAfter: true
    });
  } catch (e) {
    console.log(
      'HADAF CLICK ERROR:',
      e.message
    );
  }

  await page.waitForTimeout(5000);

  page.context().off('request', requestHandler);

  const afterPages = page.context().pages().map((p) => p.url());

  console.log(
    'HADAF PAGES AFTER:',
    JSON.stringify(afterPages, null, 2)
  );

  console.log(
    'HADAF SEARCH FRAME AFTER:',
    frame.url()
  );

  console.log(
    'HADAF SEARCH REQUESTS:',
    JSON.stringify(requests, null, 2)
  );

  /*
   * Inspect every page after the click.
   */
  for (let i = 0; i < page.context().pages().length; i++) {
    const p = page.context().pages()[i];

    const pageInfo = await p.evaluate(() => {
      const text = String(
        document.body?.innerText || ''
      )
        .replace(/\s+/g, ' ')
        .trim();

      return {
        url: location.href,
        title: document.title,
        bodyLength: text.length,
        hotelResults:
          /Hotels In|Room Type|Price|Book Now|Records Per page/i
            .test(text),
        ratePopupLinks:
          document.querySelectorAll(
            'a[href*="RatePopup"]'
          ).length,
        preview: text.slice(0, 1000)
      };
    }).catch((e) => ({
      error: e.message,
      url: p.url()
    }));

    console.log(
      `HADAF PAGE AFTER CLICK ${i}:`,
      JSON.stringify(pageInfo, null, 2)
    );
  }

  console.log('========================================');
}
function flattenJson(value, out = []) {
  if (Array.isArray(value)) { value.forEach((x) => flattenJson(x, out)); return out; }
  if (!value || typeof value !== 'object') return out;
  if (value.n && value.rlst) for (const group of value.rlst || []) for (const rate of group.rdlst || []) out.push({ hotel: clean(value.n), room: clean(rate.rt), board: clean(rate.mp), supplierRoomCode: clean(rate.ThirdPartyRoomCode), rateFrom: clean(rate.fd), rateTo: clean(rate.td), available: clean(rate.sts).toUpperCase() === 'A', currency: clean(rate.cc) });
  for (const key of Object.keys(value)) if (key !== 'rlst') flattenJson(value[key], out);
  return out;
}
function captureJson(context, state) {
  context.on('response', async (response) => {
    try { if (/GetHotelsJson\.aspx/i.test(response.url()) && response.status() === 200) { state.json = flattenJson(JSON.parse(await response.text()), []); state.jsonResponse = true; } } catch (_) {}
  });
}
function hotelCandidates(state, hotel) { const h = norm(hotel); return (state.json || []).filter((x) => (!h || norm(x.hotel) === h) && x.available !== false); }
function makeRate(search, meta, room, boardName, price, cancellation) {
  return { hotel: search.hotel_name || meta?.hotel || '', room, view: '', board: boardName, cancellation, price: price?.price ?? null, currency: price?.currency || meta?.currency || 'AED', availability: 'Available', supplier: 'Hadaf Holidays', supplierRoomCode: meta?.supplierRoomCode || '', rateFrom: meta?.rateFrom || '', rateTo: meta?.rateTo || '' };
}

async function extractRenderedCurrent(context, cfg, search, state) {
  const out = [];

  /*
   * First use the existing RatePopup extractor.
   */
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const links = frame.locator('a[href*="RatePopup"]');
      const count = await links.count().catch(() => 0);
      const candidates = hotelCandidates(state, search.hotel_name || '');

      for (let i = 0; i < count; i++) {
        const link = links.nth(i);

        const info = await link.evaluate((el) => {
          const textOf = (n) =>
            (n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim();

          const priceRe =
            /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/ig;

          const boardRe =
            /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;

          const cancelRe =
            /Non[- ]?refundable|Free Cancellation|Refundable/i;

          const roomRe =
            /((?:Double|Twin|Triple|Quadruple|Quintuple|Family|Standard|Deluxe|Superior|King|Queen|Single)[A-Za-z0-9 /-]{1,100}?)\s*-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i;

          const parse = (n) => {
            const t = textOf(n);
            return {
              t,
              p: t.match(priceRe) || [],
              room: (t.match(roomRe)?.[1] || '').trim(),
              board: t.match(boardRe)?.[0] || '',
              cancel: t.match(cancelRe)?.[0] || ''
            };
          };

          const cell = el.closest?.('td,th');
          const row = el.closest?.('tr');
          const parts = [];

          let n = cell?.previousElementSibling;

          for (let j = 0; n && j < 8; j++, n = n.previousElementSibling) {
            parts.push(parse(n));
          }

          if (cell) parts.unshift(parse(cell));

          const rowInfo = row ? parse(row) : null;

          let room =
            parts.find((x) => x.room)?.room ||
            rowInfo?.room ||
            '';

          let board =
            parts.find((x) => x.board)?.board ||
            rowInfo?.board ||
            '';

          let cancel =
            parts.find((x) => x.cancel)?.cancel || '';

          let text =
            parts.find((x) => x.p.length === 1)?.t ||
            textOf(el.parentElement || el);

          if (!room) {
            let node = el.parentElement;

            for (
              let depth = 0;
              node && depth < 8;
              depth++, node = node.parentElement
            ) {
              const t = textOf(node);
              const m = t.match(roomRe);
              const ps = t.match(priceRe) || [];
              const rs =
                node.querySelectorAll?.('a[href*="RatePopup"]').length || 0;

              if (m && ps.length === 1 && rs === 1) {
                room = m[1].trim();
                text = t;
                board = board || t.match(boardRe)?.[0] || '';
                cancel = cancel || t.match(cancelRe)?.[0] || '';
                break;
              }
            }
          }

          return {
            text,
            room,
            board,
            cancel
          };
        }).catch(() => ({
          text: '',
          room: '',
          board: '',
          cancel: ''
        }));

        const p = parsePrice(info.text);

        let room = clean(info.room);
        if (isPriceOnly(room)) room = '';

        let boardName = clean(info.board);
        let cancellation = clean(info.cancel);

        let meta = null;

        if (room) {
          meta =
            candidates.find((x) => norm(x.room) === norm(room)) ||
            candidates.find(
              (x) =>
                norm(x.room).includes(norm(room)) ||
                norm(room).includes(norm(x.room))
            );
        }

        if (!room && candidates[i]) meta = candidates[i];

        if (!room && meta) room = meta.room;
        if (!boardName && meta) boardName = meta.board;

        if (!room || !boardName) continue;

        out.push(
          makeRate(
            search,
            meta,
            room,
            boardName,
            p,
            cancellation
          )
        );
      }
    }
  }

  /*
   * NEW FALLBACK:
   * Hadaf can return HotelResults.aspx without RatePopup links and
   * without GetHotelsJson.aspx data. Inspect visible rendered DOM.
   */
  if (!out.length) {
    console.log('Hadaf: RatePopup extraction returned 0. Starting DOM fallback...');

    console.log('========================================');
    console.log('HADAF RESULT FRAME DIAGNOSTIC');

    for (const p of context.pages()) {
      console.log('HADAF PAGE:', p.url());

      const frames = p.frames();

      console.log('HADAF FRAME COUNT:', frames.length);

      for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];

        const info = await f.evaluate(() => {
          const body = document.body;

          return {
            url: location.href,
            title: document.title,
            bodyLength: body?.innerText?.length || 0,
            htmlLength: document.documentElement?.outerHTML?.length || 0,
            bodyPreview: (body?.innerText || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 2500),

            tables: document.querySelectorAll('table').length,
            rows: document.querySelectorAll('tr').length,
            links: document.querySelectorAll('a').length,
            inputs: document.querySelectorAll('input').length,
            buttons: document.querySelectorAll('button').length,
            selects: document.querySelectorAll('select').length,

            iframes: document.querySelectorAll('iframe').length,

            htmlClasses: Array.from(
              document.querySelectorAll('[class]')
            )
              .slice(0, 100)
              .map(x => String(x.className || ''))
              .filter(Boolean)
              .slice(0, 50),

            ids: Array.from(
              document.querySelectorAll('[id]')
            )
              .slice(0, 100)
              .map(x => String(x.id || ''))
              .filter(Boolean)
              .slice(0, 50)
          };
        }).catch(e => ({
          error: e.message,
          url: f.url()
        }));

        console.log(`HADAF FRAME ${fi}:`, JSON.stringify(info, null, 2));
      }
    }

    console.log('========================================');

    for (const page of context.pages()) {
      for (const frame of page.frames()) {

        const rows = await frame.locator(
          'tr:visible, li:visible, div:visible'
        ).evaluateAll((nodes) => {

          const cleanText = (v) =>
            String(v || '').replace(/\s+/g, ' ').trim();

          const priceRe =
            /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|\b[0-9]{2,6}\.[0-9]{2}\b/ig;

          const boardRe =
            /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;

          const cancelRe =
            /Non[- ]?refundable|Free Cancellation|Refundable/i;

          return nodes.map((el) => {

            const text = cleanText(
              el.innerText || el.textContent || ''
            );

            if (!text) return null;
            if (text.length < 10 || text.length > 2500) return null;

            const prices = text.match(priceRe) || [];
            const board = text.match(boardRe)?.[0] || '';
            const cancel = text.match(cancelRe)?.[0] || '';

            if (!prices.length || !board) return null;

            /*
             * Avoid selecting giant parent containers containing
             * many different hotels/rates.
             */
            const childCount = el.querySelectorAll?.('*').length || 0;
            if (childCount > 80) return null;

            let room = '';

            const roomPatterns = [
              /((?:Double|Twin|Triple|Quadruple|Quintuple|Family|Standard|Deluxe|Superior|King|Queen|Single)[A-Za-z0-9 /&().,'-]{1,120})/i,
              /((?:Room|Suite|Apartment|Studio)[A-Za-z0-9 /&().,'-]{2,120})/i
            ];

            for (const re of roomPatterns) {
              const m = text.match(re);
              if (m) {
                room = cleanText(m[1]);
                break;
              }
            }

            return {
              text,
              room,
              board,
              cancel,
              price: prices[0]
            };
          }).filter(Boolean);

        }).catch(() => []);

        console.log(
          'Hadaf DOM fallback candidates:',
          rows.length,
          'frame:',
          frame.url()
        );

        for (const item of rows) {
          let room = clean(item.room);
          const boardName = clean(item.board);
          const cancellation = clean(item.cancel);
          const price = parsePrice(item.price || item.text);

          if (!price || !boardName) continue;

          if (isPriceOnly(room)) room = '';

          /*
           * If room name was not detected, derive a useful room
           * description from text before the board name.
           */
          if (!room) {
            const beforeBoard = clean(
              item.text.split(
                new RegExp(escapeRegex(boardName), 'i')
              )[0]
            );

            const candidates = beforeBoard
              .split(/[|•]+/)
              .map(clean)
              .filter(Boolean);

            room =
              candidates
                .filter((x) =>
                  x.length >= 3 &&
                  x.length <= 150 &&
                  !/(AED|SAR|USD|EUR|GBP|PKR|US\$|\$)/i.test(x) &&
                  !/hotel|available|select|book|details|rate/i.test(x)
                )
                .pop() || '';
          }

          if (!room) continue;

          let hotel = search.hotel_name || '';

          /*
           * Match rendered text against captured JSON metadata
           * when available.
           */
          const metaList = hotelCandidates(
            state,
            search.hotel_name || ''
          );

          let meta =
            metaList.find(
              (x) => norm(x.room) === norm(room)
            ) ||
            metaList.find(
              (x) =>
                norm(x.room).includes(norm(room)) ||
                norm(room).includes(norm(x.room))
            );

          if (!hotel && meta?.hotel) {
            hotel = meta.hotel;
          }

          out.push({
            hotel,
            room,
            view: '',
            board: boardName,
            cancellation,
            price: price.price,
            currency: price.currency || meta?.currency || 'AED',
            availability: 'Available',
            supplier: 'Hadaf Holidays',
            supplierRoomCode: meta?.supplierRoomCode || '',
            rateFrom: meta?.rateFrom || '',
            rateTo: meta?.rateTo || ''
          });
        }
      }
    }
  }
  /*
   * IMPORTANT:
   * Do not inject the full hotelCandidates metadata list here.
   * During multi-page extraction that creates large numbers of
   * unpriced/fake rows and can hit cfg.max_results (1000).
   *
   * Only return rates actually extracted from the current
   * rendered Hadaf page.
   */
  const finalResults = dedupe(out)
    .filter((r) => r.room && r.board)
    .slice(0, Number(cfg.max_results) || 1000);

  console.log(
    'Hadaf extractor final result count:',
    finalResults.length
  );

  return finalResults;
}
async function extractRendered(context, cfg, search, state) {
  const allResults = [];
  const seenResultKeys = new Set();

  const addResults = (results) => {
    for (const r of Array.isArray(results) ? results : []) {
      const key = JSON.stringify([
        r.hotel || '',
        r.room || '',
        r.board || '',
        r.price || 0,
        r.currency || '',
        r.cancellation || ''
      ]);

      if (!seenResultKeys.has(key)) {
        seenResultKeys.add(key);
        allResults.push(r);
      }
    }
  };

  const getPaginationState = async (page) => {
    return await page.evaluate(() => {
      const root =
        document.querySelector('#Pagination') ||
        document.querySelector('.pagination');

      if (!root) {
        return {
          current: 1,
          max: 1,
          hasPagination: false
        };
      }

      const values = [];

      for (const el of root.querySelectorAll('a, span')) {
        const text = (el.textContent || '').trim();

        if (/^\d+$/.test(text)) {
          values.push(Number(text));
        }
      }

      const currentEl =
        root.querySelector('.current:not(.prev):not(.next)') ||
        root.querySelector('span.current');

      const currentText = currentEl
        ? (currentEl.textContent || '').trim()
        : '';

      const current = /^\d+$/.test(currentText)
        ? Number(currentText)
        : 1;

      const max = values.length
        ? Math.max(...values)
        : current;

      return {
        current,
        max,
        hasPagination: values.length > 0
      };
    }).catch(() => ({
      current: 1,
      max: 1,
      hasPagination: false
    }));
  };

  let pageNumber = 1;
  const maxPages = Number(cfg.max_pages) || 50;

  while (pageNumber <= maxPages) {
    console.log('Hadaf: extracting result page:', pageNumber);

    const currentResults = await extractRenderedCurrent(
      context,
      cfg,
      search,
      state
    );

    addResults(currentResults);

    const pages = context.pages();
    const page = pages[0];

    if (!page) {
      break;
    }

    const before = await getPaginationState(page);

    console.log(
      'Hadaf pagination state before next page:',
      before
    );

    if (!before.hasPagination || before.current >= before.max) {
      console.log(
        'Hadaf: reached final pagination page:',
        before.current
      );
      break;
    }

    const nextPage = before.current + 1;

    console.log(
      'Hadaf: moving to pagination page:',
      nextPage
    );

    const pagination = page.locator(
      '#Pagination, .pagination'
    ).first();

    const numericLink = pagination
      .locator('a')
      .filter({
        hasText: new RegExp('^' + nextPage + '$')
      })
      .first();

    const linkCount = await numericLink.count().catch(() => 0);

    if (!linkCount) {
      console.log(
        'Hadaf: pagination link not found:',
        nextPage
      );
      break;
    }

    try {
      await numericLink.click({
        timeout: 10000,
        force: true
      });
    } catch (clickError) {
      console.log(
        'Hadaf pagination normal click failed:',
        String(clickError)
      );

      try {
        await numericLink.evaluate((el) => el.click());
      } catch (domClickError) {
        console.log(
          'Hadaf pagination DOM click failed:',
          String(domClickError)
        );
        break;
      }
    }

    try {
      await page.waitForFunction(
        (expectedPage) => {
          const root =
            document.querySelector('#Pagination') ||
            document.querySelector('.pagination');

          if (!root) return false;

          const currentEl =
            root.querySelector(
              '.current:not(.prev):not(.next)'
            ) ||
            root.querySelector('span.current');

          if (!currentEl) return false;

          return (
            (currentEl.textContent || '').trim() ===
            String(expectedPage)
          );
        },
        nextPage,
        { timeout: 15000 }
      );
    } catch (waitError) {
      console.log(
        'Hadaf: page transition failed for page:',
        nextPage,
        String(waitError)
      );
      break;
    }

    console.log(
      'Hadaf: waiting for hotel results to finish rendering on page:',
      nextPage
    );

    try {
      await page.waitForFunction(() => {
        const loadingText = document.body?.innerText || '';

        const rateLinks = document.querySelectorAll(
          'a[href*="RatePopup"]'
        );

        const hotelRows = document.querySelectorAll(
          '[class*="hotel"], [class*="Hotel"], .rsp_results_body tr'
        );

        const stillLoading =
          /Loading\s*\d*\s*Hotels/i.test(loadingText);

        return (
          !stillLoading &&
          (rateLinks.length > 0 || hotelRows.length > 5)
        );
      }, null, { timeout: 30000 });
    } catch (renderWaitError) {
      console.log(
        'Hadaf: result render wait timed out on page:',
        nextPage,
        String(renderWaitError)
      );
    }

    await page.waitForTimeout(2000);

    const readyRateLinks = await page.locator(
      'a[href*="RatePopup"]'
    ).count().catch(() => 0);

    console.log(
      'Hadaf: RatePopup links after render wait:',
      readyRateLinks
    );

    pageNumber = nextPage;
  }

  console.log(
    'Hadaf: ALL PAGINATION PAGES EXTRACTED:',
    allResults.length
  );

  const maxResults = Number(cfg.max_results) || 1000;

  return allResults.slice(0, maxResults);
}
async function searchHadafSource(source, search) {
  const cfg = source.browser_config || {};

  if (
    !source.login_url ||
    !source.site_username ||
    !source.site_password_enc
  ) {
    return {
      configured: false,
      results: [],
      error: null
    };
  }

  let password;

  try {
    password = decrypt(source.site_password_enc);
  } catch (error) {
    return {
      configured: true,
      results: [],
      error: `Credential decryption failed: ${error.message}`
    };
  }

  let browser;
  let context;

  try {
    browser = await chromium.launch({
      headless: true
    });

    context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      }
    });

    const state = {
      json: [],
      jsonResponse: false
    };

    captureJson(context, state);

    const page = await context.newPage();

    page.setDefaultTimeout(
      Number(cfg.timeout_ms) || 15000
    );

    console.log('Hadaf: opening login page');

    await page.goto(source.login_url, {
      waitUntil: 'commit',
      timeout: 60000
    });

    await page.waitForTimeout(
      Number(cfg.initial_wait_ms) || 3000
    );

    await blocked(page);

    await login(
      page,
      source,
      password,
      cfg
    );

    console.log(
      'Hadaf: opening hotel search page'
    );

    await page.goto(
      cfg.search_page_url || SEARCH_PAGE,
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    ).catch(() => {});

    await page.waitForTimeout(
      Number(cfg.search_page_wait_ms) || 2500
    );

    const frame = await searchForm(page);

    if (!frame) {
      throw new Error(
        `Hadaf hotel search form could not be detected. URL: ${page.url()}`
      );
    }

    console.log(
      'Hadaf: search form detected:',
      frame.url()
    );

    await fillSearch(
      frame,
      search
    );

    console.log(
      'Hadaf: submitting hotel search'
    );

    await clickSearch(frame);

    /*
     * IMPORTANT:
     * Hadaf may navigate from HotelSearch.aspx to
     * HotelResults.aspx without calling GetHotelsJson.aspx.
     *
     * Therefore URL navigation is a valid success condition.
     */

    const resultTimeout =
      Date.now() +
      (Number(cfg.results_wait_ms) || 90000);

    let resultPage = null;

    while (Date.now() < resultTimeout) {
      await blocked(page);

      const pages = context.pages();

      /*
       * Find HotelResults.aspx across ALL pages.
       */
      resultPage =
        pages.find((p) =>
          /HotelResults\.aspx/i.test(p.url())
        ) || null;

      if (resultPage) {
        console.log(
          'Hadaf: HotelResults.aspx detected:',
          resultPage.url()
        );

        /*
         * Wait for the result page to finish rendering.
         */
        await resultPage.waitForLoadState(
          'domcontentloaded',
          { timeout: 15000 }
        ).catch(() => {});

        await resultPage.waitForTimeout(2000);

        /*
         * Check actual rendered content.
         */
        let resultContent = false;

        for (const f of resultPage.frames()) {
          const info = await f.evaluate(() => {
            const text = String(
              document.body?.innerText || ''
            )
              .replace(/\s+/g, ' ')
              .trim();

            return {
              url: location.href,
              bodyLength: text.length,
              ratePopupLinks:
                document.querySelectorAll(
                  'a[href*="RatePopup"]'
                ).length,
              hotelText:
                /Hotels In|Room Type|Status|Price|Book Now|Records Per page/i
                  .test(text),
              preview: text.slice(0, 500)
            };
          }).catch(() => ({
            bodyLength: 0,
            ratePopupLinks: 0,
            hotelText: false,
            preview: ''
          }));

          console.log(
            'Hadaf result DOM:',
            JSON.stringify(info)
          );

          if (
            info.ratePopupLinks > 0 ||
            info.hotelText ||
            info.bodyLength > 500
          ) {
            resultContent = true;
            break;
          }
        }

        if (resultContent) {
          console.log(
            'Hadaf: result content confirmed'
          );
          break;
        }
      }

      /*
       * JSON is also a valid result path.
       */
      if (
        state.jsonResponse &&
        state.json.length
      ) {
        console.log(
          'Hadaf: JSON hotel results detected:',
          state.json.length
        );
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 1000)
      );
    }

    /*
     * Final result detection.
     */
    const hasResultPage =
      context.pages().some((p) =>
        /HotelResults\.aspx/i.test(p.url())
      );

    if (
      !hasResultPage &&
      !(state.jsonResponse && state.json.length)
    ) {
      throw new Error(
        `Hadaf search did not return results. URL: ${page.url()}`
      );
    }

    if (resultPage) {
      console.log(
        'Hadaf: extracting from:',
        resultPage.url()
      );
    }

    /*
     * Allow final DOM updates before extraction.
     */
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Number(cfg.json_settle_wait_ms) || 5000
      )
    );

    const results =
      await extractRendered(
        context,
        cfg,
        search,
        state
      );

    if (!results.length) {
      throw new Error(
        `Hadaf returned results but no complete hotel rate elements were found. JSON rates: ${state.json.length}. URL: ${resultPage?.url() || page.url()}`
      );
    }

    return {
      configured: true,
      results,
      error: null
    };

  } catch (error) {
    return {
      configured: true,
      results: [],
      error: error.message || String(error)
    };

  } finally {
    try {
      if (context) {
        await context.close();
      }
    } catch (_) {}

    try {
      if (browser) {
        await browser.close();
      }
    } catch (_) {}
  }
}
async function healthHadafSource(source) {
  const cfg = source.browser_config || {};
  if (!source.login_url || !source.site_username || !source.site_password_enc) {
    return {
      configured: false,
      live: false,
      error: 'Hadaf credentials are not configured'
    };
  }

  let password;
  try {
    password = decrypt(source.site_password_enc);
  } catch (error) {
    return {
      configured: true,
      live: false,
      error: `Credential decryption failed: ${error.message}`
    };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(Number(cfg.timeout_ms) || 15000);

    await page.goto(source.login_url, {
      waitUntil: 'commit',
      timeout: 60000
    });

    await page.waitForTimeout(Number(cfg.initial_wait_ms) || 3000);
    await blocked(page);

    const frame = await findLoginFrame(page);

    if (!frame) {
      return {
        configured: true,
        live: false,
        error: `Hadaf login page reached, but login form was not detected. URL: ${page.url()}`
      };
    }

    return {
      configured: true,
      live: true,
      error: null
    };
  } catch (error) {
    return {
      configured: true,
      live: false,
      error: error.message || String(error)
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
module.exports = { searchHadafSource, healthHadafSource };











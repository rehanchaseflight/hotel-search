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

async function allFrames(page) { try { return page.frames(); } catch { return [page.mainFrame()]; } }

async function firstVisibleAnyFrame(page, selectors) {
  for (const frame of await allFrames(page)) {
    for (const selector of selectors.filter(Boolean)) {
      try {
        const loc = frame.locator(selector).first();
        if (await loc.count() && await loc.isVisible()) return loc;
      } catch {}
    }
  }
  return null;
}

async function scoreInputs(page, purpose) {
  const rows = [];
  for (const frame of await allFrames(page)) {
    let inputs;
    try { inputs = frame.locator('input:visible, textarea:visible'); } catch { continue; }
    const count = await inputs.count().catch(() => 0);
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
  }
  return rows.sort((a,b) => b.score-a.score || a.index-b.index);
}

async function clickEntryPoint(page, patterns) {
  for (const frame of await allFrames(page)) {
    for (const pattern of patterns) {
      try {
        const b = frame.getByRole('button', { name: pattern }).first();
        if (await b.count() && await b.isVisible()) { await b.click({ timeout: 5000 }); return true; }
      } catch {}
      try {
        const t = frame.getByText(pattern).first();
        if (await t.count() && await t.isVisible()) { await t.click({ timeout: 5000 }); return true; }
      } catch {}
    }
  }
  return false;
}

async function blockedReason(page) {
  const chunks = [];
  for (const frame of await allFrames(page)) {
    try { chunks.push(text(await frame.locator('body').innerText())); } catch {}
  }
  const body = chunks.join(' ').toLowerCase();
  if (/captcha|verify you are human|access denied|unusual traffic|security check|enable javascript and cookies/.test(body)) {
    return 'Supplier presented a security verification step; automated bypass is not supported';
  }
  return null;
}

async function loginGeneric(page, source, cfg, password) {
  let user = await firstVisibleAnyFrame(page, [
    cfg.username_selector,'input[type="email"]:visible','input[autocomplete="username"]:visible',
    'input[name*="email" i]:visible','input[name*="user" i]:visible','input[id*="email" i]:visible','input[id*="user" i]:visible'
  ]);
  let pass = await firstVisibleAnyFrame(page, [
    cfg.password_selector,'input[type="password"]:visible','input[autocomplete="current-password"]:visible',
    'input[name*="pass" i]:visible','input[id*="pass" i]:visible'
  ]);

  if (!user || !pass) {
    const blocked = await blockedReason(page);
    if (blocked) throw new Error(blocked);
    await clickEntryPoint(page,[/login/i,/sign\s*in/i,/agent\s*login/i,/partner\s*login/i]);
    await page.waitForTimeout(1200);
    user = user || await firstVisibleAnyFrame(page,[cfg.username_selector,'input[type="email"]:visible','input[autocomplete="username"]:visible','input[name*="email" i]:visible','input[name*="user" i]:visible','input[id*="email" i]:visible','input[id*="user" i]:visible']);
    pass = pass || await firstVisibleAnyFrame(page,[cfg.password_selector,'input[type="password"]:visible','input[autocomplete="current-password"]:visible','input[name*="pass" i]:visible','input[id*="pass" i]:visible']);
  }
  if (!user) user = (await scoreInputs(page,'username'))[0]?.el;
  if (!pass) pass = (await scoreInputs(page,'password'))[0]?.el;
  if (!user || !pass) throw new Error('Supplier login fields could not be detected');

  await user.fill(String(source.site_username || ''));
  await pass.fill(String(password || ''));
  const button = await firstVisibleAnyFrame(page,[cfg.login_button_selector,'button:has-text("LOGIN")','button:has-text("Login")','button:has-text("Sign in")','input[type="submit"]:visible','button[type="submit"]:visible']);
  if (button) await button.click(); else await pass.press('Enter');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  await page.waitForTimeout(Number(cfg.post_login_wait_ms)||3000);
  const after = await blockedReason(page); if(after) throw new Error(after);
}

async function fillSmart(page,purpose,value,explicitSelector){
  const loc=await firstVisibleAnyFrame(page,[explicitSelector]);
  const ranked=loc||(await scoreInputs(page,purpose))[0]?.el;
  if(!ranked)return false;
  try{await ranked.fill(String(value));await ranked.press('Tab').catch(()=>{});return true;}catch{return false;}
}

async function navigateGenericSearch(page,search,cfg){
  const url=cfg.search_url_template?fillTemplate(cfg.search_url_template,search):'';
  if(url){await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});return;}
  if(!await fillSmart(page,'destination',search.destination,cfg.destination_selector)) throw new Error('Supplier destination field could not be detected');
  await fillSmart(page,'date',search.checkin,cfg.checkin_selector);await fillSmart(page,'date',search.checkout,cfg.checkout_selector);
  await fillSmart(page,'guests',search.guests,cfg.guests_selector);await fillSmart(page,'rooms',search.rooms||1,cfg.rooms_selector);
  if(cfg.board_selector){const b=await firstVisibleAnyFrame(page,[cfg.board_selector]);if(b)await b.selectOption(String(search.board||'ROOM_ONLY')).catch(()=>{});}
  const btn=await firstVisibleAnyFrame(page,[cfg.search_button_selector,'button:has-text("SEARCH")','button:has-text("Search")','button:has-text("Find")','button:has-text("CHECK AVAILABILITY")','input[type="submit"]:visible','button[type="submit"]:visible']);
  if(!btn)throw new Error('Supplier search button could not be detected');await btn.click();
}

async function extractRatesFromFrame(frame, cfg) {
  try {
    if (cfg.preset === 'rezlive') {
      /*
       * FAST REZLIVE LIST EXTRACTION
       *
       * Initial search reads only the already-rendered hotel cards.
       * No hotel-detail clicks and no expensive full-DOM price scan.
       */

      try {
        const rows = await frame.evaluate(() => {
          const clean = value =>
            String(value || '')
              .replace(/\s+/g, ' ')
              .trim();

          const priceRe =
            /(?:USD|US\$|SAR|AED|EUR|GBP|PKR|\$)\s*[\d,]+(?:\.\d{1,2})?/i;

          const cards = Array.from(
            document.querySelectorAll(
              '#hotels_list_display .result-full'
            )
          );

          const out = [];

          for (const card of cards) {
            const text = clean(
              card.innerText || card.textContent || ''
            );

            if (!text) continue;

            const priceMatch = text.match(priceRe);

            if (!priceMatch) continue;

            const priceText = priceMatch[0];

            const numberMatch =
              priceText.match(/[\d,]+(?:\.\d{1,2})?/);

            if (!numberMatch) continue;

            const price =
              Number(numberMatch[0].replace(/,/g, ''));

            if (!Number.isFinite(price) || price <= 0) {
              continue;
            }

            const lines = String(
              card.innerText || card.textContent || ''
            )
              .split(/\r?\n/)
              .map(clean)
              .filter(Boolean);

            let hotel = '';

            const hotelSelectors = [
              '[class*="hotel-name" i]',
              '[class*="hotelname" i]',
              '[class*="hotel-title" i]',
              '[class*="hotel_title" i]',
              '[class*="property-name" i]',
              '[class*="propertyname" i]',
              '[class*="property-title" i]',
              '[class*="property_title" i]'
            ];

            for (const selector of hotelSelectors) {
              try {
                const el = card.querySelector(selector);

                if (!el) continue;

                const value = clean(
                  el.innerText || el.textContent || ''
                );

                if (
                  value &&
                  !priceRe.test(value) &&
                  !/^(available|unavailable)$/i.test(value)
                ) {
                  hotel = value;
                  break;
                }
              } catch {}
            }

            if (!hotel) {
              for (const line of lines) {
                if (
                  line &&
                  !priceRe.test(line) &&
                  !/^(available|unavailable)$/i.test(line) &&
                  !/^(makkah|madinah|madina|medina)$/i.test(line) &&
                  !/^(price|from|rooms?)$/i.test(line)
                ) {
                  hotel = line;
                  break;
                }
              }
            }

            if (!hotel) continue;

            let address = '';

            for (const line of lines) {
              if (
                line !== hotel &&
                !priceRe.test(line) &&
                /(?:makkah|madinah|madina|medina|saudi)/i.test(line)
              ) {
                address = line;
                break;
              }
            }

            let availability = 'Available';

            for (const line of lines) {
              if (/^(available|unavailable)$/i.test(line)) {
                availability = line;
                break;
              }
            }

            const currencyMatch =
              priceText.match(
                /USD|US\$|SAR|AED|EUR|GBP|PKR|\$/i
              );

            const currency =
              currencyMatch
                ? currencyMatch[0].toUpperCase()
                : '';

            const hotelElement =
              card.querySelector(
                '[id*="hotel" i]'
              );

            const hotelId =
              hotelElement?.id ||
              card.id ||
              '';

            out.push({
              hotel,
              address,
              room: '',
              category: '',
              view: '',
              board: '',
              cancellation: '',
              availability,
              price,
              currency,
              hotelId,
              raw: {
                source: 'RezLive',
                hotel,
                address,
                availability,
                price,
                currency,
                hotelId
              }
            });
          }

          return out.slice(0, 500);
        });

        console.log(
          "RezLive lightweight extractor rows:",
          rows.length
        );

        return rows;
      } catch (e) {
        console.log(
          "RezLive lightweight extractor error:",
          e.message
        );

        return [];
      }
    }
    /*
     * Existing generic extractor for non-RezLive suppliers.
     */
    if (cfg.result_row_selector) {
      try {
        return await frame.locator(
          cfg.result_row_selector
        ).evaluateAll(
          (nodes, c) => {
            const clean = v =>
              String(v || '')
                .replace(/\s+/g, ' ')
                .trim();

            const get = (root, s) => {
              if (!s) return '';

              const e = root.querySelector(s);

              return e
                ? clean(e.innerText || e.textContent)
                : '';
            };

            return nodes
              .slice(
                0,
                Number(c.max_results) || 500
              )
              .map((root, index) => ({
                index,
                hotel: get(root, c.hotel_selector),
                room: get(root, c.room_selector),
                view: get(root, c.view_selector),
                board: get(root, c.board_selector),
                price: get(root, c.price_selector),
                currency: get(root, c.currency_selector),
                cancellation: get(
                  root,
                  c.cancellation_selector
                ),
                availability: get(
                  root,
                  c.availability_selector
                )
              }));
          },
          cfg
        );
      } catch {
        return [];
      }
    }

    return frame.evaluate(() => {
      const clean = v =>
        String(v ?? '')
          .replace(/\s+/g, ' ')
          .trim();

      const priceRe =
        /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;

      const boardRe =
        /\b(room only|bed\s*&?\s*breakfast|breakfast included|breakfast|half board|full board|all inclusive|with breakfast|no meal)\b/i;

      const cancelRe =
        /\b(non.?refundable|free cancellation|cancellation policy|refundable|cancel(?:l)ation)\b/i;

      const roomRe =
        /\b(single|double|twin|triple|quad|family|king|queen|deluxe|classic|superior|premier|guest room|suite|studio|room)\b/i;

      const viewRe =
        /\b(city view|sea view|garden view|pool view|kaaba view|haram view|partial view|no view|view)\b/i;

      const availRe =
        /\b(available|rooms? left|on request|sold out)\b/i;

      const out = [];
      const seen = new Set();

      const nodes = [
        ...document.querySelectorAll('body *')
      ].filter(e => {
        const t = clean(e.textContent);

        return (
          priceRe.test(t) &&
          (e.children.length === 0 || t.length < 300)
        );
      });

      for (const n of nodes) {
        let root = n;

        for (
          let i = 0;
          i < 12 && root.parentElement;
          i++
        ) {
          const t = clean(
            root.innerText || root.textContent
          );

          if (
            t.length >= 80 &&
            t.length <= 2200 &&
            priceRe.test(t)
          ) {
            break;
          }

          root = root.parentElement;
        }

        const raw = clean(
          root.innerText || root.textContent
        );

        if (!raw || seen.has(raw)) continue;

        seen.add(raw);

        const m = raw.match(priceRe);

        if (!m) continue;

        const price = Number(
          m[0].replace(/[^0-9.]/g, '')
        );

        if (!Number.isFinite(price) || price <= 0) {
          continue;
        }

        const lines = raw
          .split(/\n+/)
          .map(clean)
          .filter(Boolean);

        const cm = m[0].match(
          /AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i
        );

        out.push({
          hotel:
            lines.find(x =>
              /hotel|resort|inn|suites/i.test(x)
            ) ||
            lines[0] ||
            'Hotel',

          room:
            lines.find(
              x => roomRe.test(x) && !priceRe.test(x)
            ) || '',

          view:
            lines.find(x => viewRe.test(x)) || '',

          board:
            lines.find(x => boardRe.test(x)) || '',

          cancellation:
            lines.find(x => cancelRe.test(x)) || '',

          availability:
            lines.find(x => availRe.test(x)) ||
            'Available',

          price,

          currency: cm
            ? cm[0]
                .replace('US$', 'USD')
                .replace('$', 'USD')
                .toUpperCase()
            : '',

          raw
        });
      }

      return out.slice(0, 500);
    }).catch(() => []);

  } catch (error) {
    console.log(
      "RezLive extractor error:",
      error.message
    );

    return [];
  }
}async function searchRezLive(page, search, cfg = {}) {
  const wait = Math.min(
  Math.max(Number(cfg.results_wait_ms) || 8000, 3000),
  12000
);

  const blocked = await blockedReason(page);
  if (blocked) throw new Error(blocked);

  console.log("RezLive: opening hotel search form...");
  console.log("RezLive: requested destination:", search.destination);
  console.log("RezLive: requested check-in:", search.checkin);
  console.log("RezLive: requested check-out:", search.checkout);

  /*
   * RezLive's current form uses:
   *
   * #preferedcity
   * #city_code
   * #destinationselect
   * #destinationselectnew
   * #destinationnew
   * #lightpick
   * #t-start
   * #t-end
   * #sel_days
   * #totalroomdetailval
   * #search_go
   *
   * Do not rely on generic "check-in"/"check-out" selectors here.
   */

  // Always make sure we are on a fresh RezLive search form.
  // This prevents a second search from remaining on the previous results page.
  const currentUrl = page.url();

  if (!/rezlive\.com/i.test(currentUrl) ||
      !/searchhotel/i.test(currentUrl)) {
    console.log("RezLive: navigating to fresh hotel search form...");
    await page.goto(
      "https://www.rezlive.com/agency/hotels/action/searchhotel",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000
      }
    ).catch(() => {});
  } else {
    console.log("RezLive: refreshing search form for fresh query...");
    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 30000
    }).catch(() => {});
  }

  await page.waitForTimeout(1000);

  await page.waitForSelector("#searchhotel", {
    state: "attached",
    timeout: 15000
  }).catch(() => {});

  const formExists = await page.locator("#searchhotel").count().catch(() => 0);

  if (!formExists) {
    throw new Error(`RezLive hotel search form not found. URL: ${page.url()}`);
  }

  console.log("RezLive: fresh search form ready:", page.url());

  function normalizeDate(value) {
    const s = String(value || "").trim();

    if (!s) return "";

    // YYYY-MM-DD or YYYY/MM/DD -> DD-MM-YYYY
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);

    if (m) {
      return `${String(Number(m[3])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}-${m[1]}`;
    }

    // DD-MM-YYYY or DD/MM/YYYY -> DD-MM-YYYY
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);

    if (m) {
      return `${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}-${m[3]}`;
    }

    // DD Month YYYY
    m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);

    if (m) {
      const months = {
        january: 1,
        february: 2,
        march: 3,
        april: 4,
        may: 5,
        june: 6,
        july: 7,
        august: 8,
        september: 9,
        october: 10,
        november: 11,
        december: 12
      };

      const month = months[m[2].toLowerCase()];

      if (month) {
        return `${String(Number(m[1])).padStart(2, "0")}-${String(month).padStart(2, "0")}-${m[3]}`;
      }
    }

    throw new Error(`Invalid RezLive date: ${s}`);
  }
  console.log("=== REZLIVE DATE DEBUG BEFORE NORMALIZE ===");
  console.log("search.checkin =", JSON.stringify(search.checkin));
  console.log("search.checkout =", JSON.stringify(search.checkout));
  console.log("search object =", JSON.stringify({
    checkin: search.checkin,
    checkout: search.checkout,
    destination: search.destination,
    adults: search.adults,
    children: search.children,
    rooms: search.rooms,
    guests: search.guests
  }, null, 2));
  console.log("=== END REZLIVE DATE DEBUG ===");
  const checkin = normalizeDate(search.checkin);
  const checkout = normalizeDate(search.checkout);

  function nightsBetween(a, b) {
    const ma = String(a).match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const mb = String(b).match(/^(\d{2})-(\d{2})-(\d{4})$/);

    if (!ma || !mb) return 1;

    const da = new Date(Number(ma[3]), Number(ma[2]) - 1, Number(ma[1]));
    const db = new Date(Number(mb[3]), Number(mb[2]) - 1, Number(mb[1]));

    const diff = Math.round((db.getTime() - da.getTime()) / 86400000);

    return diff > 0 ? diff : 1;
  }

  const nights = nightsBetween(checkin, checkout);
  let destinationText = String(search.destination || "Madina,Saudi Arabia").trim();

const destinationNormalized = destinationText
  .toLowerCase()
  .replace(/[']/g, "")
  .replace(/\s+/g, " ")
  .trim();

if (/(makkah|mecca)/i.test(destinationNormalized)) {
  destinationText = "Makkah,Saudi Arabia";
} else if (/(madina|madinah|medina)/i.test(destinationNormalized)) {
  destinationText = "Madina,Saudi Arabia";
}

  /*
   * Current test destination:
   * Madina, Saudi Arabia = RezLive city code 20299.
   *
   * If another destination is supplied later, cfg.city_code can be used.
   */
  /*
   * ============================================================
   * REZLIVE DESTINATION HANDLING
   * ============================================================
   *
   * Portal destinations use:
   *
   *   Doha - Qatar
   *   Dubai - United Arab Emirates
   *
   * RezLive's autocomplete expects the CITY to be typed into
   * the destination input and its own suggestion to be selected.
   *
   * IMPORTANT:
   * Do NOT blindly put "Doha - Qatar" into #preferedcity.
   * That bypasses RezLive's autocomplete and can leave
   * #city_code empty.
   */

  function normalizeRezLiveDestination(value) {
    const original = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!original) {
      return {
        original: "",
        city: "",
        country: "",
        rezliveText: ""
      };
    }

    let city = original;
    let country = "";

    /*
     * Portal format:
     *
     *   Doha - Qatar
     *   Dubai - United Arab Emirates
     */
    const dashParts = original.split(/\s+-\s+/);

    if (dashParts.length >= 2) {
      city = dashParts.shift().trim();
      country = dashParts.join(" - ").trim();
    } else if (original.includes(",")) {
      const commaParts = original.split(",");

      city = commaParts.shift().trim();
      country = commaParts.join(",").trim();
    }

    return {
      original,
      city,
      country,
      rezliveText: country
        ? `${city},${country}`
        : city
    };
  }

  const rezDestinationBase =
    normalizeRezLiveDestination(search.destination);

  const destinationCountry =
    String(search.destinationCountry || "").trim();

  const rezDestination = {
    ...rezDestinationBase,
    country:
      destinationCountry ||
      rezDestinationBase.country,
    rezliveText:
      destinationCountry &&
      rezDestinationBase.city
        ? `${rezDestinationBase.city},${destinationCountry}`
        : rezDestinationBase.rezliveText
  };

  /*
   * RezLive's internal spelling differs from the portal spelling.
   * Portal/request: Medina,Saudi Arabia
   * RezLive:       Madina,Saudi Arabia
   *
   * Do not change the portal value. Change only the internal
   * RezLive destination used by the supplier connector.
   */
  if (
    /^(madina|madinah|medina)$/i.test(rezDestination.city) &&
    /^saudi arabia$/i.test(rezDestination.country)
  ) {
    rezDestination.city = "Madina";
    rezDestination.rezliveText = "Madina,Saudi Arabia";
  }

  console.log("RezLive destination conversion:");
  console.log(JSON.stringify({
    portalDestination: search.destination,
    destinationCountry: search.destinationCountry || "",
    city: rezDestination.city,
    country: rezDestination.country,
    rezliveText: rezDestination.rezliveText
  }, null, 2));

  /*
   * Keep the already-confirmed mappings.
   */
  let cityCode = String(cfg.city_code || "").trim();

  if (
    !cityCode &&
    /^(madina|madinah|medina)$/i.test(rezDestination.city)
  ) {
    cityCode = "20299";
  }

  if (
    !cityCode &&
    /^(makkah|mecca)$/i.test(rezDestination.city)
  ) {
    cityCode = "20300";
  }

  /*
   * ============================================================
   * STEP 1
   * Put ONLY the city into RezLive's real autocomplete input.
   * ============================================================
   */

  const destinationPrepared =
    await page.locator("#searchhotel").evaluate(
      (form, data) => {
        const input =
          form.querySelector("#preferedcity");

        if (!input) {
          return {
            found: false,
            value: "",
            cityCode:
              form.querySelector("#city_code")?.value || ""
          };
        }

        const value =
          String(
            data.rezliveText ||
            data.city ||
            ""
          ).trim();

        try {
          const descriptor =
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value"
            );

          if (descriptor && descriptor.set) {
            descriptor.set.call(input, value);
          } else {
            input.value = value;
          }
        } catch {
          input.value = value;
        }

        /*
         * Trigger the events RezLive's autocomplete listens for.
         */
        input.dispatchEvent(
          new Event("focus", {
            bubbles: true
          })
        );

        input.dispatchEvent(
          new Event("input", {
            bubbles: true
          })
        );

        input.dispatchEvent(
          new Event("keyup", {
            bubbles: true
          })
        );

        input.dispatchEvent(
          new Event("change", {
            bubbles: true
          })
        );

        return {
          found: true,
          value: input.value,
          cityCode:
            form.querySelector("#city_code")?.value || ""
        };
      },
      {
        city: rezDestination.city,
        rezliveText: rezDestination.rezliveText
      }
    );

  console.log(
    "RezLive autocomplete input prepared:"
  );

  console.log(
    JSON.stringify(
      destinationPrepared,
      null,
      2
    )
  );

  /*
   * Give RezLive autocomplete AJAX/JavaScript time to
   * populate the suggestion list.
   */
  await page.waitForTimeout(1500);

  /*
   * ============================================================
   * STEP 2
   * Inspect visible autocomplete candidates.
   * ============================================================
   */

  const autocompleteCandidates =
    await page.locator("body *").evaluateAll(
      (nodes, data) => {
        const clean = value =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const city =
          clean(data.city).toLowerCase();

        const country =
          clean(data.country).toLowerCase();

        const results = [];

        for (const el of nodes) {
          if (!(el instanceof HTMLElement)) {
            continue;
          }

          const style =
            window.getComputedStyle(el);

          if (
            style.display === "none" ||
            style.visibility === "hidden"
          ) {
            continue;
          }

          const rect =
            el.getBoundingClientRect();

          if (!rect.width || !rect.height) {
            continue;
          }

          /*
           * Avoid large containers/body elements.
           */
          if (
            rect.height > 120 ||
            rect.width > 800
          ) {
            continue;
          }

          const text =
            clean(
              el.innerText ||
              el.textContent
            );

          if (!text || text.length > 200) {
            continue;
          }

          const lower =
            text.toLowerCase();

          if (!lower.includes(city)) {
            continue;
          }

          if (
            country &&
            !lower.includes(country) &&
            !(
              country === "united arab emirates" &&
              lower.includes("uae")
            )
          ) {
            continue;
          }

          results.push({
            text,
            tag: el.tagName,
            id: el.id || "",
            className:
              String(el.className || "")
          });
        }

        /*
         * Remove duplicate text entries.
         */
        const seen = new Set();

        return results
          .filter(item => {
            const key =
              item.text.toLowerCase();

            if (seen.has(key)) {
              return false;
            }

            seen.add(key);
            return true;
          })
          .slice(0, 20);
      },
      {
        city: rezDestination.city,
        country: rezDestination.country
      }
    );

  console.log(
    "RezLive autocomplete candidates:"
  );

  console.log(
    JSON.stringify(
      autocompleteCandidates,
      null,
      2
    )
  );

  /*
   * ============================================================
   * STEP 3
   * Click RezLive's actual autocomplete suggestion.
   * ============================================================
   */

  let destinationClicked = false;

  const suggestionTexts = [];

  /*
   * IMPORTANT:
   * RezLive uses its own destination spelling.
   *
   * Example:
   * Portal: Medina - Saudi Arabia
   * RezLive: Madina,Saudi Arabia
   *
   * Always try RezLive's exact destination value first.
   */
  if (rezDestination.rezliveText) {
    suggestionTexts.push(
      rezDestination.rezliveText
    );
  }

  /*
   * City + country is the second fallback.
   */
  if (
    rezDestination.city &&
    rezDestination.country
  ) {
    const cityCountry =
      `${rezDestination.city},${rezDestination.country}`;

    if (
      !suggestionTexts.includes(cityCountry)
    ) {
      suggestionTexts.push(cityCountry);
    }
  }

  /*
   * Generic city name is the LAST fallback.
   * Never prefer this over the RezLive-specific value.
   */
  if (
    rezDestination.city &&
    !suggestionTexts.includes(
      rezDestination.city
    )
  ) {
    suggestionTexts.push(
      rezDestination.city
    );
  }

  /*
   * First attempt: exact visible text.
   */
  for (
    const wantedText of suggestionTexts
  ) {
    if (destinationClicked) {
      break;
    }

    const locator =
      page
        .getByText(wantedText, {
          exact: true
        })
        .first();

    const count =
      await locator.count()
        .catch(() => 0);

    if (!count) {
      continue;
    }

    const visible =
      await locator
        .isVisible()
        .catch(() => false);

    if (!visible) {
      continue;
    }

    try {
      console.log(
        "RezLive: clicking autocomplete suggestion:",
        wantedText
      );

      await locator.click({
        timeout: 5000
      });

      destinationClicked = true;

      console.log(
        "RezLive: autocomplete suggestion clicked:",
        wantedText
      );
    } catch (err) {
      console.log(
        "RezLive: suggestion click failed:",
        wantedText,
        err?.message || err
      );
    }
  }

  /*
   * ============================================================
   * STEP 4
   * Fallback DOM click.
   *
   * This handles cases where the autocomplete suggestion
   * is rendered by an older jQuery/autocomplete implementation
   * and Playwright getByText cannot identify it correctly.
   * ============================================================
   */

  if (
    !destinationClicked &&
    autocompleteCandidates.length
  ) {
    const clicked =
      await page.locator("body *").evaluate(
        (nodes, data) => {
          const clean = value =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim();

          const city =
            clean(data.city).toLowerCase();

          const country =
            clean(data.country).toLowerCase();

          const candidates =
            nodes
              .filter(el => {
                if (
                  !(el instanceof HTMLElement)
                ) {
                  return false;
                }

                const style =
                  window.getComputedStyle(el);

                if (
                  style.display === "none" ||
                  style.visibility === "hidden"
                ) {
                  return false;
                }

                const rect =
                  el.getBoundingClientRect();

                if (
                  !rect.width ||
                  !rect.height
                ) {
                  return false;
                }

                if (
                  rect.height > 120 ||
                  rect.width > 800
                ) {
                  return false;
                }

                const text =
                  clean(
                    el.innerText ||
                    el.textContent
                  );

                if (
                  !text ||
                  text.length > 200
                ) {
                  return false;
                }

                const lower =
                  text.toLowerCase();

                if (
                  !lower.includes(city)
                ) {
                  return false;
                }

                if (
                  country &&
                  !lower.includes(country) &&
                  !(
                    country ===
                      "united arab emirates" &&
                    lower.includes("uae")
                  )
                ) {
                  return false;
                }

                return true;
              })
              .sort((a, b) => {
                const ar =
                  a.getBoundingClientRect();

                const br =
                  b.getBoundingClientRect();

                return (
                  ar.width * ar.height -
                  br.width * br.height
                );
              });

          const target =
            candidates[0];

          if (!target) {
            return false;
          }

          target.scrollIntoView({
            block: "center"
          });

          /*
           * Reproduce a real mouse interaction.
           */
          target.dispatchEvent(
            new MouseEvent(
              "mousedown",
              {
                bubbles: true,
                cancelable: true,
                view: window
              }
            )
          );

          target.dispatchEvent(
            new MouseEvent(
              "mouseup",
              {
                bubbles: true,
                cancelable: true,
                view: window
              }
            )
          );

          target.click();

          return true;
        },
        {
          city: rezDestination.city,
          country: rezDestination.country
        }
      )
      .catch(() => false);

    if (clicked) {
      destinationClicked = true;

      console.log(
        "RezLive: autocomplete candidate clicked through DOM."
      );
    }
  }

  /*
   * Allow RezLive's own selection handler to finish.
   */
  await page.waitForTimeout(700);

  /*
   * ============================================================
   * STEP 5
   * Read the destination AFTER the autocomplete selection.
   * ============================================================
   */

  const destinationAfterSelection =
    await page.locator("#searchhotel").evaluate(
      form => {
        const get = selector =>
          form.querySelector(selector)?.value ||
          "";

        return {
          preferedcity:
            get("#preferedcity"),

          city_code:
            get("#city_code"),

          destinationselect:
            get("#destinationselect"),

          destinationselectnew:
            get("#destinationselectnew"),

          destinationnew:
            get("#destinationnew")
        };
      }
    );

  console.log(
    "RezLive destination AFTER autocomplete:"
  );

  console.log(
    JSON.stringify(
      destinationAfterSelection,
      null,
      2
    )
  );

  /*
   * If RezLive populated the city code itself,
   * use that value only when we do not already
   * have an authoritative mapped city code.
   *
   * IMPORTANT:
   * For Madina,Saudi Arabia the known RezLive
   * city code is 20299. Do not allow a generic
   * autocomplete match such as Medina,Ohio (20760)
   * to overwrite it.
   */
  if (
    !cityCode &&
    destinationAfterSelection.city_code
  ) {
    cityCode =
      String(
        destinationAfterSelection.city_code
      ).trim();
  }

  console.log(
    "RezLive final destination city_code:",
    cityCode || "(empty)"
  );

  console.log(
    "RezLive autocomplete selected:",
    destinationClicked
  );

  /*
   * ============================================================
   * STEP 6
   * Synchronize the helper destination fields.
   *
   * IMPORTANT:
   * #preferedcity is NOT overwritten with the portal's
   * "City - Country" value.
   * ============================================================
   */

  const formState =
    await page.locator("#searchhotel").evaluate(
      (form, data) => {
        const set =
          (selector, value, fire = true) => {
            const el =
              form.querySelector(selector);

            if (!el) {
              return false;
            }

            const v =
              String(value ?? "");

            try {
              const proto =
                el.tagName === "SELECT"
                  ? HTMLSelectElement.prototype
                  : HTMLInputElement.prototype;

              const descriptor =
                Object.getOwnPropertyDescriptor(
                  proto,
                  "value"
                );

              if (
                descriptor &&
                descriptor.set
              ) {
                descriptor.set.call(
                  el,
                  v
                );
              } else {
                el.value = v;
              }
            } catch {
              el.value = v;
            }

            if (fire) {
              el.dispatchEvent(
                new Event("input", {
                  bubbles: true
                })
              );

              el.dispatchEvent(
                new Event("change", {
                  bubbles: true
                })
              );
            }

            return true;
          };

        /*
         * Keep whatever RezLive selected in the real field.
         */
        const selectedDestination =
          form.querySelector(
            "#preferedcity"
          )?.value ||
          data.rezliveText ||
          data.city;

        /*
         * Synchronize helper fields only.
         */
        set(
          "#destinationselect",
          selectedDestination
        );

        set(
          "#destinationselectnew",
          selectedDestination
        );

        set(
          "#destinationnew",
          selectedDestination
        );

        return {
          destination:
            form.querySelector(
              "#preferedcity"
            )?.value || "",

          city_code:
            form.querySelector(
              "#city_code"
            )?.value || "",

          destinationselect:
            form.querySelector(
              "#destinationselect"
            )?.value || "",

          destinationselectnew:
            form.querySelector(
              "#destinationselectnew"
            )?.value || "",

          destinationnew:
            form.querySelector(
              "#destinationnew"
            )?.value || "",

          checkin:
            form.querySelector(
              "#t-start"
            )?.value ||
            form.querySelector(
              "#lightpick"
            )?.value ||
            "",

          checkout:
            form.querySelector(
              "#t-end"
            )?.value || ""
        };
      },
      {
        city: rezDestination.city,
        country: rezDestination.country,
        rezliveText:
          rezDestination.rezliveText
      }
    );
  console.log("RezLive: form values after population:");
  console.log(JSON.stringify(formState, null, 2));

  /*
   * Safety check: the important POST fields must contain values.
   */
  if (!formState.city_code && !formState.destination) {
    throw new Error("RezLive destination values were not populated.");
  }

  if (!formState.checkin || !formState.checkout) {
    throw new Error("RezLive check-in/check-out values were not populated.");
  }

  /*
   * Capture the actual POST request if RezLive submits normally.
   */
  let requestUrl = "";
  let responseStatus = null;

  const requestListener = request => {
    try {
      const url = request.url();

      if (
        /rezlive\.com/i.test(url) &&
        (/\/agency\/hotel/i.test(url) || request.method() === "POST")
      ) {
        requestUrl = url;
        console.log("RezLive POST/request:", request.method(), url);

        try {
          const data = request.postData();
          if (data) {
            console.log("RezLive submitted POST data:", data.slice(0, 5000));
          }
        } catch {}
      }
    } catch {}
  };

  const responseListener = response => {
    try {
      const url = response.url();

      if (/\/agency\/hotel/i.test(url)) {
        responseStatus = response.status();
        console.log("RezLive hotel response:", responseStatus, url);
      }
    } catch {}
  };

  page.on("request", requestListener);
  page.on("response", responseListener);

  try {
    /*
     * Current RezLive button is:
     * <input type="submit" id="search_go" value="Let's Find">
     */
    const searchButton = page.locator("#search_go").first();

    const buttonCount = await searchButton.count().catch(() => 0);

    console.log("RezLive search button count:", buttonCount);

    if (!buttonCount) {
      throw new Error("RezLive #search_go button not found.");
    }

    const visibleButton = await searchButton.isVisible().catch(() => false);

    console.log("RezLive #search_go visible:", visibleButton);

    if (!visibleButton) {
      throw new Error("RezLive #search_go button is not visible.");
    }

    /*
     * Final form verification immediately before submitting.
     */
const beforeSubmit = await page.locator("#searchhotel").evaluate(form => {
      const names = [
        "preferedcity",
        "city_code",
        "destinationselect",
        "destinationselectnew",
        "destinationnew",
        "t-start",
        "t-end",
        "sel_days",
        "totalroomdetailval"
      ];

      const out = {};

      for (const name of names) {
        const el =
          form.querySelector(`#${name}`) ||
          form.querySelector(`[name="${name}"]`);

        if (el) {
          out[name] = el.value;
        }
      }

      return out;
    });

    /*
   * FINAL RezLive DATE GUARD
   *
   * RezLive's calendar JavaScript is restoring an old date into
   * #t-start / #t-end after our normal form population.
   *
   * Install capture listeners so the requested dates are restored
   * immediately before RezLive processes the search click/submit.
   */
  await page.locator("#searchhotel").evaluate(
    (form, data) => {
      const force = (selector, value) => {
        const el = form.querySelector(selector);
        if (!el) return false;

        const v = String(value);

        try {
          const proto =
            el instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLElement.prototype;

          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

          if (descriptor && descriptor.set) {
            descriptor.set.call(el, v);
          } else {
            el.value = v;
          }
        } catch {
          el.value = v;
        }

        el.setAttribute("value", v);

        return true;
      };

      const restoreDates = () => {
        force("#t-start", data.checkin);
        force("#t-end", data.checkout);
        force("#sel_days", data.nights);
      };

      /*
       * Capture the search button BEFORE RezLive's normal click
       * handlers execute.
       */
      document.addEventListener(
        "click",
        event => {
          const target = event.target instanceof Element
            ? event.target.closest("#search_go")
            : null;

          if (target) {
            restoreDates();
          }
        },
        true
      );

      /*
       * Capture the form submit BEFORE RezLive's submit handler.
       */
      form.addEventListener(
        "submit",
        () => {
          restoreDates();
        },
        true
      );

      /*
       * Expose a final emergency guard for the Playwright side.
       */
      window.__forceRezLiveDates = restoreDates;

      /*
       * FINAL REZLIVE GUEST GUARD
       *
       * RezLive can restore its default room guest values after our
       * normal population step. The portal's requested guest count
       * must therefore be restored at the same final stage as the dates.
       */
      const forceGuestValue = (selector, value) => {
        const el = form.querySelector(selector);
        if (!el) return false;

        const v = String(value);

        try {
          const proto =
            el instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLElement.prototype;

          const descriptor =
            Object.getOwnPropertyDescriptor(proto, "value");

          if (descriptor && descriptor.set) {
            descriptor.set.call(el, v);
          } else {
            el.value = v;
          }
        } catch {
          el.value = v;
        }

        el.setAttribute("value", v);

        return true;
      };

      const restoreGuests = () => {
        /*
         * Current portal search is one room. Keep the first RezLive
         * room synchronized with the requested guest count.
         */
        forceGuestValue(
          'input[name="RoomTypes[1][noofadult]"]',
          data.adults
        );

        forceGuestValue(
          'input[name="RoomTypes[1][noofchild]"]',
          data.children
        );

        forceGuestValue(
          "#totalroomdetailval",
          data.roomSummary
        );
      };

      /*
       * Restore guests BEFORE RezLive's normal click handlers.
       */
      document.addEventListener(
        "click",
        event => {
          const target =
            event.target instanceof Element
              ? event.target.closest("#search_go")
              : null;

          if (target) {
            restoreGuests();
          }
        },
        true
      );

      /*
       * Restore guests BEFORE RezLive's submit handler.
       */
      form.addEventListener(
        "submit",
        () => {
          restoreGuests();
        },
        true
      );

      window.__forceRezLiveGuests = restoreGuests;

      return true;
    },
    {
      checkin,
      checkout,
      nights
    }
  );

  /*
   * One final restoration immediately before the click.
   *
   * Keep both date and guest values synchronized at the last
   * possible moment before RezLive receives the submit event.
   */
  await page.evaluate(() => {
    if (typeof window.__forceRezLiveDates === "function") {
      window.__forceRezLiveDates();
    }

    if (typeof window.__forceRezLiveGuests === "function") {
      window.__forceRezLiveGuests();
    }
  });

  console.log("RezLive final date guard installed.");
  console.log("RezLive final guest guard installed.");
  console.log("RezLive final form before submit:");
    console.log(JSON.stringify(beforeSubmit, null, 2));

    /*
     * Click the real submit button.
     */
    await searchButton.click({ timeout: 10000, noWaitAfter: true });

    console.log("RezLive: #search_go clicked.");

    /*
     * Give the browser time to navigate/AJAX-load results.
     */
    console.log("RezLive: BEFORE RESULT WAIT:", wait);

await new Promise(resolve => setTimeout(resolve, wait));

console.log("RezLive: AFTER RESULT WAIT");

/*
 * RezLive result-render wait.
 *
 * /agency/hotel can return HTTP 200 before the hotel
 * result list has finished rendering into the DOM.
 */
console.log(
  "RezLive: waiting for hotel results to render..."
);

const renderStarted = Date.now();
let resultsRendered = false;

while (Date.now() - renderStarted < 30000) {

  const securityDuringWait = await blockedReason(page);

  if (securityDuringWait) {
    console.log(
      "RezLive: SECURITY VERIFICATION DETECTED DURING RESULT WAIT."
    );

    console.log(
      "RezLive security URL:",
      page.url()
    );

    throw new Error(securityDuringWait);
  }
  const state = await page.evaluate(() => {

    const hotelContainer =
      document.querySelector(
        "#hotels_list_display"
      );

    const hotelLinks =
      document.querySelectorAll(
        "#hotels_list_display a"
      ).length;

    const bodyText =
      String(
        document.body?.innerText || ""
      )
        .replace(/\s+/g, " ")
        .trim();

    const priceMatches =
      bodyText.match(
        /(?:USD|US\$|SAR|AED|EUR|GBP|PKR)\s*[\d,]+(?:\.\d{1,2})?/gi
      ) || [];

    return {
      hotelContainer: !!hotelContainer,
      hotelLinks,
      bodyLength: bodyText.length,
      priceCount: priceMatches.length,
      bodyPreview: bodyText.slice(0, 300)
    };
  }).catch(() => ({
    hotelContainer: false,
    hotelLinks: 0,
    bodyLength: 0,
    priceCount: 0,
    bodyPreview: ""
  }));

  console.log(
    "RezLive render state:",
    JSON.stringify(state)
  );

  if (
    state.hotelContainer &&
    (
      state.hotelLinks > 0 ||
      state.priceCount > 0
    )
  ) {
    resultsRendered = true;
    break;
  }

  await page.waitForTimeout(500);
}

console.log(
  "RezLive: hotel results rendered:",
  resultsRendered,
  "wait:",
  Math.round(
    (Date.now() - renderStarted) / 1000
  ) + "s"
);

    const security = await blockedReason(page);
    if (security) throw new Error(security);

    console.log("RezLive URL after search:", page.url());
    console.log("RezLive response status:", responseStatus);
    console.log("RezLive request URL:", requestUrl || "(not captured)");

    console.log("========================================");
    console.log("REZLIVE RESULT FRAME DIAGNOSTIC");
    console.log("PAGE URL:", page.url());

    const rezFrames = await allFrames(page);

    console.log("REZLIVE FRAME COUNT:", rezFrames.length);

    for (let fi = 0; fi < rezFrames.length; fi++) {
      const fr = rezFrames[fi];

      try {
        const info = await fr.evaluate(() => {
          const body = String(document.body?.innerText || "");
          const html = String(document.documentElement?.innerHTML || "");

          return {
            url: location.href,
            title: document.title,
            bodyLength: body.length,
            bodyText: body.slice(0, 5000),
            priceMatches: (
              body.match(
                /(?:USD|US\$|SAR|AED|EUR|GBP|PKR|\$)\s*[\d,]+(?:\.\d{1,2})?/gi
              ) || []
            ).slice(0, 50),
            hotelMatches: (
              body.match(
                /.{0,60}(?:hotel|room|available|rate|booking).{0,120}/gi
              ) || []
            ).slice(0, 30),
            htmlLength: html.length
          };
        });

        console.log(
          "REZLIVE FRAME",
          fi,
          JSON.stringify(info, null, 2)
        );
      } catch (e) {
        console.log(
          "REZLIVE FRAME",
          fi,
          "ERROR:",
          e.message
        );
      }
    }

    console.log("========================================");
    console.log("REZLIVE RESULT EXTRACTION START");

    /*
     * REZLIVE MULTI-PAGE EXTRACTION
     *
     * RezLive displays multiple result pages. The old extractor only
     * read the currently visible page. We now:
     *
     *   1. Detect the available pagination numbers.
     *   2. Extract the current page.
     *   3. Click page 2, 3, 4 ... dynamically.
     *   4. Wait for the hotel list to change.
     *   5. Extract every page.
     *
     * Existing date/destination/POST logic is untouched.
     */

    async function rezLivePaginationInfo(){
  return await page.mainFrame().evaluate(() => {
    const clean = v => String(v || '').replace(/\s+/g,' ').trim();

    const totalPageValues = [];

    // RezLive's actual total-page field.
    document.querySelectorAll('#totalpage, input[name="totalpage"], input[id*="totalpage"]').forEach(el => {
      const v = parseInt(String(el.value || el.textContent || '').trim(), 10);
      if (Number.isFinite(v) && v > 0 && v < 1000) {
        totalPageValues.push(v);
      }
    });

    // Actual RezLive pagination controls.
    const footerPageControls = [];

    document.querySelectorAll('[id^="footerpage"]').forEach(el => {
      const m = String(el.id || '').match(/^footerpage(\d+)$/i);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0 && n < 1000) {
          footerPageControls.push(`footerpage${n}`);
        }
      }
    });

    // Also accept the normal pageN controls, but ONLY when their id
    // explicitly identifies them as pagination controls.
    const explicitPageControls = [];

    document.querySelectorAll('[id^="page"]').forEach(el => {
      const id = String(el.id || '');
      const m = id.match(/^page(\d+)$/i);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0 && n < 1000) {
          explicitPageControls.push(n);
        }
      }
    });

    let pages = [];

    // Highest-confidence source: RezLive total-page field.
    if (totalPageValues.length) {
      const max = Math.max(...totalPageValues);
      pages = Array.from({length:max}, (_,i) => i + 1);
    }

    // Next: explicit footer pagination controls.
    if (!pages.length && footerPageControls.length) {
      const nums = footerPageControls
        .map(x => Number(x.replace(/^footerpage/i,'')))
        .filter(n => Number.isFinite(n) && n > 0);

      const max = Math.max(...nums);
      pages = Array.from({length:max}, (_,i) => i + 1);
    }

    // Next: explicit pageN controls.
    if (!pages.length && explicitPageControls.length) {
      const max = Math.max(...explicitPageControls);
      pages = Array.from({length:max}, (_,i) => i + 1);
    }

    // Last fallback: only inspect text inside known pagination containers.
    if (!pages.length) {
      const paginationTexts = [];

      document.querySelectorAll(
        '#pagination, .pagination, [class*="pagination"], [id*="pagination"]'
      ).forEach(el => {
        const t = clean(el.innerText || el.textContent || '');
        if (t) paginationTexts.push(t);
      });

      const nums = [];

      for (const text of paginationTexts) {
        const matches = text.match(/\b\d{1,3}\b/g) || [];
        for (const m of matches) {
          const n = Number(m);
          if (n > 0 && n < 1000) nums.push(n);
        }
      }

      if (nums.length) {
        const max = Math.max(...nums);
        pages = Array.from({length:max}, (_,i) => i + 1);
      }
    }

    if (!pages.length) pages = [1];

    const bodyPaginationText = clean(
      [...document.querySelectorAll('[id^="footerpage"], [id^="page"]')]
        .map(el => el.innerText || el.textContent || '')
        .join(' ')
    );

    return {
      pages,
      maxPage: Math.max(...pages),
      numericControls: document.querySelectorAll(
        '[id^="footerpage"], [id^="page"]'
      ).length,
      totalPageValues: [...new Set(totalPageValues)],
      footerPageControls: [...new Set(footerPageControls)].sort(),
      bodyPaginationText
    };
  });
}
async function rezLiveListSignature() {
      for (const frame of await allFrames(page)) {
        try {
          const signature = await frame.evaluate(() => {
            const root =
              document.querySelector("#hotels_list_display") ||
              document.querySelector(".hotel-search-result") ||
              document.body;

            const prices = Array.from(
              root.querySelectorAll(
                ".hotelpricediv.hotelbaseprice"
              )
            )
              .slice(0, 5)
              .map(el =>
                String(
                  el.innerText ||
                  el.textContent ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
              );

            const headers = Array.from(
              root.querySelectorAll(
                ".card-header,.result-full"
              )
            )
              .slice(0, 5)
              .map(el =>
                String(
                  el.innerText ||
                  el.textContent ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 300)
              );

            return JSON.stringify({
              prices,
              headers
            });
          });

          if (signature) {
            return signature;
          }
        } catch {}
      }

      return "";
    }

    async function rezLiveClickPage(pageNumber) {
      /*
       * RezLive uses a sliding pagination window.
       *
       * Example:
       *   1 2 3 4 5 6 7 8 9 10 >
       *
       * After page 10, page 11 is not necessarily present in the DOM.
       * We therefore:
       *
       *   1. Search the ENTIRE document for the requested page.
       *   2. If it is not visible, locate the pagination NEXT control.
       *   3. Click NEXT.
       *   4. Re-discover the fresh DOM.
       *   5. Click the requested page.
       *
       * Never cache element indexes between AJAX renders.
       */

      const wanted = String(Number(pageNumber));

      for (const frame of await allFrames(page)) {
        try {
          /*
           * We may need to advance RezLive's pagination window several
           * times. 29 pages normally needs only 2 window advances.
           */
          for (let attempt = 0; attempt < 6; attempt++) {

            const result = await frame.evaluate((wantedPage) => {

              /*
               * IMPORTANT:
               *
               * Pagination controls may live OUTSIDE the hotel result
               * container. Search document, not #hotels_list_display only.
               */
              const searchRoot = document;

              const clean = value =>
                String(value || "")
                  .replace(/\s+/g, " ")
                  .trim();

              /*
               * ---------------------------------------------------------
               * FIRST: look for the requested numeric page.
               * ---------------------------------------------------------
               */
              const nodes = Array.from(
                searchRoot.querySelectorAll(
                  'a,button,input,li,span,[role="button"]'
                )
              );

              const candidates = [];

              for (const el of nodes) {
                const value = clean(
                  el.innerText ||
                  el.textContent ||
                  el.value ||
                  ""
                );

                if (value !== wantedPage) {
                  continue;
                }

                const rect = el.getBoundingClientRect();

                if (
                  rect.width <= 0 ||
                  rect.height <= 0
                ) {
                  continue;
                }

                let clickable = el.closest(
                  'a,button,input,[role="button"]'
                );

                if (!clickable) {
                  clickable = el;
                }

                const clickableRect =
                  clickable.getBoundingClientRect();

                if (
                  clickableRect.width <= 0 ||
                  clickableRect.height <= 0
                ) {
                  continue;
                }

                const parent = clickable.parentElement;

                const meta = [
                  clickable.tagName || "",
                  clickable.id || "",
                  typeof clickable.className === "string"
                    ? clickable.className
                    : "",
                  clickable.getAttribute("href") || "",
                  clickable.getAttribute("onclick") || "",
                  clickable.getAttribute("data-page") || "",
                  clickable.getAttribute("data-pageno") || "",
                  clickable.getAttribute("data-page-number") || "",
                  clickable.getAttribute("aria-label") || "",
                  clickable.getAttribute("title") || "",
                  clickable.getAttribute("role") || "",
                  parent?.id || "",
                  typeof parent?.className === "string"
                    ? parent.className
                    : ""
                ].join(" ");

                let score = 0;

                if (/pagination/i.test(meta)) score += 100;
                if (/pager/i.test(meta)) score += 90;
                if (/paging/i.test(meta)) score += 90;
                if (/page-link/i.test(meta)) score += 85;
                if (/page-item/i.test(meta)) score += 80;
                if (/paginate/i.test(meta)) score += 75;

                if (
                  clickable.hasAttribute("data-page") ||
                  clickable.hasAttribute("data-pageno") ||
                  clickable.hasAttribute("data-page-number")
                ) {
                  score += 70;
                }

                if (
                  clickable.tagName === "A" ||
                  clickable.tagName === "BUTTON" ||
                  clickable.tagName === "INPUT"
                ) {
                  score += 40;
                }

                const href =
                  clickable.getAttribute("href") || "";

                const onclick =
                  clickable.getAttribute("onclick") || "";

                const pagePattern =
                  "(?:page|pageno|page_no|pageNumber|page_number)[^0-9]*" +
                  wantedPage +
                  "\\b";

                if (
                  href &&
                  new RegExp(pagePattern, "i").test(href)
                ) {
                  score += 120;
                }

                if (
                  onclick &&
                  new RegExp(pagePattern, "i").test(onclick)
                ) {
                  score += 120;
                }

                const activeMeta = [
                  typeof clickable.className === "string"
                    ? clickable.className
                    : "",
                  clickable.getAttribute("aria-current") || "",
                  clickable.getAttribute("data-active") || ""
                ].join(" ");

                const isActive =
                  clickable.getAttribute("aria-current") === "page" ||
                  /(^|[\s_-])(active|current|selected)([\s_-]|$)/i.test(
                    activeMeta
                  );

                if (isActive) {
                  score -= 1000;
                }

                candidates.push({
                  el: clickable,
                  score,
                  tag: clickable.tagName,
                  id: clickable.id || "",
                  className:
                    typeof clickable.className === "string"
                      ? clickable.className.slice(0, 300)
                      : "",
                  href: href.slice(0, 500),
                  onclick: onclick.slice(0, 500),
                  isActive
                });
              }

              if (candidates.length) {
                candidates.sort(
                  (a, b) => b.score - a.score
                );

                const best = candidates[0];

                /*
                 * If the requested page has become the current page
                 * because NEXT itself navigated there, that is already
                 * success.
                 */
                if (best.isActive) {
                  return {
                    clicked: true,
                    alreadyActive: true,
                    via: "pagination-window",
                    score: best.score,
                    tag: best.tag,
                    id: best.id,
                    className: best.className,
                    href: best.href,
                    onclick: best.onclick,
                    candidateCount: candidates.length
                  };
                }

                if (
                  best.el &&
                  best.el.isConnected
                ) {
                  try {
                    best.el.scrollIntoView({
                      block: "center",
                      inline: "center"
                    });
                  } catch {}

                  try {
                    best.el.click();
                  } catch (clickError) {
                    try {
                      best.el.dispatchEvent(
                        new MouseEvent("click", {
                          bubbles: true,
                          cancelable: true,
                          view: window
                        })
                      );
                    } catch (dispatchError) {
                      return {
                        clicked: false,
                        reason:
                          "click-failed:" +
                          clickError.message
                      };
                    }
                  }

                  return {
                    clicked: true,
                    via: "page-number",
                    score: best.score,
                    tag: best.tag,
                    id: best.id,
                    className: best.className,
                    href: best.href,
                    onclick: best.onclick,
                    candidateCount: candidates.length
                  };
                }
              }

              /*
               * ---------------------------------------------------------
               * SECOND: requested page isn't visible.
               *
               * Find a pagination NEXT control.
               * ---------------------------------------------------------
               */
              const nextCandidates = [];

              for (const el of nodes) {
                const value = clean(
                  el.innerText ||
                  el.textContent ||
                  el.value ||
                  ""
                );

                const aria =
                  clean(el.getAttribute("aria-label"));

                const title =
                  clean(el.getAttribute("title"));

                const href =
                  el.getAttribute("href") || "";

                const onclick =
                  el.getAttribute("onclick") || "";

                const id =
                  el.id || "";

                const className =
                  typeof el.className === "string"
                    ? el.className
                    : "";

                const meta = [
                  value,
                  aria,
                  title,
                  href,
                  onclick,
                  id,
                  className
                ].join(" ");

                /*
                 * Strong indicators that this is a pagination control.
                 */
                const paginationMeta =
                  /pagination|pager|paging|page-link|page-item|paginate/i.test(
                    meta
                  );

                /*
                 * Common RezLive/Bootstrap/jQuery next controls.
                 */
                const nextText =
                  /^(next|›|»|>|→)$/i.test(value) ||
                  /^(next|›|»|>|→)$/i.test(aria) ||
                  /^(next|›|»|>|→)$/i.test(title);

                const nextWord =
                  /\bnext\b/i.test(meta);

                /*
                 * Some pagination widgets use javascript such as:
                 * paginationHotel(...,nextPage)
                 *
                 * or classes like next/page-next.
                 */
                const nextClass =
                  /\bnext\b|page-next|pagination-next/i.test(
                    className
                  );

                if (
                  !paginationMeta &&
                  !nextText &&
                  !nextWord &&
                  !nextClass
                ) {
                  continue;
                }

                const rect =
                  el.getBoundingClientRect();

                if (
                  rect.width <= 0 ||
                  rect.height <= 0
                ) {
                  continue;
                }

                let clickable = el.closest(
                  'a,button,input,[role="button"]'
                );

                if (!clickable) {
                  clickable = el;
                }

                const clickableRect =
                  clickable.getBoundingClientRect();

                if (
                  clickableRect.width <= 0 ||
                  clickableRect.height <= 0
                ) {
                  continue;
                }

                const clickableMeta = [
                  clickable.tagName || "",
                  clickable.id || "",
                  typeof clickable.className === "string"
                    ? clickable.className
                    : "",
                  clickable.getAttribute("href") || "",
                  clickable.getAttribute("onclick") || "",
                  clickable.getAttribute("aria-label") || "",
                  clickable.getAttribute("title") || "",
                  clickable.getAttribute("role") || "",
                  clickable.parentElement?.id || "",
                  typeof clickable.parentElement?.className === "string"
                    ? clickable.parentElement.className
                    : ""
                ].join(" ");

                let score = 0;

                if (/pagination/i.test(clickableMeta)) score += 150;
                if (/pager/i.test(clickableMeta)) score += 130;
                if (/paging/i.test(clickableMeta)) score += 130;
                if (/page-next/i.test(clickableMeta)) score += 150;
                if (/\bnext\b/i.test(clickableMeta)) score += 140;

                if (
                  clickable.tagName === "A" ||
                  clickable.tagName === "BUTTON" ||
                  clickable.tagName === "INPUT"
                ) {
                  score += 50;
                }

                if (
                  clickable.getAttribute("disabled") !== null ||
                  clickable.classList.contains("disabled")
                ) {
                  score -= 1000;
                }

                if (
                  clickable.getAttribute("aria-disabled") === "true"
                ) {
                  score -= 1000;
                }

                /*
                 * Avoid hotel-card "next" controls. Pagination metadata
                 * receives a large bonus.
                 */
                if (nextText) score += 80;
                if (nextWord) score += 40;
                if (nextClass) score += 100;

                nextCandidates.push({
                  el: clickable,
                  score,
                  tag: clickable.tagName,
                  id: clickable.id || "",
                  className:
                    typeof clickable.className === "string"
                      ? clickable.className.slice(0, 300)
                      : "",
                  href:
                    (clickable.getAttribute("href") || "").slice(0, 500),
                  onclick:
                    (clickable.getAttribute("onclick") || "").slice(0, 500)
                });
              }

              if (!nextCandidates.length) {
                return {
                  clicked: false,
                  reason: "no-page-number-and-no-next-control"
                };
              }

              nextCandidates.sort(
                (a, b) => b.score - a.score
              );

              const next = nextCandidates[0];

              if (
                !next.el ||
                !next.el.isConnected
              ) {
                return {
                  clicked: false,
                  reason: "next-candidate-detached"
                };
              }

              try {
                next.el.scrollIntoView({
                  block: "center",
                  inline: "center"
                });
              } catch {}

              try {
                next.el.click();
              } catch (clickError) {
                try {
                  next.el.dispatchEvent(
                    new MouseEvent("click", {
                      bubbles: true,
                      cancelable: true,
                      view: window
                    })
                  );
                } catch (dispatchError) {
                  return {
                    clicked: false,
                    reason:
                      "next-click-failed:" +
                      clickError.message
                  };
                }
              }

              return {
                clicked: false,
                advancedWindow: true,
                via: "next-control",
                score: next.score,
                tag: next.tag,
                id: next.id,
                className: next.className,
                href: next.href,
                onclick: next.onclick,
                candidateCount: nextCandidates.length
              };
            }, wanted);

            console.log(
              "RezLive pagination DOM click:",
              pageNumber,
              JSON.stringify(result)
            );

            /*
             * Direct page click succeeded.
             */
            if (result && result.clicked) {
              await page.waitForTimeout(
                result.alreadyActive ? 300 : 300
              );

              return true;
            }

            /*
             * We clicked the pagination-window NEXT control.
             * Let RezLive re-render, then search again for the
             * requested page using a completely fresh DOM.
             */
            if (
              result &&
              result.advancedWindow
            ) {
              console.log(
                "RezLive: pagination window advanced while looking for page",
                pageNumber
              );

              await page.waitForTimeout(700);

              continue;
            }

            /*
             * Nothing useful found in this frame.
             */
            break;
          }
        } catch (e) {
          console.log(
            "RezLive: pagination DOM click attempt failed:",
            pageNumber,
            e.message
          );
        }
      }

      return false;
    }
    /*
     * Discover pagination.
     */
    const pagination = await rezLivePaginationInfo();

    console.log(
      "REZLIVE PAGINATION DETECTED:",
      JSON.stringify({
        pages: pagination.pages,
        maxPage: pagination.maxPage
      })
    );

    /*
     * Safety limit prevents an accidental broken pagination widget
     * from creating an endless loop.
     */
    const maxRezLivePages = Math.min(
      Math.max(Number(pagination.maxPage) || 1, 1),
      50
    );

    console.log(
      "REZLIVE TOTAL PAGES TO EXTRACT:",
      maxRezLivePages
    );

    let rows = [];
    let extractedPages = 0;

    for (
      let pageNumber = 1;
      pageNumber <= maxRezLivePages;
      pageNumber++
    ) {
      console.log(
        "========================================"
      );

      console.log(
        "REZLIVE EXTRACTING PAGE:",
        pageNumber,
        "/",
        maxRezLivePages
      );

      /*
       * Page 1 is already loaded.
       * For later pages click the corresponding pagination control.
       */
      if (pageNumber > 1) {
        const beforeSignature =
          await rezLiveListSignature();

        const clicked =
          await rezLiveClickPage(pageNumber);

        if (!clicked) {
          console.log(
            "RezLive: pagination page control not found:",
            pageNumber
          );

          break;
        }

        /*
         * Wait for the list to change. RezLive may use AJAX rather
         * than a full navigation.
         */
        const started = Date.now();
        let changed = false;

        while (Date.now() - started < 15000) {
          await page.waitForTimeout(500);

          const afterSignature =
            await rezLiveListSignature();

          if (
            afterSignature &&
            afterSignature !== beforeSignature
          ) {
            changed = true;
            break;
          }
        }

        console.log(
          "RezLive: page",
          pageNumber,
          "content changed:",
          changed
        );

        /*
         * Give the page's hotel cards a little additional time to
         * finish rendering after the pagination event.
         */
        await page.waitForTimeout(1000);
      }

      const currentFrames =
        await allFrames(page);

      let pageRows = [];

      /*
       * FAST REZLIVE MODE
       *
       * Do NOT open every hotel during the initial search.
       *
       * RezLive hotel names can be opened later by the View Rates
       * action. Initial search only extracts the lightweight hotel
       * list/base-price information.
       *
       * This keeps the search fast and avoids:
       *   - opening every hotel
       *   - waiting up to 10 seconds per hotel
       *   - repeatedly rendering room/rate details
       *   - excessive CPU/RAM/network usage
       */
      for (const frame of currentFrames) {
        try {
          const extracted =
            await extractRatesFromFrame(
              frame,
              cfg
            );

          if (extracted && extracted.length) {
            pageRows.push(...extracted);
          }
        } catch (e) {
          console.log(
            "RezLive lightweight extraction error:",
            e.message
          );
        }
      }
      /*
       * Remove obvious "rate starting from" pseudo rows here.
       */
      pageRows = pageRows.filter(row => {
        const hotel = String(
          row.hotel || ""
        )
          .replace(/\s+/g, " ")
          .trim();

        if (!hotel) {
          return false;
        }

        if (
          /^(rate starting from|starting from|from|price|rate)$/i.test(
            hotel
          )
        ) {
          return false;
        }

        const price = Number(row.price);

        return (
          Number.isFinite(price) &&
          price > 0
        );
      });

      console.log(
        "RezLive: page",
        pageNumber,
        "extracted rows:",
        pageRows.length
      );

      rows.push(...pageRows);
      extractedPages++;

      console.log(
        "RezLive: cumulative rows:",
        rows.length
      );
    }

    /*
     * Remove malformed rows caused by RezLive returning a large
     * ancestor containing several hotel cards.
     */
    rows = rows.filter(row => {
      const hotel = String(
        row.hotel || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const rawText = String(
        row.raw?.text ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (!hotel) {
        return false;
      }

      if (
        /^(rate starting from|starting from|from|price|rate)$/i.test(
          hotel
        )
      ) {
        return false;
      }

      const availableCount = (
        rawText.match(/\bAvailable\b/gi) || []
      ).length;

      const usdCount = (
        rawText.match(/\bUSD\b/gi) || []
      ).length;

      /*
       * A single genuine rate row should not contain the complete
       * listing for many hotels.
       */
      if (availableCount > 1) {
        return false;
      }

      if (usdCount > 2) {
        return false;
      }

      if (
        /Easily compare in a single view|Smart AI Insights|ref_chip_rooms|Property Description:/i.test(
          rawText
        )
      ) {
        return false;
      }

      /*
       * Reject obvious CSS/AI contamination.
       */
      if (
        /(?:display\s*:\s*(?:flex|block|grid)|font-size\s*:|margin\s*:|padding\s*:|color\s*:|background\s*:|border\s*:)/i.test(
          rawText
        )
      ) {
        return false;
      }

      const price = Number(row.price);

      return (
        Number.isFinite(price) &&
        price > 0
      );
    });
    /*
     * Final cross-page deduplication.
     */
    const seen = new Set();

    rows = rows.filter(row => {
      const price = Number(row.price);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return false;
      }

      const hotel = String(
        row.hotel || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      if (
        !hotel ||
        /^(rate starting from|starting from|from|price|rate)$/i.test(
          hotel
        )
      ) {
        return false;
      }

      const key = [
        hotel,
        row.room || "",
        row.view || "",
        row.board || "",
        row.cancellation || "",
        price,
        row.currency || ""
      ]
        .join("|")
        .toLowerCase();

      // RezLive reuses hotelname_0, hotelname_1, etc. on every page.
      // Keep legitimate hotels from different pages separate.
      const rezHotelId = String(
        row.hotelId || row.raw?.hotelId || ""
      ).trim().toLowerCase();

      const finalKey = rezHotelId
        ? `${key}|${rezHotelId}`
        : `${key}|${hotel}`;

      if (seen.has(finalKey)) {
        return false;
      }

      seen.add(finalKey);
      return true;
    });

    rows.sort((a, b) => {
      const pa = Number(a.price);
      const pb = Number(b.price);

      if (pa !== pb) {
        return pa - pb;
      }

      return String(a.hotel || "")
        .localeCompare(
          String(b.hotel || "")
        );
    });

    console.log(
      "========================================"
    );

    console.log(
      "REZLIVE MULTI-PAGE EXTRACTION COMPLETE"
    );

    console.log(
      "RezLive pages extracted:",
      extractedPages
    );

    console.log(
      "RezLive total unique priced rows:",
      rows.length
    );


    if (rows.length) {
      console.log(
  "REZLIVE_DEBUG_ROWS_FILE"
);

try {
  require("fs").writeFileSync(
    require("path").join(__dirname, "..", "rezlive-debug-rows.json"),
    JSON.stringify(rows.slice(0, 20), null, 2),
    "utf8"
  );
} catch (e) {
  console.log(
    "RezLive debug rows write failed:",
    e.message
  );
}

console.log(
  "RezLive first extracted rows:",
  JSON.stringify(
    rows.slice(0, 10),
          null,
          2
        )
      );
    } else {
      console.log(
        "RezLive structured extractor found ZERO rows."
      );
    }

    return rows.slice(
      0,
      Number(cfg.max_results) || 500
    );
  } finally {
    page.off("request", requestListener);
    page.off("response", responseListener);
  }
}
async function searchBrowserSource(source,search){
  const cfg=source.browser_config||{};if(!source.login_url||!source.site_username||!source.site_password_enc)return{configured:false,results:[],error:null};
  let password;try{password=decrypt(source.site_password_enc);}catch(e){return{configured:true,results:[],error:`Credential decryption failed: ${e.message}`};}
  let browser=null,context=null;
  try{
    console.log(
      "REZLIVE SESSION CHECK:",
      JSON.stringify({
        preset: cfg.preset || "",
        hasSession: rezliveSession.hasRezLiveSession(),
        devtools: (() => {
          try {
            return rezliveSession.readDevToolsEndpoint();
          } catch (e) {
            return "ERROR: " + e.message;
          }
        })()
      }, null, 2)
    );
    if(cfg.preset==='rezlive'&&rezliveSession.hasRezLiveSession()){
      browser=await chromium.connectOverCDP(rezliveSession.readDevToolsEndpoint());context=browser.contexts()[0];if(!context)throw new Error('RezLive Chrome context not found');const pages=context.pages();console.log("REZLIVE CHROME PAGES:");for(let i=0;i<pages.length;i++){try{console.log(`  PAGE ${i}: ${pages[i].url()}`)}catch(e){console.log(`  PAGE ${i}: <url-error>`)}}let page=pages.find(p=>{try{return /^https?:\/\/([^/]+\.)?rezlive\.com/i.test(p.url())}catch(e){return false}});if(!page){page=pages.find(p=>{try{return /rezlive\.com/i.test(new URL(p.url()).hostname)}catch(e){return false}})}if(!page){console.log("REZLIVE: no existing RezLive tab found; creating fresh tab.");page=await context.newPage();await page.goto("https://www.rezlive.com/common/index",{waitUntil:"domcontentloaded",timeout:30000})}console.log("REZLIVE SELECTED PAGE:",page.url());page.setDefaultTimeout(Math.max(Number(cfg.timeout_ms)||12000,60000));const rezSearch={...search}; const rows=await searchRezLive(page,rezSearch,{...cfg,_authenticated:true});return{configured:true,results:rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number.isFinite(r.price)?r.price:number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r})).filter(r=>Number.isFinite(r.price)&&r.price>0),error:null};
    }
    browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(Number(cfg.timeout_ms)||12000);await page.goto(source.login_url,{waitUntil:'domcontentloaded',timeout:30000});
    if(cfg.preset==='rezlive'){const rows=await searchRezLive(page,search,{...cfg,_username:source.site_username,_password:password});return{configured:true,results:rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number.isFinite(r.price)?r.price:number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r})).filter(r=>Number.isFinite(r.price)&&r.price>0),error:null};}
    await loginGeneric(page,source,cfg,password);await navigateGenericSearch(page,search,cfg);
    if(cfg.results_wait_for_selector){
  const loc=await firstVisibleAnyFrame(page,[cfg.results_wait_for_selector]);
  if(loc){
    await loc.waitFor({
      state:"visible",
      timeout:Number(cfg.results_timeout_ms)||120000
    });
  }
}else{
  console.log("RezLive: waiting for result page...");

  const started=Date.now();
  const maxWait=Math.max(
    120000,
    Number(cfg.results_wait_ms)||120000
  );

  while(Date.now()-started<maxWait){
    const elapsed=Math.round((Date.now()-started)/1000);

    const state=await page.evaluate(()=>{
      const body=String(document.body?.innerText||"");

      const hasPrice=/(?:USD|US\$|SAR|AED|EUR|GBP|PKR|\$)\s*[\d,]+(?:\.\d{1,2})?/i.test(body);

      const hasHotel=/(hotel|room|available|availability|rate|booking|rooms)/i.test(body);

      return {
        hasPrice,
        hasHotel,
        length:body.length
      };
    }).catch(()=>({
      hasPrice:false,
      hasHotel:false,
      length:0
    }));

    console.log(
      "RezLive: result poll",
      elapsed+"s",
      JSON.stringify(state)
    );

    if(state.hasPrice && state.hasHotel && state.length>500){
      console.log("RezLive: results detected.");
      break;
    }

    await page.waitForTimeout(2000);
  }

  console.log(
    "RezLive: result wait finished after",
    Math.round((Date.now()-started)/1000),
    "seconds"
  );
}
    const blocked=await blockedReason(page);if(blocked)throw new Error(blocked);
    let rows=[];for(const frame of await allFrames(page))rows.push(...await extractRatesFromFrame(frame,cfg));const seen=new Set();rows=rows.filter(r=>{const p=Number(r.price);if(!Number.isFinite(p)||p<=0)return false;const k=`${r.hotel}|${r.room}|${r.board}|${p}|${r.currency}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,Number(cfg.max_results)||500);
    const results=rows.map((r,i)=>({id:`${source.id}-${i}`,supplier:source.name,hotel:r.hotel||'Hotel',room:r.room||'',view:r.view||'',board:r.board||search.board||'',cancellation:r.cancellation||'',price:Number(r.price),currency:r.currency||cfg.default_currency||'',availability:r.availability||'',raw:r.raw||r}));
    if(!results.length)return{configured:true,results:[],error:'Supplier login/search completed but no priced rates were extracted'};
    return{configured:true,results,error:null};
  }catch(e){
  console.error("========================================");
  console.error("REZLIVE CONNECTOR ERROR");
  console.error("ERROR NAME:", e.name);
  console.error("ERROR MESSAGE:", e.message);
  console.error("ERROR STACK:", e.stack);
  console.error("========================================");

  return{
    configured:true,
    results:[],
    error:e.name==='TimeoutError'
      ? `Supplier browser timed out: ${e.message}`
      : e.message
  };
}finally{
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
}
}

module.exports={searchBrowserSource,fillTemplate};









































































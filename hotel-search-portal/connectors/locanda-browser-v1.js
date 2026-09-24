const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_USER_DATA =
  process.env.REZLIVE_CHROME_USER_DATA ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data'
  );

const DEVTOOLS_ACTIVE_PORT = path.join(
  CHROME_USER_DATA,
  'DevToolsActivePort'
);

function readDevToolsEndpoint() {
  if (!fs.existsSync(DEVTOOLS_ACTIVE_PORT)) {
    throw new Error('Chrome DevToolsActivePort not found.');
  }

  const lines = fs.readFileSync(
    DEVTOOLS_ACTIVE_PORT,
    'utf8'
  )
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const port = Number(lines[0]);
  const wsPath = lines[1];

  if (!port || !wsPath) {
    throw new Error('Invalid Chrome DevToolsActivePort.');
  }

  return `ws://127.0.0.1:${port}${wsPath}`;
}

async function getLocandaPage(browser) {
  const pages = await browser.pages();

  let page = pages.find(p => {
    try {
      return /app\.locandahub\.com/i.test(p.url());
    } catch {
      return false;
    }
  });

  if (!page) {
    page = await browser.newPage();
  }

  return page;
}

async function searchLocanda(search, options = {}) {
  const timeout =
    Math.max(Number(options.timeout_ms) || 30000, 30000);

  const destination =
    String(
      search?.destination ||
      search?.city ||
      search?.destination_name ||
      search?.hotel_city ||
      ''
    ).trim();

  const checkin =
    String(
      search?.checkin ||
      search?.check_in ||
      ''
    ).trim();

  const checkout =
    String(
      search?.checkout ||
      search?.check_out ||
      ''
    ).trim();

  const rooms =
    String(
      search?.rooms ||
      search?.room_count ||
      1
    );

  const adults =
    String(
      search?.adults ||
      search?.adult_count ||
      2
    );

  if (!destination) {
    throw new Error('Locanda destination is required');
  }

  const devToolsActivePort =
    path.join(
      process.env.LOCANDA_CHROME_PROFILE ||
      path.join(
        process.env.LOCALAPPDATA || '',
        'Google',
        'Chrome',
        'User Data'
      ),
      'DevToolsActivePort'
    );

  let wsEndpoint = '';

  try {
    const portFile = fs.readFileSync(
      devToolsActivePort,
      'utf8'
    ).trim();

    const parts = portFile.split(/\r?\n/);

    if (parts.length >= 2 && parts[1]) {
      wsEndpoint =
        `ws://127.0.0.1:${parts[0].trim()}${parts[1].trim()}`;
    }
  } catch (_) {}

  if (!wsEndpoint) {
    const fallbackPortFile =
      path.join(
        process.env.LOCALAPPDATA || '',
        'Google',
        'Chrome',
        'User Data',
        'DevToolsActivePort'
      );

    try {
      const portFile =
        fs.readFileSync(
          fallbackPortFile,
          'utf8'
        ).trim();

      const parts = portFile.split(/\r?\n/);

      if (parts.length >= 2 && parts[1]) {
        wsEndpoint =
          `ws://127.0.0.1:${parts[0].trim()}${parts[1].trim()}`;
      }
    } catch (_) {}
  }

  if (!wsEndpoint) {
    throw new Error(
      'Locanda Chrome DevTools endpoint could not be detected'
    );
  }

  const browser =
    await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null
    });

  let page = null;

  try {
    const pages = await browser.pages();

    page =
      pages.find(p =>
        /app\.locandahub\.com/i.test(
          p.url() || ''
        )
      ) || null;

    if (!page) {
      page = await browser.newPage();
    }

    page.setDefaultTimeout(timeout);

    await page.goto(
      'https://app.locandahub.com/agent/booking/index.php',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    ).catch(() => {});

    await page.waitForSelector(
      '#gsearchsimple2, #gsearchsimple',
      { timeout: 30000 }
    );

    /*
     * Fill destination without using ElementHandle.click().
     * Locanda can contain hidden/duplicate autocomplete elements,
     * which causes Puppeteer's "Node is either not clickable"
     * error.
     */
    const destinationSelector =
      await page.evaluate(() => {
        const candidates = [
          '#gsearchsimple2',
          '#gsearchsimple'
        ];

        for (const selector of candidates) {
          const el =
            document.querySelector(selector);

          if (!el) continue;

          const rect =
            el.getBoundingClientRect();

          const style =
            window.getComputedStyle(el);

          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';

          if (visible) {
            return selector;
          }
        }

        return '#gsearchsimple';
      });

    await page.evaluate(
      ({ selector, value }) => {
        const el =
          document.querySelector(selector);

        if (!el) {
          throw new Error(
            'Locanda destination field could not be detected'
          );
        }

        el.focus();
        el.value = '';

        el.dispatchEvent(
          new Event('input', { bubbles: true })
        );

        el.dispatchEvent(
          new Event('change', { bubbles: true })
        );
      },
      {
        selector: destinationSelector,
        value: destination
      }
    );

    const locandaDestinationValue =
      destination
        .replace(/\s*-\s*Saudi Arabia\s*$/i, '')
        .trim();

    /*
     * Locanda autocomplete fix:
     * Type only the first three letters so Locanda can generate
     * its own Makkah (Saudi Arabia) suggestion.
     */
    const locandaAutocompletePrefix =
      locandaDestinationValue
        .toLowerCase()
        .startsWith('makkah')
        ? 'Mak'
        : locandaDestinationValue.slice(0, 4);

    await page.click('#gsearchsimple');

    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');

    await page.keyboard.press('Backspace');

    for (const ch of locandaAutocompletePrefix) {
      await page.keyboard.type(ch);

      await new Promise(resolve =>
        setTimeout(resolve, 300)
      );
    }

    console.log(
      'LOCANDA DESTINATION PREFIX TYPED:',
      locandaAutocompletePrefix
    );

    /*
    /*
     * Locanda autocomplete is AJAX-driven.
     * Poll until the matching .gsearch suggestion is actually
     * rendered and visible instead of checking only once.
     */
let suggestionInfo = null;

try {
  suggestionInfo =
    await page.waitForFunction(
      (wantedDestination) => {
        const clean = value =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const wantedBase =
          clean(wantedDestination)
            .replace(/\s*\([^)]*saudi arabia[^)]*\)\s*$/i, '')
            .replace(/\s*-\s*saudi arabia\s*$/i, '')
            .trim();

        const candidates =
          Array.from(
            document.querySelectorAll('.gsearch')
          );

        const match =
          candidates.find(el => {
            const text =
              clean(
                el.innerText ||
                el.textContent ||
                ''
              );

            const rect =
              el.getBoundingClientRect();

            const style =
              window.getComputedStyle(el);

            const textBase =
              text
                .replace(/\s*\([^)]*saudi arabia[^)]*\)\s*$/i, '')
                .replace(/\s*-\s*saudi arabia\s*$/i, '')
                .trim();

            const matchesDestination =
              textBase === wantedBase ||
              textBase.startsWith(wantedBase);

            const visible =
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0;

            return matchesDestination && visible;
          });

        if (!match) {
          return false;
        }

        try {
          match.scrollIntoView({
            block: 'center',
            inline: 'nearest'
          });
        } catch (_) {}

        const rect =
          match.getBoundingClientRect();

        return {
          text:
            match.innerText ||
            match.textContent ||
            '',
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        };
      },
      {
        timeout: 10000,
        polling: 100
      },
      locandaDestinationValue
    ).then(handle => handle.jsonValue());
} catch (error) {
  console.log(
    'LOCANDA AUTOCOMPLETE POLLING TIMEOUT:',
    error.message
  );

  const autocompleteDiagnostic =
    await page.evaluate(() => {
      const elements =
        Array.from(
          document.querySelectorAll('.gsearch')
        );

      return elements.map((el, index) => {
        const rect =
          el.getBoundingClientRect();

        const style =
          window.getComputedStyle(el);

        return {
          index,
          text:
            el.innerText ||
            el.textContent ||
            '',
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
          className: el.className || '',
          dataType: el.getAttribute('data-type'),
          dataName: el.getAttribute('data-name'),
          dataId: el.getAttribute('data-id')
        };
      });
    });

  console.log(
    'LOCANDA AUTOCOMPLETE DIAGNOSTIC CANDIDATES:',
    JSON.stringify(
      autocompleteDiagnostic,
      null,
      2
    )
  );

  suggestionInfo = null;
}

    console.log(
      'LOCANDA DESTINATION SUGGESTION FOUND:',
      JSON.stringify(
        suggestionInfo,
        null,
        2
      )
    );

    console.log(
      'LOCANDA DESTINATION SUGGESTION FOUND:',
      JSON.stringify(
        suggestionInfo,
        null,
        2
      )
    );

    let clickedSuggestion = false;

    if (suggestionInfo) {
      const x =
        suggestionInfo.left +
        suggestionInfo.width / 2;

      const y =
        suggestionInfo.top +
        suggestionInfo.height / 2;

      await page.mouse.move(x, y);

      await page.mouse.down();

      await new Promise(resolve =>
        setTimeout(resolve, 100)
      );

      await page.mouse.up();

      clickedSuggestion = true;
    }
    console.log(
      'LOCANDA DESTINATION SUGGESTION CLICKED:',
      clickedSuggestion
    );

    await new Promise(resolve =>
      setTimeout(resolve, 1000)
    );

    const locandaDestinationDebug =
      await page.evaluate(() => ({
        destination2: (() => {
          const el =
            document.querySelector(
              '#gsearchsimple2'
            );

          return el
            ? {
                id: el.id,
                name: el.name || '',
                value: el.value || ''
              }
            : null;
        })(),

        destination: (() => {
          const el =
            document.querySelector(
              '#gsearchsimple'
            );

          return el
            ? {
                id: el.id,
                name: el.name || '',
                value: el.value || ''
              }
            : null;
        })(),

        searchType:
          document.querySelector(
            '#searchType'
          )?.value || '',

        searchName:
          document.querySelector(
            '#searchName'
          )?.value || '',

        searchId:
          document.querySelector(
            '#searchId'
          )?.value || ''
      }));

    console.log(
      'LOCANDA DESTINATION AFTER SUGGESTION:',
      JSON.stringify(
        locandaDestinationDebug,
        null,
        2
      )
    );

    /*
     * If Locanda's autocomplete populated the field correctly,
     * do not overwrite it with the full destination string.
     */

    /*
     * Set the actual hidden Locanda dates.
     */
    await page.evaluate(
      ({ checkin, checkout }) => {
        const setValue =
          (selector, value) => {
            const el =
              document.querySelector(selector);

            if (!el) return false;

            el.value = value;

            el.dispatchEvent(
              new Event(
                'input',
                { bubbles: true }
              )
            );

            el.dispatchEvent(
              new Event(
                'change',
                { bubbles: true }
              )
            );

            return true;
          };

        setValue('#checkin', checkin);
        setValue('#checkout', checkout);

        const range =
          document.querySelector(
            '#rangepicker'
          );

        if (range) {
          range.value =
            `${formatDate(checkin)} to ${formatDate(checkout)}`;

          range.dispatchEvent(
            new Event(
              'input',
              { bubbles: true }
            )
          );

          range.dispatchEvent(
            new Event(
              'change',
              { bubbles: true }
            )
          );
        }

        function formatDate(value) {
          const m =
            String(value || '')
              .match(
                /^(\d{4})-(\d{2})-(\d{2})$/
              );

          if (!m) return value;

          return (
            `${m[3]}/${m[2]}/${m[1]}`
          );
        }
      },
      {
        checkin,
        checkout
      }
    );

    /*
     * Set rooms.
     */
    await page.evaluate(
      value => {
        const el =
          document.querySelector(
            'select[name="rooms"]'
          );

        if (!el) return;

        el.value = String(value);

        el.dispatchEvent(
          new Event(
            'input',
            { bubbles: true }
          )
        );

        el.dispatchEvent(
          new Event(
            'change',
            { bubbles: true }
          )
        );
      },
      rooms
    );

    /*
     * Set adults.
     */
    await page.evaluate(
      value => {
        const selects =
          Array.from(
            document.querySelectorAll(
              'select[name="adults[]"]'
            )
          );

        for (const el of selects) {
          try {
            el.value = String(value);

            el.dispatchEvent(
              new Event(
                'input',
                { bubbles: true }
              )
            );

            el.dispatchEvent(
              new Event(
                'change',
                { bubbles: true }
              )
            );
          } catch (_) {}
        }
      },
      adults
    );    /*
     * Search.
     *
     * Locanda's actual Search button is #a3uw5f.
     * Use Puppeteer's click so the browser performs the same
     * action as a real user click, then wait for navigation.
     */
    await page.waitForSelector(
      '#forn-search button',
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      const el = document.querySelector('#gsearchsimple');
      if (el && / - Saudi Arabia$/i.test(el.value)) {
        el.value = el.value.replace(/\s*-\s*Saudi Arabia$/i, ' (Saudi Arabia)');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });


    const locandaSearchFieldsDebug = await page.evaluate(async () => {
      const urls = [
        '/agent/booking/js/JsLocalSearch.js',
        '/agent/booking/js/index.js'
      ];

      const output = {};

      for (const url of urls) {
        try {
          const response = await fetch(url, {
            credentials: 'include'
          });

          const text = await response.text();

          output[url] = {
            ok: response.ok,
            status: response.status,
            matches: text
              .split(/\r?\n/)
              .map((line, index) => ({
                line: index + 1,
                text: line
              }))
              .filter(item =>
                /searchType|searchName|searchId|gsearchsimple|forn-search|autocomplete/i.test(item.text)
              )
              .slice(0, 100)
          };
        } catch (error) {
          output[url] = {
            error: String(error)
          };
        }
      }

      return output;
    });

    console.log(
      'LOCANDA SEARCH FIELDS JS DEBUG:',
      JSON.stringify(locandaSearchFieldsDebug, null, 2)
    );

    const locandaAutocompleteApiDebug = await page.evaluate(async () => {
      try {
        const response = await fetch('static/autocomplete.php?term=Makkah', { credentials: 'include' });
        const text = await response.text();
        return { ok: response.ok, status: response.status, url: response.url, text: text.slice(0, 10000) };
      } catch (error) {
        return { error: String(error) };
      }
    });

    console.log('LOCANDA AUTOCOMPLETE API DEBUG:', JSON.stringify(locandaAutocompleteApiDebug, null, 2));
    const locandaIndexJsSubmitDebug = await page.evaluate(async () => {
      try {
        const response = await fetch('/agent/booking/js/index.js', { credentials: 'include' });
        const text = await response.text();
        const lines = text.split(/\r?\n/);
        return lines.slice(320, 380).map((line, i) => ({ line: i + 321, text: line }));
      } catch (error) {
        return { error: String(error) };
      }
    });

    console.log('LOCANDA INDEX.JS SUBMIT DEBUG:', JSON.stringify(locandaIndexJsSubmitDebug, null, 2));

    const locandaSubmitDebug = await page.evaluate(() => {
      const button = Array.from(
        document.querySelectorAll('button.btn.btn-locanda.btn-block')
      ).find(el =>
        (el.innerText || el.textContent || '')
          .trim()
          .toLowerCase() === 'search'
      );

      const form = button ? button.closest('form') : document.querySelector('#forn-search');

      return {
        button: button ? {
          outerHTML: button.outerHTML,
          onclick: button.getAttribute('onclick') || '',
          type: button.getAttribute('type') || '',
          formAction: button.getAttribute('formaction') || '',
          formMethod: button.getAttribute('formmethod') || ''
        } : null,
        form: form ? {
          action: form.getAttribute('action') || '',
          method: form.getAttribute('method') || '',
          onsubmit: form.getAttribute('onsubmit') || '',
          id: form.id || ''
        } : null,
        scripts: Array.from(document.scripts).map(s => s.src || '').filter(Boolean)
      };
    });

    console.log(
      'LOCANDA SUBMIT DEBUG:',
      JSON.stringify(locandaSubmitDebug, null, 2)
    );
    const locandaButtonDebug = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));

      return {
        url: location.href,
        title: document.title,
        buttons: buttons.map((el, index) => ({
          index,
          tag: el.tagName,
          id: el.id || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          value: el.getAttribute('value') || '',
          text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
          className: typeof el.className === 'string' ? el.className : '',
          disabled: !!el.disabled
        }))
      };
    });

    console.log(
      'LOCANDA SEARCH BUTTON DEBUG:',
      JSON.stringify(locandaButtonDebug, null, 2)
    );

    const locandaSearchInspect = await page.evaluate(() => {
      const el = Array.from(
        document.querySelectorAll('button.btn.btn-locanda.btn-block')
      ).find(button =>
        (button.innerText || button.textContent || '')
          .trim()
          .toLowerCase() === 'search'
      );

      if (!el) {
        return {
          found: false
        };
      }

      const form = el.closest('form');

      return {
        found: true,
        outerHTML: el.outerHTML,
        parentHTML: el.parentElement ? el.parentElement.outerHTML.slice(0, 5000) : '',
        form: form ? {
          outerHTML: form.outerHTML.slice(0, 10000),
          action: form.getAttribute('action') || '',
          method: form.getAttribute('method') || '',
          id: form.id || '',
          className: form.className || ''
        } : null
      };
    });

    console.log(
      'LOCANDA SEARCH BUTTON INSPECT:',
      JSON.stringify(locandaSearchInspect, null, 2)
    );

    const searchButtonFound = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('button.btn.btn-locanda.btn-block')
      );

      const el = buttons.find(button =>
        (button.innerText || button.textContent || '')
          .trim()
          .toLowerCase() === 'search'
      );

      if (!el) {
        return false;
      }

      el.click();
      return true;
    });

    if (!searchButtonFound) {
      throw new Error(
        'Locanda Search button could not be detected'
      );
    }

    /*
     * Locanda redirects to search.php and then populates
     * hotel rows dynamically. Wait for the search page first,
     * then allow the result list to appear.
     * Do not click Show Rooms here.
     */
    /*
     * Locanda navigates from index.php to search.php after the
     * Search button is clicked. Poll Puppeteer's page URL instead
     * of using waitForFunction, because navigation can destroy the
     * previous page execution context.
     */
    const navigationDeadline = Date.now() + 60000;

    while (
      Date.now() < navigationDeadline &&
      !/\/agent\/booking\/search\.php/i.test(page.url())
    ) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (
      !/\/agent\/booking\/search\.php/i.test(page.url())
    ) {
      throw new Error(
        'Locanda search did not navigate to search.php. URL: ' +
        page.url()
      );
    }

    const resultWaitDeadline = Date.now() + 60000;

    while (
      Date.now() < resultWaitDeadline &&
      await page.$$eval('.hotel-row', rows => rows.length).catch(() => 0) === 0
    ) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const locandaHotelRowCount =
      await page.$$eval(
        '.hotel-row',
        rows => rows.length
      ).catch(() => 0);

    if (!locandaHotelRowCount) {
      throw new Error(
        'Locanda search page loaded but no hotel rows were found. URL: ' +
        page.url()
      );
    }

    /*
     * LOCANDA PAGINATION
     *
     * Keep the existing first-page hotel extraction logic,
     * but continue through all Locanda result pages.
     *
     * Locanda uses:
     *
     *   /agent/booking/search.php?id=SEARCH_ID&debut=10
     *   /agent/booking/search.php?id=SEARCH_ID&debut=20
     *   /agent/booking/search.php?id=SEARCH_ID&debut=30
     *
     * Each page contains up to 10 .hotel-row elements.
     *
     * We stay on the existing Locanda Puppeteer page/session.
     * We do NOT create another Chrome connection.
     */

    const extractLocandaHotels = async () => {
      const debugHotels = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".hotel-row"))
          .map((row, index) => {
            const roomButton = row.querySelector(".btn-rooms[link]");
            return {
              index,
              rowId: row.id || "",
              hotel: String(
                row.querySelector(".info")?.innerText ||
                row.querySelector(".info")?.textContent ||
                ""
              ).replace(/\s+/g, " ").trim(),
              link: roomButton?.getAttribute("link") || ""
            };
          });
      });

      console.log(
        "LOCANDA EXTRACTION DEBUG:",
        JSON.stringify(debugHotels, null, 2)
      );

      return await page.evaluate(() => {
        const rows =
          Array.from(
            document.querySelectorAll(
              ".hotel-row"
            )
          );

        return rows
          .map((row, index) => {

            /*
             * Locanda live DOM:
             *
             * <span class="info">Hotel Name</span>
             */
            let hotel =
              String(
                row.querySelector(".info")?.innerText ||
                row.querySelector(".info")?.textContent ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim();

            /*
             * Fallback if Locanda changes the hotel-name markup.
             */
            if (!hotel) {
              const heading =
                row.querySelector(
                  "h1,h2,h3,h4,h5,strong"
                );

              hotel =
                String(
                  heading?.innerText ||
                  heading?.textContent ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim();
            }

            if (!hotel) {
              hotel = "Hotel";
            }

            /*
             * IMPORTANT:
             *
             * Locanda does NOT use a normal <button>.
             * The live DOM uses:
             *
             * <buttton class="btn-rooms" link="availability.php?...">
             *
             * We read the "link" attribute.
             * We do NOT click Show Rooms.
             */
            let availability = "";

            const roomButton =
              row.querySelector(
                ".btn-rooms[link]"
              );

            const roomLink =
              roomButton?.getAttribute(
                "link"
              ) || "";

            if (
              /availability\.php/i.test(
                roomLink
              )
            ) {
              availability =
                new URL(
                  roomLink,
                  location.href
                ).href;
            }

            return {
              id:
                row.id ||
                "locanda-" + (index + 1),

              hotel,

              availability,

              view:
                availability
                  ? "View Rates"
                  : "Show Rooms",

              raw: {
                hotelRowId:
                  row.id || "",

                text:
                  String(
                    row.innerText ||
                    row.textContent ||
                    ""
                  )
                    .replace(/\s+/g, " ")
                    .trim()
              }
            };
          })
          .filter(item => item.hotel);
      });
    };

    const extractLocandaPagination = async () => {
      return await page.evaluate(() => {
        const clean = value =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const links =
          Array.from(
            document.querySelectorAll(
              ".pagination a[href]"
            )
          );

        return links
          .map((link, index) => {
            const text =
              clean(
                link.innerText ||
                link.textContent ||
                ""
              );

            const href =
              link.href || "";

            const match =
              href.match(
                /[?&]debut=(\d+)/i
              );

            return {
              index,
              text,
              href,
              debut:
                match
                  ? Number(match[1])
                  : null
            };
          })
          .filter(item =>
            item.href &&
            (
              item.debut !== null ||
              /^>>$|^>$|^next$/i.test(item.text)
            )
          );
      });
    };

    const allHotels = [];

    /*
     * Prevent accidental infinite loops.
     * 100 pages is far above the current Locanda result size.
     */
    const maxLocandaPages = 100;

    let locandaPageNumber = 1;
    let currentSearchUrl = page.url();
    let visitedUrls = new Set();

    while (
      locandaPageNumber <= maxLocandaPages
    ) {
      const normalizedUrl =
        String(currentSearchUrl || page.url());

      if (visitedUrls.has(normalizedUrl)) {
        console.log(
          "LOCANDA PAGINATION: URL already visited, stopping:",
          normalizedUrl
        );
        break;
      }

      visitedUrls.add(normalizedUrl);

      /*
       * Page 1 is already loaded by the existing search flow.
       * Later pages are loaded below.
       */
      if (locandaPageNumber > 1) {
        console.log(
          "LOCANDA PAGINATION: loading page",
          locandaPageNumber,
          currentSearchUrl
        );

        /*
         * IMPORTANT:
         * Locanda pagination must be performed by clicking the
         * actual pagination <a>. Direct page.goto() changes the URL
         * but can leave the old first-page hotel DOM in place.
         */

        console.log(
          "LOCANDA PAGINATION: clicking real pagination link:",
          currentSearchUrl
        );

        const previousHotelIds =
          await page.evaluate(() =>
            Array.from(
              document.querySelectorAll(".hotel-row")
            )
              .map(row => row.id || "")
              .filter(Boolean)
          );

        /*
         * Locanda pagination anchors use relative href attributes,
         * while currentSearchUrl is absolute.
         *
         * Match against the browser-resolved a.href instead of
         * the raw href attribute.
         *
         * This also reproduces the real DOM anchor click that was
         * confirmed manually in Chrome DevTools.
         */
        const paginationClickResult =
          await page.evaluate((targetUrl) => {
            const links = Array.from(
              document.querySelectorAll(
                ".pagination a[href]"
              )
            );

            const link = links.find(
              anchor => anchor.href === targetUrl
            );

            if (!link) {
              return {
                found: false,
                hrefs: links.map(anchor => anchor.href)
              };
            }

            link.click();

            return {
              found: true,
              href: link.href,
              text:
                link.innerText ||
                link.textContent ||
                ""
            };
          }, currentSearchUrl);

        if (!paginationClickResult.found) {
          console.log(
            "LOCANDA PAGINATION: pagination link not found:",
            {
              targetUrl: currentSearchUrl,
              availableLinks:
                paginationClickResult.hrefs
            }
          );
          break;
        }

        console.log(
          "LOCANDA PAGINATION: pagination link clicked:",
          {
            text:
              paginationClickResult.text,
            href:
              paginationClickResult.href
          }
        );

        /*
         * Locanda may keep the same browser URL while replacing
         * the hotel result DOM. Therefore wait for the hotel IDs
         * to become different instead of waiting for the URL.
         */
        const resultChangeDeadline =
          Date.now() + 30000;

        let resultChanged = false;

        while (
          Date.now() < resultChangeDeadline
        ) {
          const currentHotelIds =
            await page.evaluate(() =>
              Array.from(
                document.querySelectorAll(".hotel-row")
              )
                .map(row => row.id || "")
                .filter(Boolean)
            );

          if (
            currentHotelIds.length > 0 &&
            (
              previousHotelIds.length === 0 ||
              currentHotelIds.join("|") !==
                previousHotelIds.join("|")
            )
          ) {
            resultChanged = true;

            console.log(
              "LOCANDA PAGINATION: hotel DOM changed:",
              {
                previousFirst:
                  previousHotelIds[0] || null,
                currentFirst:
                  currentHotelIds[0] || null,
                rows:
                  currentHotelIds.length
              }
            );

            break;
          }

          await new Promise(resolve =>
            setTimeout(resolve, 500)
          );
        }

        if (!resultChanged) {
          console.log(
            "LOCANDA PAGINATION: hotel DOM did not change after click."
          );
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );

        console.log(
          "LOCANDA PAGINATION: after real click:",
          {
            url: page.url(),
            rows:
              await page
                .$eval(
                  ".hotel-row",
                  rows => rows.length
                )
                .catch(() => 0)
          }
        );


        /*
         * Locanda may finish navigation before the hotel cards
         * are available in the DOM. Do not depend on the
         * .hotel-row selector here because extraction already
         * knows the actual Locanda hotel-card structure.
         *
         * Wait for extractLocandaHotels() to return hotels.
         */
        const pageWaitDeadline =
          Date.now() + 60000;

        let pageHotels = [];

        while (
          Date.now() < pageWaitDeadline
        ) {
          pageHotels =
            await extractLocandaHotels();

          console.log(
            "LOCANDA PAGINATION: waiting for hotels:",
            {
              page: locandaPageNumber,
              hotels: pageHotels.length,
              url: page.url()
            }
          );

          if (pageHotels.length > 0) {
            break;
          }

          await new Promise(
            resolve => setTimeout(resolve, 1000)
          );
        }

        if (!pageHotels.length) {
          console.log(
            "LOCANDA PAGINATION: no hotels extracted on page",
            locandaPageNumber,
            "- stopping."
          );
          break;
        }
      }

      const pageHotels =
        await extractLocandaHotels();

      console.log(
        "LOCANDA PAGINATION: page collected:",
        {
          page: locandaPageNumber,
          hotels: pageHotels.length,
          url: page.url()
        }
      );

      allHotels.push(...pageHotels);

      /*
       * Read the REAL pagination links from the current page.
       */
      const paginationLinks =
        await extractLocandaPagination();

      console.log(
        "LOCANDA PAGINATION: controls:",
        paginationLinks
      );

      if (!paginationLinks.length) {
        console.log(
          "LOCANDA PAGINATION: no pagination controls found. Done."
        );
        break;
      }

      /*
       * Determine our current result offset.
       *
       * Page 1 has no debut parameter.
       * Later pages use debut=10, 20, 30, ...
       */
       /*
        * IMPORTANT:
        * Locanda keeps page.url() on the original search URL
        * after a pagination anchor click.
        *
        * Therefore page.url() cannot tell us which logical
        * result page we are currently viewing.
        *
        * currentSearchUrl is the pagination URL selected for
        * this iteration, so use it to track the logical debut.
        */
       const logicalSearchUrl =
         String(currentSearchUrl || "");

       const currentDebutMatch =
         logicalSearchUrl.match(
           /[?&]debut=(\d+)/i
         );

       const currentDebut =
         currentDebutMatch
           ? Number(currentDebutMatch[1])
           : 0;

      /*
       * Find the smallest real pagination offset greater
       * than the current offset.
       *
       * This intentionally ignores Locanda's ">>" last-page
       * shortcut when intermediate offsets are available.
       */
      const nextNumeric =
        paginationLinks
          .filter(item =>
            Number.isFinite(item.debut) &&
            item.debut > currentDebut
          )
          .sort(
            (a, b) =>
              a.debut - b.debut
          )[0];

      /*
       * If the visible pagination only exposes the final ">>"
       * shortcut, use Locanda's own href as a fallback.
       *
       * This preserves the supplier's actual pagination URL.
       */
      let nextLink =
        nextNumeric || null;

      if (!nextLink) {
        const fallback =
          paginationLinks.find(item =>
            /^(>>|>|next)$/i.test(
              item.text
            ) &&
            Number.isFinite(item.debut) &&
            item.debut > currentDebut
          );

        if (fallback) {
          nextLink = fallback;
        }
      }

      if (!nextLink) {
        console.log(
          "LOCANDA PAGINATION: no next result page found. Done."
        );
        break;
      }

      const nextUrl =
        nextLink.href;

      if (!nextUrl) {
        console.log(
          "LOCANDA PAGINATION: next link has no URL. Done."
        );
        break;
      }

      if (visitedUrls.has(nextUrl)) {
        console.log(
          "LOCANDA PAGINATION: next URL already visited. Done:",
          nextUrl
        );
        break;
      }

      console.log(
        "LOCANDA PAGINATION: ADVANCING:",
        {
          fromPage: locandaPageNumber,
          fromDebut: currentDebut,
          nextText: nextLink.text,
          nextDebut: nextLink.debut,
          nextUrl
        }
      );

      currentSearchUrl =
        nextUrl;

      locandaPageNumber++;
    }

    /*
     * Deduplicate results.
     *
     * Availability URL is the strongest identifier.
     * Fall back to hotel name when a URL is unavailable.
     */
    const hotels = [];

    const seenHotels =
      new Set();

    for (const hotel of allHotels) {
      const key =
        hotel.availability
          ? "availability:" +
            hotel.availability
          : "hotel:" +
            String(hotel.hotel || "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();

      if (seenHotels.has(key)) {
        continue;
      }

      seenHotels.add(key);
      hotels.push(hotel);
    }

    console.log(
      "LOCANDA: ALL PAGINATION RESULTS COLLECTED:",
      {
        pagesRead: locandaPageNumber,
        rawHotels: allHotels.length,
        uniqueHotels: hotels.length
      }
    );

    const pricedHotels = [];

    for (let i = 0; i < hotels.length; i++) {
      const hotel = hotels[i];

      if (!hotel.availability) {
        continue;
      }

      try {
        console.log(
          "LOCANDA RATES:",
          `${i + 1}/${hotels.length}`,
          hotel.hotel
        );

        const rateData = await getLocandaRates(
          hotel.availability,
          {
            hotel: hotel.hotel,
            browser,
            page
          }
        );

        const rates = Array.isArray(rateData?.rates)
          ? rateData.rates
          : [];

        const validRates = rates
          .map(rate => ({
            rate,
            amount: Number.parseFloat(
              String(rate?.amount || "").replace(/,/g, "")
            )
          }))
          .filter(item => Number.isFinite(item.amount) && item.amount > 0);

        if (validRates.length === 0) {
          continue;
        }

        validRates.sort((a, b) => a.amount - b.amount);

        const lowest = validRates[0];
        const rate = lowest.rate;

        pricedHotels.push({
          id: hotel.id,
          supplier: "Locanda",
          hotel: hotel.hotel || "",
          room: "",
          view: "View Rates",
          board: "",
          cancellation: "",
          price: lowest.amount,
          currency: rate.currency || "USD",
          availability: "Available",
          supplierRoomCode: rate.roomId || "",
          rateFrom: "",
          rateTo: "",
          raw: {
            hotelRowId: hotel.raw?.hotelRowId || "",
            availability: hotel.availability,
            lowestRate: {
              roomId: rate.roomId || "",
              amount: rate.amount || "",
              room: rate.room || "",
              meal: rate.meal || "",
              currency: rate.currency || "",
              cancellation: rate.cancellation || ""
            },
            rates
          }
        });
      } catch (error) {
        console.error(
          "LOCANDA RATE ERROR:",
          hotel.hotel,
          error.message
        );
      }
    }

    console.log(
      "LOCANDA: PRICED RESULTS:",
      {
        hotels: hotels.length,
        pricedHotels: pricedHotels.length,
        unpricedHotels: hotels.length - pricedHotels.length
      }
    );

    return {
      ok: true,
      hotels: pricedHotels,
      searchUrl: page.url()
    };
  } finally {
    /*
     * Keep the existing Chrome session alive.
     * Do not close the browser.
     */
  }
}

async function getLocandaRates(
  availabilityUrl,
  options = {}
) {
  const ownsBrowser = !options.browser;

  const browser = options.browser || await puppeteer.connect({
    browserWSEndpoint: readDevToolsEndpoint(),
    defaultViewport: null,
    handleDevToolsAsPage: true,
    protocolTimeout: 120000
  });

  try {
    const page =
      options.page ||
      await getLocandaPage(browser);
    page.setDefaultTimeout(30000);

    await page.goto(
      availabilityUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    await page.waitForSelector(
      '#table-1',
      { timeout: 30000 }
    );

    const rates = await page.$$eval(
      '#table-1 tr.room-list-table',
      rows => rows.map(row => {
        const data =
          row.querySelector('.rooms-data');

        const text = selector =>
          row.querySelector(selector)
            ?.textContent
            ?.trim() || '';

        return {
          room:
            data?.getAttribute('room-name') || '',
          meal:
            data?.getAttribute('room-meal') ||
            text('.room-text'),
          currency:
            data?.getAttribute('room-currency') || '',
          amount:
            data?.getAttribute('room-amount') || '',
          cancellation:
            text(
              '.cancel-block .cancel-policy'
            ),
          roomId:
            data?.getAttribute('room-id') || ''
        };
      }).filter(rate =>
        rate.room &&
        rate.amount
      )
    );

    return {
      ok: true,
      hotel:
        String(options.hotel || '').trim(),
      rates
    };

  } finally {
    if (ownsBrowser) {
      browser.disconnect();
    }
  }
}

module.exports = {
  searchLocanda,
  getLocandaRates
};







































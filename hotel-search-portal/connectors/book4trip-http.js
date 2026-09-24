const { decrypt } = require('../crypto-util');
/**
 * Book4Trip Hybrid HTTP Connector
 *
 * Authentication:
 *   Playwright persistent browser session.
 *   User completes Book4Trip login/reCAPTCHA normally.
 *
 * Searching:
 *   HTTP requests through the authenticated Playwright
 *   BrowserContext.request client.
 *
 * Result endpoint:
 *   /m1_paging_information.php
 *
 * Confirmed Book4Trip pagination:
 *   9 pages / 216 hotels in test search.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BOOK4TRIP_BASE = 'https://www.book4trip.com';

let browserContext = null;
let browserPage = null;
let requestClient = null;
let book4tripAuthenticated = false;

function log(...args) {
  console.log('[BOOK4TRIP-HTTP]', ...args);
}

function normalizeUrl(value) {
  if (!value) return '';
  return new URL(value, BOOK4TRIP_BASE).toString();
}

function extractHidden(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const re1 = new RegExp(
    '<input[^>]+name=["\']' +
      escaped +
      '["\'][^>]*value=["\']([^"\']*)["\']',
    'i'
  );

  const re2 = new RegExp(
    '<input[^>]+value=["\']([^"\']*)["\'][^>]*name=["\']' +
      escaped +
      '["\']',
    'i'
  );

  const m1 = html.match(re1);
  if (m1) return m1[1];

  const m2 = html.match(re2);
  if (m2) return m2[1];

  return '';
}

function extractSessionId(html) {
  const patterns = [
    /sessionid=([A-Za-z0-9_-]+)/i,
    /sessionid["']?\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i,
    /sessionid=([0-9A-Za-z_-]+)/i
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }

  return '';
}

function parseHtmlOrJson(text) {
  const trimmed = String(text || '').trim();

  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return trimmed;
  }
}

async function responseText(response) {
  const text = await response.text();

  if (!response.ok()) {
    throw new Error(
      `Book4Trip HTTP ${response.status()} ${response.statusText()} ` +
      `from ${response.url()}`
    );
  }

  return text;
}

async function ensureBrowserSession(
  source,
  options = {}
) {
  const authenticate =
    options.authenticate !== false;
  if (
    browserContext &&
    !browserContext.isClosed() &&
    requestClient
  ) {
    return;
  }

  const profileDir = path.join(
    process.cwd(),
    '.book4trip-session'
  );

  fs.mkdirSync(profileDir, { recursive: true });

  log('Starting persistent Book4Trip browser session...');
  log('Profile:', profileDir);

  browserContext = await chromium.launchPersistentContext(
    profileDir,
    {
      headless: false,
      viewport: {
        width: 1440,
        height: 900
      }
    }
  );

  browserPage =
    browserContext.pages()[0] ||
    await browserContext.newPage();

  /*
   * BOOK4TRIP PAGINATION REQUEST DIAGNOSTIC
   *
   * Capture the real browser-generated pagination request.
   * This is diagnostic only. It does not modify or bypass
   * Book4Trip authentication, CAPTCHA, or OTP handling.
   */
  if (!browserPage.__book4tripPaginationCaptureAttached) {
    browserPage.__book4tripPaginationCaptureAttached = true;

    browserPage.on('framenavigated', frame => {
      try {
        if (frame === browserPage.mainFrame()) {
          log(
            'BOOK4TRIP BROWSER NAVIGATION:',
            frame.url()
          );
        }
      } catch (error) {
        log(
          'BOOK4TRIP NAVIGATION TRACE ERROR:',
          error.message
        );
      }
    });

    browserPage.on('request', request => {
      try {
        const url = request.url();

        if (
          /book4trip\.com\/index/i.test(url) ||
          /hotel_search_list\.php/i.test(url) ||
          /xml_all\.php/i.test(url) ||
          /m1_merging\.php/i.test(url) ||
          /m1_hotel_search_listing\.php/i.test(url) ||
          /m1_paging_information\.php/i.test(url)
        ) {
          log(
            'BOOK4TRIP BROWSER SEARCH TRACE:',
            request.method(),
            url
          );
        }
      } catch (error) {
        log(
          'BOOK4TRIP SEARCH TRACE ERROR:',
          error.message
        );
      }
    });

    browserPage.on('request', request => {
      try {
        const url = request.url();

        if (
          /m1_paging_information\.php/i.test(url) ||
          /m1_hotel_search_listing\.php/i.test(url)
        ) {
          log(
            'BOOK4TRIP BROWSER REQUEST:',
            request.method(),
            url
          );
        }
      } catch (error) {
        log(
          'BOOK4TRIP REQUEST CAPTURE ERROR:',
          error.message
        );
      }
    });

    browserPage.on('response', async response => {
      try {
        const url = response.url();

        if (
          /m1_paging_information\.php/i.test(url) ||
          /m1_hotel_search_listing\.php/i.test(url)
        ) {
          log(
            'BOOK4TRIP BROWSER RESPONSE:',
            response.status(),
            url
          );

          try {
            const text = await response.text();

            log(
              'BOOK4TRIP BROWSER RESPONSE LENGTH:',
              text.length
            );

            if (
              /m1_paging_information\.php/i.test(url)
            ) {
              const debugPath = path.join(
                process.cwd(),
                'book4trip-pagination-debug.txt'
              );

              try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                  browserPage.__book4tripPaginationResults = parsed;
                  log(
                    'BOOK4TRIP PAGINATION JSON CAPTURED:',
                    parsed.length,
                    'hotels'
                  );
                }
              } catch (_) {}

              fs.writeFileSync(
                debugPath,
                [
                  'URL:',
                  url,
                  '',
                  'STATUS:',
                  String(response.status()),
                  '',
                  'RESPONSE:',
                  text
                ].join('\n'),
                'utf8'
              );

              log(
                'BOOK4TRIP PAGINATION RESPONSE SAVED:',
                debugPath
              );

              log(
                'BOOK4TRIP PAGINATION RESPONSE PREVIEW:',
                text
                  .slice(0, 1200)
                  .replace(/\s+/g, ' ')
              );
            }
          } catch (readError) {
            log(
              'BOOK4TRIP BROWSER RESPONSE READ ERROR:',
              readError.message
            );
          }
        }
      } catch (error) {
        log(
          'BOOK4TRIP RESPONSE CAPTURE ERROR:',
          error.message
        );
      }
    });

    log(
      'BOOK4TRIP PAGINATION BROWSER CAPTURE ATTACHED.'
    );
  }

  requestClient = browserContext.request;

  /*
   * Book4Trip credentials are stored in the source record.
   * The password is encrypted in the database and must be
   * decrypted before filling the browser login form.
   */
  if (
    !source ||
    !source.site_username ||
    !source.site_password_enc
  ) {
    throw new Error(
      'Book4Trip requires a configured username and password.'
    );
  }

  let password;

  try {
    password = decrypt(
      source.site_password_enc
    );
  } catch (error) {
    throw new Error(
      `Book4Trip credential decryption failed: ${error.message}`
    );
  }

  /*
   * First test the existing persistent HTTP session.
   *
   * If Book4Trip already has a valid authenticated session,
   * do NOT navigate the browser back to /index.php.
   */
  try {
    const existingSessionCheck =
      await requestClient.get(
        BOOK4TRIP_BASE + '/service_search.php',
        {
          failOnStatusCode: false,
          timeout: 60000
        }
      );

    const existingSessionText =
      await existingSessionCheck.text();

    const existingSessionUrl =
      existingSessionCheck.url();

    const existingSessionAuthenticated =
      existingSessionCheck.status() >= 200 &&
      existingSessionCheck.status() < 400 &&
      !(
        /agent_login_frm/i.test(existingSessionText) &&
        /index\.php/i.test(existingSessionUrl)
      );

    log(
      'Book4Trip existing session check:',
      {
        status: existingSessionCheck.status(),
        url: existingSessionUrl,
        authenticated: existingSessionAuthenticated,
        length: existingSessionText.length
      }
    );

    if (existingSessionAuthenticated) {
      book4tripAuthenticated = true;

      log(
        'Book4Trip session is already authenticated.'
      );

      return;
    }
  } catch (existingSessionError) {
    log(
      'Book4Trip existing session check failed; continuing to login flow:',
      existingSessionError.message
    );
  }

  /*
   * Existing session was not authenticated.
   * Now navigate to the login page and continue the normal
   * Book4Trip authentication flow below.
   */
  await browserPage.goto(
    BOOK4TRIP_BASE + '/index.php',
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  /*
   * Wait for the login page to actually render instead of
   * assuming it is ready after a fixed 1.5 seconds.
   */
  await browserPage
    .locator('#agent_login_frm')
    .waitFor({
      state: 'attached',
      timeout: 30000
    })
    .catch(() => {});

  await browserPage.waitForTimeout(500);

  log(
    'Current browser URL:',
    browserPage.url()
  );

  log(
    'Current browser URL:',
    browserPage.url()
  );

  /*
   * Check whether Book4Trip is already authenticated.
   */
  let loginForm = await browserPage
    .locator('#agent_login_frm')
    .count()
    .catch(() => 0);

  if (loginForm > 0) {
    log('');
    log('======================================================');
    log('BOOK4TRIP AUTOMATIC LOGIN');
    log('======================================================');

    /*
     * Agent Code is optional for some Book4Trip accounts,
     * but if it exists in the source record, fill it.
     */
    const agentCode = String(
      source.agent_code || ''
    ).trim();

    if (agentCode && agentCode !== '-') {
      const agentCodeField =
        browserPage.locator('#txt_agent_code');

      const agentCodeCount =
        await agentCodeField.count().catch(() => 0);

      const agentCodeVisible =
        agentCodeCount > 0 &&
        await agentCodeField.isVisible().catch(() => false);

      if (agentCodeVisible) {
        await agentCodeField.fill(agentCode);

        log(
          'Book4Trip agent code filled.'
        );
      } else {
        log(
          'Book4Trip agent code field is hidden; skipping agent code.'
        );
      }
    } else {
      log(
        'Book4Trip agent code not configured; skipping agent code.'
      );
    }

    await browserPage
      .locator('#txt_username')
      .fill(
        String(source.site_username || '')
      );

    await browserPage
      .locator('#txt_password')
      .fill(
        String(password || '')
      );

    log(
      'Book4Trip username/password filled.'
    );

    const signInButton =
      browserPage.locator(
        '#agent_login_frm input[name="save"][value="Sign In"]'
      );

    if (
      await signInButton.count().catch(() => 0) === 0
    ) {
      throw new Error(
        'Book4Trip Sign In button was not found.'
      );
    }

    /*
     * Book4Trip login diagnostic:
     * submit_login_form() first calls otpsend.php.
     * Capture that response so we can see which legitimate
     * login/OTP/session branch Book4Trip returns.
     *
     * This does NOT bypass CAPTCHA or OTP.
     */
    const book4tripOtpResponsePromise =
      browserPage.waitForResponse(
        response =>
          /\/otpsend\.php(?:\?|$)/i.test(response.url()),
        { timeout: 30000 }
      ).catch(() => null);

    await signInButton.click();

    log(
      'Book4Trip Sign In clicked.'
    );

    const book4tripOtpResponse =
      await book4tripOtpResponsePromise;

    if (book4tripOtpResponse) {
      log(
        'Book4Trip otpsend.php response:',
        book4tripOtpResponse.status(),
        book4tripOtpResponse.url().replace(
          /([?&])pass=[^&]*/gi,
          '$1pass=[REDACTED]'
        )
      );

      try {
        const otpText =
          await book4tripOtpResponse.text();

        let otpData = null;

        try {
          otpData = JSON.parse(otpText);
        } catch (_) {}

        if (otpData) {
          log(
            'Book4Trip otpsend.php safe response:',
            {
              login_msg:
                otpData.login_msg || '',
              allow_login_otp:
                otpData.allow_login_otp,
              allow_whatsapp_otp:
                otpData.allow_whatsapp_otp,
              is_session:
                otpData.is_session,
              email_present:
                !!otpData.email,
              mobile_present:
                !!otpData.mobile,
              ref_present:
                !!otpData.ref
            }
          );
        } else {
          log(
            'Book4Trip otpsend.php non-JSON response:',
            String(otpText || '').substring(0, 1000)
          );
        }
      } catch (error) {
        log(
          'Book4Trip otpsend.php response read error:',
          error.message
        );
      }
    } else {
      log(
        'Book4Trip otpsend.php response was not captured within 30 seconds.'
      );
    }

    log(
      'Waiting for Book4Trip authentication/verification...'
    );

    /*
     * Do not bypass CAPTCHA or other verification.
     *
     * If Book4Trip presents a verification challenge,
     * leave the browser open and allow it to complete normally.
     */
    const deadline =
      Date.now() + 5 * 60 * 1000;

    let authenticated = false;

    while (Date.now() < deadline) {
      await browserPage.waitForTimeout(3000);

      const url =
        browserPage.url();

      const formStillPresent =
        await browserPage
          .locator('#agent_login_frm')
          .count()
          .catch(() => 0);

      const finalUrlIsLogin =
        /\/index\.php(?:[?#]|$)/i.test(url);

      log(
        'Book4Trip login check:',
        'url=',
        url,
        'loginForm=',
        formStillPresent,
        'loginUrl=',
        finalUrlIsLogin
      );

      if (
        formStillPresent === 0 &&
        !finalUrlIsLogin
      ) {
        authenticated = true;

        log(
          'Book4Trip automatic login successful.'
        );

        log(
          'Authenticated browser URL:',
          url
        );

        break;
      }
    }

    if (!authenticated) {
      throw new Error(
        'Book4Trip automatic login did not complete within 5 minutes.'
      );
    }
  } else {
    log(
      'Book4Trip session is already authenticated.'
    );
  }

  /*
   * Verify the authenticated browser session before
   * starting the HTTP hotel search.
   */
  const check =
    await requestClient.get(
      BOOK4TRIP_BASE + '/service_search.php',
      {
        failOnStatusCode: false,
        timeout: 60000
      }
    );

  const checkText =
    await check.text();

  log(
    'Authenticated session test:',
    check.status(),
    check.url(),
    'length=',
    checkText.length
  );

  /*
   * If Book4Trip redirected the request to the login page,
   * the browser session is not authenticated.
   */
  if (
    /agent_login_frm/i.test(checkText) &&
    /index\.php/i.test(check.url())
  ) {
    throw new Error(
      'Book4Trip browser session is not authenticated after automatic login.'
    );
  }

  log(
    'Book4Trip authenticated HTTP session is ready.'
  );
}
async function getSearchPage() {
  const response = await requestClient.get(
    BOOK4TRIP_BASE + '/service_search.php?tab=hotel',
    {
      failOnStatusCode: false,
      timeout: 60000
    }
  );

  return {
    response,
    html: await response.text()
  };
}

function pickSearchValue(search, keys, fallback = '') {
  for (const key of keys) {
    if (
      search &&
      search[key] !== undefined &&
      search[key] !== null &&
      String(search[key]).trim() !== ''
    ) {
      return search[key];
    }
  }

  return fallback;
}

function formatBook4TripDate(value) {
  if (!value) return '';

  const s = String(value).trim();

  /*
   * Already Book4Trip format.
   */
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    return s;
  }

  /*
   * ISO YYYY-MM-DD
   */
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (iso) {
    return `${iso[3]}/${iso[2]}/${iso[1]}`;
  }

  /*
   * JavaScript Date fallback.
   */
  const d = new Date(s);

  if (!Number.isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();

    return `${dd}/${mm}/${yyyy}`;
  }

  return s;
}

function calculateDays(checkIn, checkOut) {
  const parse = value => {
    const m = String(value).match(
      /^(\d{2})\/(\d{2})\/(\d{4})$/
    );

    if (!m) return null;

    return new Date(
      Number(m[3]),
      Number(m[2]) - 1,
      Number(m[1])
    );
  };

  const a = parse(checkIn);
  const b = parse(checkOut);

  if (!a || !b) return '';

  return Math.round(
    (b.getTime() - a.getTime()) /
    (24 * 60 * 60 * 1000)
  );
}

function normalizeRooms(search) {
  const adults = Number(
    pickSearchValue(
      search,
      ['adults', 'adultCount', 'numberOfAdults'],
      2
    )
  ) || 2;

  const children = Number(
    pickSearchValue(
      search,
      ['children', 'childCount', 'numberOfChildren'],
      0
    )
  ) || 0;

  const rooms = Number(
    pickSearchValue(
      search,
      ['rooms', 'roomCount', 'numberOfRooms'],
      1
    )
  ) || 1;

  const ages =
    search?.childrenAges ||
    search?.childAges ||
    '0,0';

  return {
    rooms,
    adults,
    children,
    selectRooms:
      `${rooms} Room, ${adults} Adults, ${children} Children`,
    roomarray: JSON.stringify([
      {
        numberofAdults: String(adults),
        noOfChildren: String(children),
        childrenages: String(ages)
      }
    ])
  };
}

async function submitHotelSearch(source, search) {
  const { html: landingHtml } = await getSearchPage();

  /*
   * Read the current CSRF token from the actual Book4Trip
   * page instead of hard-coding it.
   */
  const csrfToken = extractHidden(
    landingHtml,
    'csrf_token'
  );

  const checkIn = formatBook4TripDate(
    pickSearchValue(
      search,
      [
        'checkIn',
        'checkin',
        'check_in',
        'arrivalDate',
        'arrival_date',
        'from'
      ]
    )
  );

  const checkOut = formatBook4TripDate(
    pickSearchValue(
      search,
      [
        'checkOut',
        'checkout',
        'check_out',
        'departureDate',
        'departure_date',
        'to'
      ]
    )
  );

  const city = pickSearchValue(
    search,
    [
      'city',
      'destination',
      'destinationName',
      'location'
    ],
    'Makkah(MECCA)'
  );

  const cityLower = String(city)
    .trim()
    .toLowerCase();

  const days =
    calculateDays(checkIn, checkOut);

  const roomData = normalizeRooms(search);

  /*
   * Book4Trip form fields discovered from the actual
   * hotel_form DOM.
   */
  const body = new URLSearchParams();

  body.set('GIATA_HOTELNAME_SEARCH', '0');
  body.set('csrf_token', csrfToken);
  body.set('hidden', '');
  body.set('action_type', 'show');
  body.set('txt_other_hotel_city', city);
  body.set('hotelid', '');
  body.set('keyword', '');
  body.set('city_code', '');
  body.set('sel_hotel', '');
  body.set('other_city', '');
  body.set('sel_city_preferred', '');
  body.set('arrival_date', checkIn);
  body.set('departure_date', checkOut);
  body.set('sel_days', String(days || ''));
  body.set('selectRooms', roomData.selectRooms);
  body.set('roomarray', roomData.roomarray);
  body.set(
    'sel_country',
    String(
      pickSearchValue(search, ['countryCode'], '129')
    )
  );
  body.set(
    'sel_city',
    cityLower
  );
  body.set(
    'sel_nationality',
    String(
      pickSearchValue(search, ['nationality'], '126')
    )
  );
  body.set(
    'sel_country_res',
    String(
      pickSearchValue(search, ['residenceCountry'], '126')
    )
  );
  body.set('sel_cities', '');
  body.set(
    'additional_markup',
    String(
      pickSearchValue(search, ['additional_markup'], '')
    )
  );
  body.set(
    'sel_currency',
    String(
      pickSearchValue(search, ['currency'], 'AED')
    )
  );

  /*
   * The browser test showed these ratings are checked
   * by default.
   */
  body.append('chk_ratings[]', '3.0');
  body.append('chk_ratings[]', '4.0');
  body.append('chk_ratings[]', '5.0');
  body.append('chk_ratings[]', 'SC');

  log('Submitting Book4Trip hotel search...');
  log('Destination:', city);
  log('Check-in:', checkIn);
  log('Check-out:', checkOut);
  log('Rooms:', roomData.selectRooms);

  const response = await requestClient.post(
    BOOK4TRIP_BASE + '/hotel_search_list.php',
    {
      data: body.toString(),
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      failOnStatusCode: false,
      timeout: 120000
    }
  );

  const resultHtml = await response.text();

  if (!response.ok()) {
    throw new Error(
      `Book4Trip search POST failed: HTTP ${response.status()}`
    );
  }

  const sessionId =
    extractSessionId(resultHtml);

  if (!sessionId) {
    /*
     * Sometimes the session is present in redirect
     * or returned HTML in another form.
     */
    const m =
      resultHtml.match(
        /sessionid=([0-9A-Za-z_-]{8,})/i
      );

    if (m) {
      return {
        sessionId: m[1],
        html: resultHtml
      };
    }

    throw new Error(
      'Book4Trip search did not return a sessionid.'
    );
  }

  log('Book4Trip search session:', sessionId);

  return {
    sessionId,
    html: resultHtml
  };
}

function extractPaginationPages(html, sessionId) {
  const pages = [];

  /*
   * myajaxbook.pages is embedded in the listing page.
   *
   * We intentionally use a regex rather than eval().
   */
  const re =
    /\/m1_paging_information\.php\?[^"'\\<>\s]+/gi;

  const matches =
    String(html || '').match(re) || [];

  for (const raw of matches) {
    const clean = raw
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');

    const absolute =
      normalizeUrl(clean);

    if (
      absolute.includes(
        'm1_paging_information.php'
      )
    ) {
      pages.push(absolute);
    }
  }

  /*
   * Deduplicate while preserving order.
   */
  const unique = [
    ...new Set(pages)
  ];

  /*
   * If the listing HTML didn't expose the pages,
   * construct page 1 as a fallback.
   */
  if (!unique.length && sessionId) {
    unique.push(
      BOOK4TRIP_BASE +
      `/m1_paging_information.php?sessionid=${encodeURIComponent(sessionId)}` +
      `&paging=1&page=1&turbo_search=0&rand=${Date.now()}` +
      `&rand2=${Date.now()}&dis=&lat=&long=&ln=&sfilter=all`
    );
  }

  return unique;
}

async function getListingHtml(sessionId) {
  const url =
    BOOK4TRIP_BASE +
    `/m1_hotel_search_listing.php` +
    `?action_type=show&sessionid=` +
    encodeURIComponent(sessionId);

  const response =
    await requestClient.get(
      url,
      {
        failOnStatusCode: false,
        timeout: 120000
      }
    );

  const body = await responseText(response);

  log(
    'LISTING RESPONSE STATUS:',
    response.status(),
    'URL:',
    response.url(),
    'LENGTH:',
    body.length
  );

  log(
    'LISTING HAS PAGINATION ENDPOINT:',
    /m1_paging_information\.php/i.test(body)
  );

  log(
    'LISTING HAS HOTEL MARKUP:',
    /hotel|property|room|rate|total_charges/i.test(body)
  );

  log(
    'LISTING RESPONSE PREVIEW:',
    body.slice(0, 1500).replace(/\s+/g, ' ')
  );

  try {
    const debugPath = path.join(
      __dirname,
      '..',
      'book4trip-listing-debug.html'
    );

    fs.writeFileSync(
      debugPath,
      body,
      'utf8'
    );

    log(
      'LISTING DEBUG FILE SAVED:',
      debugPath
    );
  } catch (debugError) {
    log(
      'LISTING DEBUG FILE SAVE FAILED:',
      debugError.message
    );
  }

  return body;
}

function normalizeBook4TripItem(item, source, index, search) {
  const price =
    Number.parseFloat(
      String(
        item?.total_charges ??
        item?.sort_total_charges ??
        ''
      ).replace(/,/g, '')
    );
  const available =
    Number(item?.propertyAvailable) === 1;


  return {
    id:
      item?.id ||
      item?._id?.$oid ||
      `${source?.id || 'book4trip'}-${index}`,

    supplier:
      source?.name ||
      'Book4trip',

    hotel:
      item?.name ||
      item?.hotelName ||
      '',

    room: '',

    view: 'View Rates',

    board:
      search?.board ||
      '',

    cancellation: '',

    price,

    currency:
      item?.rateCurrencyCode ||
      search?.currency ||
      'AED',

    availability:
      available
        ? 'Available'
        : 'On Request',

    raw: {
      ...item,

      /*
       * Book4Trip identifiers required by room_all.php.
       */
      mongo_id:
        item?.mongo_id ||
        item?._id?.$oid ||
        '',

      local_hotel_id:
        item?.local_hotel_id ||
        '',

      hotelId:
        item?.hotelId ||
        item?.id ||
        item?._id?.$oid ||
        '',

       sessionid:
         item?.book4trip_sessionid ||
         '',

      book4trip: true
    }
  };
}


/*
 * Fetch Book4Trip room rates for one hotel.
 *
 * Book4Trip uses:
 *   /room_all.php?action=geHoteltRoomRates
 *
 * The authenticated requestClient is reused so the room-rate
 * request stays inside the existing Book4Trip session.
 */

/*
 * Extract the exact Book4Trip identifiers used by
 * room_all.php from the rendered hotel listing HTML.
 *
 * Example data-val:
 *
 *   6,,6ab2a24bba3b84528225a4da,8666,OT000468070
 *
 * Fields:
 *   0 = result row id
 *   1 = legacy/local field (usually empty)
 *   2 = mongo_id
 *   3 = userid
 *   4 = local_hotel_id
 */
function extractBook4TripHotelIdentifiers(
  html
) {
  const source =
    String(html || '');

  const identifiers = [];

  /*
   * Capture data-val from the Book4Trip
   * "Choose Your Room" buttons.
   */
  const re =
    /<a\b[^>]*class=["'][^"']*dyn_listviebtn[^"']*["'][^>]*data-val=["']([^"']*)["'][^>]*>/gi;

  let match;

  while (
    (match = re.exec(source))
  ) {
    const dataVal =
      String(match[1] || '');

    const parts =
      dataVal.split(',');

    const rowId =
      String(
        parts[0] || ''
      ).trim();

    const mongoId =
      String(
        parts[2] || ''
      ).trim();

    const userId =
      String(
        parts[3] || ''
      ).trim();

    const localHotelId =
      String(
        parts[4] || ''
      ).trim();

    if (!rowId || !mongoId) {
      continue;
    }

    identifiers.push({
      rowId,
      mongo_id: mongoId,
      local_hotel_id: localHotelId,
      userid: userId,
      dataVal
    });
  }

  /*
   * Remove duplicates while preserving order.
   */
  const unique =
    [];

  const seen =
    new Set();

  for (
    const item of identifiers
  ) {
    const key =
      item.rowId;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  log(
    'BOOK4TRIP HOTEL IDENTIFIERS EXTRACTED:',
    unique.length
  );

  return unique;
}
async function getBook4TripRoomRates(
  roomRequest,
  source,
  search
) {
  if (!requestClient) {
    throw new Error(
      'Book4Trip HTTP request client is not initialized.'
    );
  }

  const mongoId =
    String(
      roomRequest?.mongo_id ||
      roomRequest?.mongoId ||
      ''
    ).trim();

  const localHotelId =
    String(
      roomRequest?.local_hotel_id ||
      ''
    ).trim();

  const hotelId =
    String(
      roomRequest?.hotelId ||
      ''
    ).trim();

  const sessionId =
    String(
      roomRequest?.sessionid ||
      roomRequest?.sessionId ||
      ''
    ).trim();

  const userId =
    String(
      roomRequest?.userid ||
      roomRequest?.userId ||
      '8666'
    ).trim();

  if (!mongoId) {
    throw new Error(
      'Book4Trip room rates require mongo_id.'
    );
  }

  if (!sessionId) {
    throw new Error(
      'Book4Trip room rates require sessionid.'
    );
  }

  /*
   * Book4Trip's "id" is the result-row index, not necessarily
   * the supplier hotel ID. Preserve it when available.
   */
  const rowId =
    String(
      roomRequest?.id ??
      0
    ).trim();

  const params = new URLSearchParams();

  params.set(
    'action',
    'geHoteltRoomRates'
  );

  params.set(
    'id',
    rowId
  );

  params.set(
    'local_hotel_id',
    localHotelId
  );

  params.set(
    'mongo_id',
    mongoId
  );

  params.set(
    'resulttype',
    'html'
  );

  params.set(
    'sessionid',
    sessionId
  );

  params.set(
    'sourceType',
    String(
      roomRequest?.sourceType ||
      ''
    )
  );

  params.set(
    'userid',
    userId
  );

  const url =
    BOOK4TRIP_BASE +
    '/room_all.php?' +
    params.toString();

  log(
    'BOOK4TRIP ROOM RATES REQUEST:',
    url
  );

  const response =
    await requestClient.get(
      url,
      {
        failOnStatusCode: false,
        timeout: 120000
      }
    );

  const responseText =
    await response.text();
  require('fs').writeFileSync(require('path').join(process.cwd(), 'book4trip-room-rates-debug.html'), responseText, 'utf8');
  log('BOOK4TRIP ROOM RATES DEBUG FILE SAVED');

  log(
    'BOOK4TRIP ROOM RATES RESPONSE:',
    {
      status: response.status(),
      length: responseText.length
    }
  );

  if (!response.ok()) {
    throw new Error(
      `Book4Trip room rates failed: HTTP ${response.status()}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      'Book4Trip room rates returned invalid JSON.'
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      'Book4Trip room rates response is not an array.'
    );
  }

  const rooms = [];

  for (const group of data.flat(Infinity)) {
    const rateInfo =
      group?.RateInfo ||
      group?.rateInfo ||
      {};

    const roomRates =
      Array.isArray(rateInfo.room_rates)
        ? rateInfo.room_rates
        : [];

    for (const room of roomRates) {
      const roomPrice =
        Number(
          room?.displayRoomTypeRates ??
          rateInfo?.displayRoomRate ??
          room?.whRoomTypeRates ??
          rateInfo?.whRoomRate ??
          0
        );

      const currency =
        String(
          rateInfo?.displayCurrencyCode ||
          room?.displayCurrencyCode ||
          'AED'
        ).toUpperCase();

      const roomCategory =
        String(
          room?.room_category ||
          room?.room_name ||
          ''
        ).trim();

      const roomName =
        String(
          room?.room_name ||
          roomCategory ||
          ''
        ).trim();

      const board =
        String(
          room?.meal_basis ||
          room?.room_meal_code ||
          room?.meal_type_code ||
          ''
        ).trim();

      const refundable =
        room?.non_refundable === 'yes'
          ? false
          : (
              rateInfo?.isrefundable === true ||
              String(
                room?.refund_policy ||
                rateInfo?.refund_policy ||
                ''
              ) === '0'
            );

      rooms.push({
        room:
          roomCategory,

        roomName,

        roomCategory,

        board,

        mealBasis:
          board,

        price:
          Number.isFinite(roomPrice)
            ? roomPrice
            : 0,

        currency,

        refundable,

        cancellation:
          refundable
            ? 'Refundable'
            : 'Non-refundable',

        available:
          Number(room?.available) === 1 ||
          Number(rateInfo?.available) === 1,

        adults:
          Number(
            room?.number_of_adults || 0
          ),

        children:
          Number(
            room?.number_of_child || 0
          ),

        numberOfRooms:
          Number(
            room?.NumberOfRooms || 1
          ),

        rateKey:
          room?.rate_key || '',

        uniqueId:
          rateInfo?.unique_id || '',

        roomCode:
          room?.room_code || '',

        roomMealCode:
          room?.room_meal_code || '',

        raw: {
          ...room,
          RateInfo: rateInfo
        }
      });
    }
  }

  log(
    'BOOK4TRIP ROOM RATES PARSED:',
    rooms.length
  );

  return {
    rooms,
    raw: data,
    request: {
      id: rowId,
      mongo_id: mongoId,
      local_hotel_id: localHotelId,
      hotelId,
      sessionid: sessionId,
      userid: userId
    }
  };
}
async function fetchAllPages(
  pages,
  source,
  search,
  sessionId,
) {
  const results = [];

  log(
    `Book4Trip pagination pages discovered: ${pages.length}`
  );

  for (let i = 0; i < pages.length; i++) {
    const url = pages[i];

    log(
      `Fetching Book4Trip page ${i + 1}/${pages.length}`
    );

    const response =
      await requestClient.get(
        url,
        {
          failOnStatusCode: false,
          timeout: 120000
        }
      );

    const text =
      await response.text();

    // BOOK4TRIP HTTP PAGINATION RESPONSE DIAGNOSTIC
    if (i === 0) {
      log(
        'BOOK4TRIP HTTP PAGINATION ACTUAL RESPONSE:',
        {
          status: response.status(),
          url: response.url(),
          length: text.length,
          preview: String(text)
            .slice(0, 5000)
            .replace(/\s+/g, ' ')
        }
      );

      try {
        fs.writeFileSync(
          path.join(
            process.cwd(),
            'book4trip-http-pagination-response.txt'
          ),
          [
            'URL:',
            response.url(),
            '',
            'STATUS:',
            String(response.status()),
            '',
            'LENGTH:',
            String(text.length),
            '',
            'RESPONSE:',
            text
          ].join('\n'),
          'utf8'
        );

        log(
          'BOOK4TRIP HTTP PAGINATION RESPONSE SAVED:',
          path.join(
            process.cwd(),
            'book4trip-http-pagination-response.txt'
          )
        );
      } catch (saveError) {
        log(
          'BOOK4TRIP HTTP PAGINATION RESPONSE SAVE ERROR:',
          saveError.message
        );
      }
    }

    if (!response.ok()) {
      throw new Error(
        `Book4Trip pagination page ${i + 1} failed: ` +
        `HTTP ${response.status()}`
      );
    }

    const data =
      parseHtmlOrJson(text);

    if (!Array.isArray(data)) {
      log(
        `Book4Trip page ${i + 1} did not return an array. ` +
        `Length=${text.length}`
      );
      continue;
    }

    log(
      `Book4Trip page ${i + 1}: ${data.length} hotels`
    );


    /*
     * Extract the authoritative Book4Trip room identifiers from
     * the rendered listing HTML. The mongo_id here is the value
     * required by room_all.php and must NOT use pagination _id.$oid.
     */
    let hotelIdentifiers = [];

    if (i === 0) {
      try {
        const identifierHtml =
          await getListingHtml(
            sessionId
          );

        hotelIdentifiers =
          extractBook4TripHotelIdentifiers(
            identifierHtml
          );

        log(
          "BOOK4TRIP IDENTIFIER MAP EXTRACTED:",
          hotelIdentifiers.length
        );
      } catch (identifierError) {
        log(
          "BOOK4TRIP IDENTIFIER EXTRACTION ERROR:",
          identifierError.message
        );
      }
    }

    const identifierByRow =
      new Map(
        hotelIdentifiers.map(
          item => [
            String(item.rowId),
            item
          ]
        )
      );

    for (let itemIndex = 0; itemIndex < data.length; itemIndex++) {
      const item = data[itemIndex];

      /*
       * Attach the exact identifiers used by Book4Trip room_all.php.
       * These come from the rendered "Choose Your Room" data-val.
       */
      const identifier =
        identifierByRow.get(
          String(itemIndex)
        ) || null;

      const enrichedItem = {
        ...item,

        book4trip_row_id:
          identifier?.rowId ||
          String(itemIndex),

        book4trip_mongo_id:
          identifier?.mongo_id ||
          "",

        book4trip_local_hotel_id:
          identifier?.local_hotel_id ||
          "",

         book4trip_sessionid:
           sessionId ||
           '',

        book4trip_userid:
          identifier?.userid ||
          "",

        book4trip_data_val:
          identifier?.dataVal ||
          ""
      };

      results.push(
        normalizeBook4TripItem(
          enrichedItem,
          source,
          results.length,
          search
        )
      );
    }
  }

  return results;
}

async function healthBook4TripHttpSource(source) {
  try {
    /*
     * Open/reuse the persistent Book4Trip browser.
     * Authentication is handled by the existing session/login flow.
     */
    await ensureBrowserSession(source);

    if (
      !browserPage ||
      browserPage.isClosed()
    ) {
      book4tripAuthenticated = false;

      return {
        configured: true,
        signedIn: false,
        error: 'Book4Trip browser page is not available.'
      };
    }

    /*
     * Do NOT navigate back to /index.php here.
     *
     * The authenticated session is already established by
     * ensureBrowserSession(). Verify the authenticated area
     * instead.
     */
    const currentUrl = browserPage.url();

    let sessionStatus = false;

    try {
      const response = await requestClient.get(
        BOOK4TRIP_BASE + '/service_search.php',
        {
          timeout: 60000
        }
      );

      const status = response.status();
      const finalUrl = response.url();

      sessionStatus =
        status >= 200 &&
        status < 400 &&
        !/\/index\.php(?:[?#]|$)/i.test(finalUrl);

      log(
        'Book4Trip HEALTH SESSION TEST:',
        {
          status,
          finalUrl,
          sessionStatus
        }
      );
    } catch (sessionError) {
      log(
        'Book4Trip HEALTH SESSION TEST ERROR:',
        sessionError.message
      );
    }

    /*
     * The authenticated HTTP session test is the authoritative
     * Book4Trip health signal.
     */
    const signedIn = sessionStatus;

    book4tripAuthenticated = signedIn;

    if (signedIn) {
      log(
        'Book4Trip HEALTH CHECK: SIGNED IN',
        {
          url: currentUrl,
          signedIn: true
        }
      );
    } else {
      book4tripAuthenticated = false;

      log(
        'Book4Trip HEALTH CHECK: NOT SIGNED IN',
        {
          url: currentUrl,
          authenticatedFlag: !!book4tripAuthenticated,
          sessionStatus
        }
      );
    }

    return {
      configured: true,
      signedIn,
      error: signedIn
        ? null
        : 'Book4Trip browser session is not authenticated.'
    };

  } catch (error) {
    book4tripAuthenticated = false;

    log(
      'Book4Trip HEALTH CHECK ERROR:',
      error.message
    );

    return {
      configured: true,
      signedIn: false,
      error: error.message
    };
  }
}
async function searchBook4TripHttpSource(source, search) {
  const started = Date.now();

  log('====================================================');
  log('BOOK4TRIP BROWSER UI SEARCH START');
  log('====================================================');

  await ensureBrowserSession(source);

  if (!browserPage || browserPage.isClosed()) {
    throw new Error('Book4Trip browser page is not available.');
  }

  const checkIn = formatBook4TripDate(
    pickSearchValue(search, [
      'checkIn',
      'checkin',
      'check_in',
      'arrivalDate',
      'arrival_date',
      'from'
    ])
  );

  const checkOut = formatBook4TripDate(
    pickSearchValue(search, [
      'checkOut',
      'checkout',
      'check_out',
      'departureDate',
      'departure_date',
      'to'
    ])
  );

  const city = pickSearchValue(
    search,
    ['city', 'destination', 'destinationName', 'location'],
    'Makkah'
  );

  const roomData = normalizeRooms(search);

  log('Destination:', city);
  log('Check-in:', checkIn);
  log('Check-out:', checkOut);
  log('Rooms:', roomData.selectRooms);

  const searchUrl =
    BOOK4TRIP_BASE + '/service_search.php?tab=hotel';

  if (!/service_search\.php/i.test(browserPage.url())) {
    await browserPage.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });
  }

  await browserPage.waitForTimeout(1500);

  const destination =
    browserPage.locator('#txt_other_hotel_city').first();

  await destination.waitFor({
    state: 'visible',
    timeout: 30000
  });

  await destination.click();
  await destination.fill('');

  /*
   * Book4Trip expects the actual city to be selected from its
   * autocomplete list.
   *
   * The incoming destination can be:
   *   "Makkah - Saudi Arabia"
   *   "Medina - Saudi Arabia"
   *   "Jeddah - Saudi Arabia"
   *   etc.
   *
   * Extract only the city portion before the country.
   */
  const destinationText =
    String(city || '')
      .split(/\s*-\s*/)[0]
      .trim();

  const destinationKey =
    destinationText
      .toLowerCase()
      .trim();

  const destinationMap = {
    medina: 'Madinah',
    madinah: 'Madinah',
    makkah: 'Makkah',
    mecca: 'Makkah'
  };

  const destinationSearchTerm =
    destinationMap[destinationKey] ||
    destinationText ||
    'Makkah';

  /*
   * Book4Trip commonly uses alternate names:
   *   Makkah <-> Mecca
   *   Medina <-> Madinah
   */
  const destinationAliases = [];

  if (/^makkah$/i.test(destinationSearchTerm)) {
    destinationAliases.push('Mecca');
  }

  if (/^mecca$/i.test(destinationSearchTerm)) {
    destinationAliases.push('Makkah');
  }

  if (/^medina$/i.test(destinationSearchTerm)) {
    destinationAliases.push('Madinah');
  }

  if (/^madinah$/i.test(destinationSearchTerm)) {
    destinationAliases.push('Medina');
  }

  const destinationTerms = [
    destinationSearchTerm,
    ...destinationAliases
  ];

  /*
   * Escape the destination names before constructing the regex.
   */
  const escapeRegex = (value) =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const destinationPattern =
    new RegExp(
      destinationTerms
        .filter(Boolean)
        .map(escapeRegex)
        .join('|'),
      'i'
    );

  log(
    'BOOK4TRIP UI: destination search term:',
    destinationSearchTerm
  );

  await destination.type(
    destinationSearchTerm,
    { delay: 150 }
  );

  log('BOOK4TRIP UI: destination entered.');

  await browserPage.waitForTimeout(2000);

  log(
    'BOOK4TRIP UI: destination field after autocomplete:',
    await destination.inputValue()
  );

  await browserPage.waitForTimeout(1500);

  /*
   * Book4Trip autocomplete response can be delayed when
   * multiple suppliers are running concurrently.
   *
   * Keep checking for up to 15 seconds.
   */
  const suggestions = browserPage.locator(
    'li, div, a'
  ).filter({
    hasText: destinationPattern
  });

  let selected = false;
  const autocompleteDeadline = Date.now() + 15000;

  while (Date.now() < autocompleteDeadline && !selected) {
    const suggestionCount = await suggestions.count();

    log(
      'BOOK4TRIP UI: autocomplete suggestions found:',
      suggestionCount
    );

    for (let i = 0; i < suggestionCount; i++) {
      const item = suggestions.nth(i);

      if (await item.isVisible().catch(() => false)) {
        const text = await item.innerText().catch(() => '');

        if (destinationPattern.test(text)) {
          log(
            'BOOK4TRIP UI: destination autocomplete candidate:',
            text.trim()
          );

          await item.click();
          selected = true;
          break;
        }
      }
    }

    if (!selected) {
      await browserPage.waitForTimeout(500);
    }
  }

  if (!selected) {
    throw new Error(
      `Book4Trip ${destinationSearchTerm} autocomplete suggestion not found after 15 seconds.`
    );
  }

  await browserPage.waitForTimeout(500);

  log(
    'BOOK4TRIP UI: destination selected:',
    destinationSearchTerm
  );

  /*
   * Fill the actual Book4Trip date inputs.
   */
  /*
   * Fill the actual Book4Trip date inputs.
   *
   * Book4Trip uses separate #date_from and #date_to fields.
   * Set BOTH fields explicitly through its jQuery datepicker.
   */
  const selectBook4TripDate = async (selector, date) => {
    const field = browserPage.locator(selector).first();

    await field.waitFor({ state: "visible", timeout: 30000 });
    await field.click();
    await browserPage.waitForTimeout(300);

    const [day, month, year] = String(date).split("/").map(Number);

    await browserPage.evaluate(({ selector, day, month, year }) => {
      const el = document.querySelector(selector);

      if (!el || !window.jQuery || !jQuery.fn.datepicker) {
        throw new Error(
          "Book4Trip jQuery datepicker not available for " + selector
        );
      }

      const target = new Date(year, month - 1, day);

      jQuery(el).datepicker("setDate", target);
      jQuery(el).trigger("change");
      jQuery(el).trigger("input");
      jQuery(el).blur();
    }, { selector, day, month, year });

    await browserPage.waitForTimeout(500);
  };

  await browserPage.locator("#sel_days").selectOption("1");

  /*
   * Set arrival date.
   */
  await selectBook4TripDate("#date_from", checkIn);

  /*
   * Set departure date explicitly.
   */
  await selectBook4TripDate("#date_to", checkOut);

  /*
   * Verify what Book4Trip actually has in the form.
   */
  const selectedDates = await browserPage.evaluate(() => ({
    arrival: document.querySelector("#date_from")?.value || "",
    departure: document.querySelector("#date_to")?.value || "",
    nights: document.querySelector("#sel_days")?.value || ""
  }));

  log("BOOK4TRIP UI: dates selected with jQuery datepicker.", selectedDates);

  if (!selectedDates.arrival || !selectedDates.departure) {
    throw new Error(
      "Book4Trip datepicker did not set both dates: " +
      JSON.stringify(selectedDates)
    );
  }

  log("BOOK4TRIP UI: dates entered.", selectedDates);

  log('BOOK4TRIP UI: dates entered.');

  /*
   * Let Book4Trip's own room widget handle the room summary.
   * The existing normalized roomarray is also written into the
   * actual form field when it exists.
   */
  await browserPage.evaluate((roomData) => {
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;

      try {
        const setter =
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
          )?.set;

        if (setter) setter.call(el, String(value));
        else el.value = String(value);
      } catch (_) {
        el.value = String(value);
      }

      el.dispatchEvent(
        new Event('input', { bubbles: true })
      );
      el.dispatchEvent(
        new Event('change', { bubbles: true })
      );

      return true;
    };

    setValue(
      'input[name="selectRooms"], #selectRooms, #totalroomdetailval',
      roomData.selectRooms
    );

    setValue(
      'input[name="roomarray"], #roomarray',
      roomData.roomarray
    );
  }, roomData);

  await browserPage.waitForTimeout(500);

  /*
   * Capture the browser's own search request. This is only
   * observation; we do NOT send the request ourselves.
   */
  const searchRequestPromise =
    browserPage.waitForRequest(
      request =>
        /hotel_search_list\.php/i.test(
          request.url()
        ),
      { timeout: 90000 }
    ).catch(() => null);

  /*
   * Click the real Search control.
   */
  const searchControls = browserPage.locator(
    'input[type="submit"], ' +
    'input[type="button"], ' +
    'button, ' +
    'a'
  );

  /*
   * Book4Trip keeps the jQuery datepicker popup open after
   * programmatically setting #date_to. Close it before clicking
   * the Search control so the popup cannot intercept the click.
   */
  await browserPage.evaluate(() => {
    if (window.jQuery && jQuery.fn.datepicker) {
      try {
        jQuery("#date_from").datepicker("hide");
      } catch (_) {}

      try {
        jQuery("#date_to").datepicker("hide");
      } catch (_) {}
    }

    document.querySelectorAll(".datepicker").forEach((picker) => {
      picker.classList.remove("active");
      picker.style.display = "none";
    });

    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  });

  await browserPage.waitForTimeout(300);

  log(
    "BOOK4TRIP UI: datepicker closed before Search.",
    await browserPage.evaluate(() => ({
      visibleDatepickers: Array.from(
        document.querySelectorAll(".datepicker")
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" &&
               style.visibility !== "hidden" &&
               el.offsetWidth > 0 &&
               el.offsetHeight > 0;
      }).length
    }))
  );

  const controlCount =
    await searchControls.count();

  let clicked = false;

  for (let i = 0; i < controlCount; i++) {
    const control =
      searchControls.nth(i);

    if (!(await control.isVisible().catch(() => false))) {
      continue;
    }

    const text = (
      await control.innerText().catch(() => '')
    ).trim();

    const value =
      await control.getAttribute('value').catch(() => '');

    const id =
      await control.getAttribute('id').catch(() => '');

    const name =
      await control.getAttribute('name').catch(() => '');

    const combined =
      `${text} ${value || ''} ${id || ''} ${name || ''}`;

    if (/search/i.test(combined)) {
      await control.click();
      clicked = true;
      log(
        'BOOK4TRIP UI: Search clicked:',
        combined
      );
      break;
    }
  }

  if (!clicked) {
    throw new Error(
      'Book4Trip Search control was not found.'
    );
  }

  /*
   * Book4Trip now owns the search. Wait for its AJAX request,
   * then wait for the result/listing page to populate.
   */
  const searchRequest =
    await searchRequestPromise;

  if (searchRequest) {
    log(
      'BOOK4TRIP BROWSER SEARCH REQUEST:',
      searchRequest.method(),
      searchRequest.url()
    );
  } else {
    log(
      'BOOK4TRIP BROWSER SEARCH REQUEST: not captured within timeout'
    );
  }

  await browserPage.waitForTimeout(5000);

  try {
    await browserPage.waitForURL(
      /m1_hotel_search_listing\.php/i,
      { timeout: 30000 }
    );
  } catch (_) {}

  await browserPage.waitForTimeout(20000);

  log(
    'BOOK4TRIP RESULT URL:',
    browserPage.url()
  );

  /*
   * First try Book4Trip's rendered hotel elements.
   * We do not manufacture prices or call the backend APIs.
   */
    /*
   * Book4Trip's browser search has completed.
   *
   * The browser-side listener can expose only the currently
   * captured page. Use the authenticated HTTP pagination
   * endpoint to retrieve the complete Book4Trip result set.
   */

  let results = [];

  try {
    let sessionId = '';

    /*
     * First try the current result URL.
     */
    const currentUrl =
      browserPage.url();

    const urlMatch =
      String(currentUrl || '').match(
        /[?&]sessionid=([0-9A-Za-z_-]+)/i
      );

    if (urlMatch && urlMatch[1]) {
      sessionId = urlMatch[1];
    }

    /*
     * If the URL does not expose sessionid, inspect the
     * current browser listing HTML.
     */
    let listingHtml = '';

    if (!sessionId) {
      listingHtml =
        await browserPage.content();

      sessionId =
        extractSessionId(listingHtml);
    }

    if (!sessionId) {
      throw new Error(
        'Book4Trip pagination session ID was not found.'
      );
    }

    log(
      'BOOK4TRIP PAGINATION SESSION:',
      sessionId
    );

    /*
     * Get the listing HTML through the authenticated HTTP
     * request client.
     */
    listingHtml =
      await getListingHtml(sessionId);

    /*
     * Discover every pagination endpoint exposed by
     * Book4Trip.
     */
    const paginationPages =
      extractPaginationPages(
        listingHtml,
        sessionId
      );

    log(
      'BOOK4TRIP PAGINATION PAGES DISCOVERED:',
      paginationPages.length
    );

    if (!paginationPages.length) {
      throw new Error(
        'Book4Trip pagination URLs were not discovered.'
      );
    }

    /*
     * Fetch and normalize all pages.
     */
    results =
      await fetchAllPages(
        paginationPages,
        source,
        search,
        sessionId
      );

    log(
      'BOOK4TRIP ALL-PAGES RESULTS:',
      results.length
    );

  } catch (paginationError) {
    /*
     * Safe fallback to the currently working browser
     * result extraction.
     */
    log(
      'BOOK4TRIP PAGINATION ERROR:',
      paginationError.message
    );

    const book4TripPaginationResults =
      Array.isArray(
        browserPage.__book4tripPaginationResults
      )
        ? browserPage.__book4tripPaginationResults
        : [];

    const rawResults =
      book4TripPaginationResults
        .map((item) => {
          const name =
            String(item?.name || '').trim();

          if (!name || name.length < 2) {
            return null;
          }

          const currency =
            String(
              item?.rateCurrencyCode || ''
            ).toUpperCase();

          const total =
            Number.parseFloat(
              String(
                item?.total_charges ?? ''
              ).replace(/,/g, '')
            );

          return {
            name,
            hotelName: name,

            text: [
              name,
              item?.address1 || '',
              currency,
              Number.isFinite(total)
                ? String(total)
                : ''
            ]
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim(),

            rateCurrencyCode: currency,
            displayCurrencyCode: currency,

            total_charges:
              Number.isFinite(total)
                ? total
                : null,

            propertyAvailable:
              Number(item?.propertyAvailable) === 1,

            propertyRating:
              item?.propertyRating ?? '',

            address1:
              item?.address1 || '',

            hotelId:
              item?.hotelId ||
              item?.local_hotel_id ||
              item?.id ||
              item?._id?.$oid ||
              ''
          };
        })
        .filter(Boolean);

    if (!rawResults.length) {
      throw new Error(
        'Book4Trip UI search completed, but no rendered hotel results were found.'
      );
    }

    results =
      rawResults.map(
        (item, index) =>
          normalizeBook4TripItem(
            item,
            source,
            index,
            search
          )
      );

    log(
      'BOOK4TRIP FALLBACK RESULTS:',
      results.length
    );
  }
  return results;
}
module.exports = {
  getBook4TripRoomRates,
  searchBook4TripHttpSource,
  healthBook4TripHttpSource
};









































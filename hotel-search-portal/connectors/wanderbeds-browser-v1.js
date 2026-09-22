const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { decrypt } = require('../crypto-util');

const HOME_URL = 'https://wanderbeds.com/?setlang=en';
const WANDERBEDS_SESSION_DIR = path.join(__dirname, '..', '.wanderbeds-session');

let wanderBedsBrowser = null;
let wanderBedsContext = null;
let wanderBedsPage = null;
let wanderBedsSourceKey = null;
let wanderBedsLoginPromise = null;

const PRICE_RE = /(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?|[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:AED|SAR|USD|EUR|GBP|PKR|US\$|\$)/i;
const BOARD_RE = /Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive/i;
const CANCEL_RE = /Non[- ]?refundable|Free Cancellation|Refundable/i;
const ROOM_RE = /((?:Double|Twin|Triple|Quadruple|Quintuple|Family|Standard|Deluxe|Superior|King|Queen|Single)[A-Za-z0-9 /-]{1,100}?)\s*-\s*(?:Room Only|Breakfast Included|Bed and Breakfast|Half Board|Full Board|All Inclusive)\b/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const norm = (v) =>
  clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const date = (v) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || '');
};

function price(text) {
  const m = clean(text).match(PRICE_RE);
  if (!m) return null;

  const n = Number(m[0].replace(/[^0-9.]/g, ''));
  if (!(n > 0)) return null;

  const c = m[0].match(/AED|SAR|USD|EUR|GBP|PKR|US\$|\$/i);

  return {
    price: n,
    currency: c ? c[0].toUpperCase() : 'AED'
  };
}

function room(text) {
  const m = clean(text).match(ROOM_RE);
  return m ? clean(m[1]) : '';
}

function board(text) {
  const m = clean(text).match(BOARD_RE);
  return m ? clean(m[0]) : '';
}

function cancellation(text) {
  const m = clean(text).match(CANCEL_RE);
  return m ? clean(m[0]) : '';
}

function dedupe(rows) {
  const seen = new Set();

  return rows.filter((r) => {
    const k = [
      norm(r.hotel),
      norm(r.room),
      norm(r.board),
      norm(r.cancellation),
      Number(r.price).toFixed(2),
      norm(r.currency)
    ].join('|');

    if (seen.has(k)) return false;

    seen.add(k);
    return true;
  });
}

async function bodyText(page) {
  return clean(
    await page.locator('body').innerText().catch(() => '')
  );
}

async function blocked(page) {
  const text = await bodyText(page);

  if (
    /captcha|verify you are human|access denied|unusual traffic|security check/i.test(text)
  ) {
    throw new Error(
      'WanderBeds presented a security verification step; automated bypass is not supported'
    );
  }
}

async function clickAgentLogin(page) {
  const candidates = [
    page.getByText(/^Agent Login$/i),
    page.getByRole('link', { name: /Agent Login/i }),
    page.getByRole('button', { name: /Agent Login/i })
  ];

  for (const locator of candidates) {
    if (
      await locator.count().catch(() => 0) &&
      await locator.first().isVisible().catch(() => false)
    ) {
      await locator.first().click().catch(() => {});
      await page.waitForTimeout(1000);
      return;
    }
  }
}


async function login(page, source, cfg) {
  console.log("WanderBeds: starting automatic login");

  await page.waitForTimeout(3000);

  const form = page.locator("#agentlogin-form").first();

  await form.waitFor({
    state: "visible",
    timeout: 30000
  });

  console.log("WanderBeds: login form found");

  const agentCode = page.locator("#agentcode").first();
  const username = page.locator("#username").first();
  const password = page.locator("#password").first();

  await agentCode.fill(
    String(source.agent_code || source.site_agent_code || "")
  );

  await username.fill(
    String(source.site_username || "")
  );

  const decryptedPassword = decrypt(source.site_password_enc);

  await password.fill(decryptedPassword);

  console.log("WanderBeds: credentials entered");

  await page.waitForTimeout(500);

  const signIn = page.locator("#agentlogin_signin").first();

  if (!await signIn.isVisible().catch(() => false)) {
    throw new Error("WanderBeds Sign in button is not visible");
  }

  console.log("WanderBeds: submitting #agentlogin-form");

  const wanderBedsRequests = [];

  const requestListener = request => {
    try {
      const url = request.url();

      if (
        url.includes("wanderbeds.com") &&
        request.method() !== "GET"
      ) {
        console.log(
          "WanderBeds REQUEST:",
          request.method(),
          url
        );

        wanderBedsRequests.push({
          type: "request",
          method: request.method(),
          url
        });
      }
    } catch (_) {}
  };

  const responseListener = response => {
    try {
      const url = response.url();

      if (url.includes("wanderbeds.com")) {
        console.log(
          "WanderBeds RESPONSE:",
          response.status(),
          url
        );

        wanderBedsRequests.push({
          type: "response",
          status: response.status(),
          url
        });
      }
    } catch (_) {}
  };

  page.on("request", requestListener);
  page.on("response", responseListener);

  try {
    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 30000
      }),
      signIn.click()
    ]);
  } catch (err) {
    console.log(
      "WanderBeds: navigation wait finished:",
      err.message
    );
  }

  await page.waitForTimeout(5000);

  console.log(
    "WanderBeds: URL after login:",
    page.url()
  );

  console.log(
    "WanderBeds: captured network events:",
    JSON.stringify(wanderBedsRequests, null, 2)
  );

  try {
    const cookies = await page.context().cookies("https://wanderbeds.com");

    console.log(
      "WanderBeds: cookies after login:",
      cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        expires: c.expires
      }))
    );
  } catch (err) {
    console.log(
      "WanderBeds: cookie inspection failed:",
      err.message
    );
  }

  page.off("request", requestListener);
  page.off("response", responseListener);

  const passwordStillVisible =
    await page.locator("#password:visible")
      .count()
      .catch(() => 0);

  if (passwordStillVisible > 0) {
    const body = await page.locator("body")
      .innerText()
      .catch(() => "");

    console.log(
      "WanderBeds: login form is STILL visible"
    );

    console.log(
      "WanderBeds: page after submit:",
      body.slice(0, 3000)
    );

    throw new Error(
      "WanderBeds rejected the login or returned to the login form"
    );
  }

  const authenticatedSelectors = [
    "#sh_destination",
    "#modal_dates_caption",
    "#modal_rooms_caption",
    "#search"
  ];

  for (const selector of authenticatedSelectors) {
    const count = await page.locator(selector)
      .count()
      .catch(() => 0);

    if (count > 0) {
      console.log(
        "WanderBeds: authenticated control detected:",
        selector
      );

      return true;
    }
  }

  const bodyTextValue = await page.locator("body")
    .innerText()
    .catch(() => "");

  if (
    /destination/i.test(bodyTextValue) &&
    /check.?in|check.?out/i.test(bodyTextValue)
  ) {
    console.log(
      "WanderBeds: authenticated search page detected by text"
    );

    return true;
  }

  console.log(
    "WanderBeds: login could not be verified"
  );

  console.log(
    "WanderBeds: current page text:",
    bodyTextValue.slice(0, 3000)
  );

  throw new Error(
    "WanderBeds Sign in was clicked but login could not be verified. URL: " +
    page.url()
  );
}
async function findSearchPage(page, cfg) {
  if (cfg.search_page_url) {
    await page.goto(
      cfg.search_page_url,
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    ).catch(() => {});

    await page.waitForTimeout(2500);
  }

  const end =
    Date.now() +
    (Number(cfg.search_page_timeout_ms) || 30000);

  while (Date.now() < end) {
    const text = await bodyText(page);

    if (
      /hotel|check.?in|check.?out|destination|going to|travellers/i.test(text)
    ) {
      return page;
    }

    await page.waitForTimeout(500);
  }

  return page;
}

async function findVisibleInput(page, patterns) {
  const inputs = page.locator('input');
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);

    if (!(await el.isVisible().catch(() => false))) {
      continue;
    }

    const meta = await el.evaluate((e) => ({
      type: e.type,
      name: e.name,
      id: e.id,
      placeholder: e.placeholder,
      aria: e.getAttribute('aria-label')
    })).catch(() => null);

    if (!meta) continue;

    const descriptor =
      `${meta.name || ''} ${meta.id || ''} ${meta.placeholder || ''} ${meta.aria || ''}`;

    if (patterns.some((p) => p.test(descriptor))) {
      return el;
    }
  }

  return null;
}

async function fillByLabel(page, labels, value) {
  for (const label of labels) {
    const loc = page
      .getByLabel(label, { exact: false })
      .first();

    if (
      await loc.count().catch(() => 0) &&
      await loc.isVisible().catch(() => false)
    ) {
      await loc.fill(String(value));
      return true;
    }
  }

  return false;
}

function parseISODate(value) {
  const m = String(value || '').match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!m) {
    throw new Error(`Invalid date: ${value}`);
  }

  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3])
  };
}

function monthName(month) {
  return new Date(2020, month - 1, 1).toLocaleString(
    'en-US',
    { month: 'long' }
  );
}

async function acceptWanderBedsCookies(page) {
  const buttons = page.locator('button, a, [role="button"]');
  const count = await buttons.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = buttons.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    const text = (await el.innerText().catch(() => '')).trim();

    if (/^I Agree$/i.test(text)) {
      console.log("WanderBeds: accepting cookies...");
      await el.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return true;
    }
  }

  return false;
}

async function openDatePicker(page) {
  console.log('WanderBeds: opening date picker...');
  await page.waitForTimeout(2000);

  const candidates = page.locator(
    'input, button, [role="button"], [role="combobox"], [role="textbox"]'
  );

  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    const meta = await el.evaluate((e) => ({
      tag: e.tagName,
      text: e.innerText || "",
      value: e.value || "",
      placeholder: e.getAttribute("placeholder") || "",
      aria: e.getAttribute("aria-label") || "",
      title: e.getAttribute("title") || "",
      name: e.getAttribute("name") || "",
      id: e.id || ""
    })).catch(() => null);

    if (!meta) continue;

    const descriptor = [
      meta.text, meta.value, meta.placeholder,
      meta.aria, meta.title, meta.name, meta.id
    ].join(" ");

    if (!/check.?in|arrival|select.?date|dates/i.test(descriptor)) continue;

    console.log("WanderBeds: clicking date control:", descriptor.substring(0, 180));

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);

    const calendar = page.locator(
      '[role="dialog"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i]'
    );

    const calendarCount = await calendar.count().catch(() => 0);
    for (let j = 0; j < calendarCount; j++) {
      if (await calendar.nth(j).isVisible().catch(() => false)) {
        console.log('WanderBeds: calendar detected');
        return true;
      }
    }

    console.log('WanderBeds: date control clicked');
    return true;
  }

  throw new Error('WanderBeds date picker could not be opened');
}
async function getCalendarRoot(page) {
  const selectors = [
    '[role="dialog"]',
    '[role="application"]',
    '[class*="datepicker" i]',
    '[class*="date-picker" i]',
    '[class*="calendar" i]',
    '[class*="calendar-container" i]',
    '[class*="calendar-wrapper" i]',
    '[class*="date-picker-container" i]'
  ];

  const monthRe =
    /January|February|March|April|May|June|July|August|September|October|November|December/i;

  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);

      if (!(await item.isVisible().catch(() => false))) continue;

      const text = await item.innerText().catch(() => "");
      const lower = String(text).toLowerCase();

      const hasMonth = monthRe.test(text);

      const hasDateStructure =
        lower.includes("sun") ||
        lower.includes("mon") ||
        lower.includes("tue") ||
        lower.includes("wed") ||
        lower.includes("thu") ||
        lower.includes("fri") ||
        lower.includes("sat") ||
        /\b(?:[1-9]|[12]\d|3[01])\b/.test(text);

      if (hasMonth || hasDateStructure) {
        return item;
      }
    }
  }

  const candidates = page.locator(
    '[role="grid"], [role="gridcell"], table, tbody'
  );

  const candidateCount = await candidates.count().catch(() => 0);

  for (let i = 0; i < candidateCount; i++) {
    const item = candidates.nth(i);

    if (!(await item.isVisible().catch(() => false))) continue;

    const text = await item.innerText().catch(() => "");
    const dateCount =
      (text.match(/\b(?:[1-9]|[12]\d|3[01])\b/g) || []).length;

    if (dateCount >= 10) {
      const parent = item.locator("xpath=..");

      if (await parent.isVisible().catch(() => false)) {
        return parent;
      }

      return item;
    }
  }

  const dialogs = page.locator('[role="dialog"]');
  const dialogCount = await dialogs.count().catch(() => 0);

  for (let i = 0; i < dialogCount; i++) {
    const dialog = dialogs.nth(i);

    if (await dialog.isVisible().catch(() => false)) {
      return dialog;
    }
  }

  return page.locator("body");
}

async function calendarText(page) {
  const root = await getCalendarRoot(page);
  return clean(await root.innerText().catch(() => ''));
}

async function clickCalendarArrow(page, direction) {
  const root = await getCalendarRoot(page);

  const patterns = direction === 'next'
    ? [
        /next.?month/i,
        /next/i,
        /forward/i
      ]
    : [
        /previous.?month/i,
        /prev.?month/i,
        /previous/i,
        /back/i
      ];

  for (const pattern of patterns) {
    const selectors = [
      `button[aria-label*="${direction === 'next' ? 'Next' : 'Previous'}" i]`,
      `button[title*="${direction === 'next' ? 'Next' : 'Previous'}" i]`,
      `button[data-testid*="${direction}" i]`
    ];

    for (const selector of selectors) {
      const loc = root.locator(selector);

      if (
        await loc.count().catch(() => 0) &&
        await loc.first().isVisible().catch(() => false)
      ) {
        await loc.first().click().catch(() => {});
        await page.waitForTimeout(250);
        return true;
      }
    }

    const buttons = root.locator('button');
    const count = await buttons.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const b = buttons.nth(i);

      if (!(await b.isVisible().catch(() => false))) {
        continue;
      }

      const meta = await b.evaluate((e) => ({
        text: e.innerText || '',
        aria: e.getAttribute('aria-label') || '',
        title: e.getAttribute('title') || ''
      })).catch(() => null);

      if (!meta) continue;

      const descriptor =
        `${meta.text} ${meta.aria} ${meta.title}`;

      if (patterns.some((p) => p.test(descriptor))) {
        await b.click().catch(() => {});
        await page.waitForTimeout(250);
        return true;
      }
    }
  }

  return false;
}

async function calendarHasMonth(page, month, year) {
  const text = await calendarText(page);

  return (
    text.includes(`${monthName(month)} ${year}`) ||
    new RegExp(`${monthName(month)}\\s+${year}`, 'i').test(text)
  );
}

async function moveCalendarToMonth(page, targetYear, targetMonth) {
  const targetKey =
    `${Number(targetYear)}-${String(Number(targetMonth) + 1).padStart(2, "0")}`;

  console.log(
    "WanderBeds: moving active calendar to:",
    targetKey
  );

  for (let attempt = 1; attempt <= 24; attempt++) {
    const state = await page.evaluate(() => {
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          s.opacity !== "0"
        );
      };

      const pickers = Array.from(
        document.querySelectorAll("#ui-datepicker-div, .ui-datepicker")
      ).filter(visible);

      const picker = pickers
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0];

      if (!picker) {
        return {
          found: false,
          months: [],
          prev: false,
          next: false
        };
      }

      const months = [];

      const headers = Array.from(
        picker.querySelectorAll(".ui-datepicker-title")
      );

      for (const header of headers) {
        const monthEl = header.querySelector(".ui-datepicker-month");
        const yearEl = header.querySelector(".ui-datepicker-year");

        if (!monthEl || !yearEl) continue;

        const monthName = monthEl.textContent.trim();
        const year = Number(yearEl.textContent.trim());

        const monthNames = [
          "January","February","March","April","May","June",
          "July","August","September","October","November","December"
        ];

        const month = monthNames.indexOf(monthName);

        if (Number.isInteger(year) && month >= 0) {
          months.push({
            year,
            month,
            key:
              `${year}-${String(month + 1).padStart(2, "0")}`
          });
        }
      }

      const prev = Array.from(
        picker.querySelectorAll(".ui-datepicker-prev")
      ).find(visible);

      const next = Array.from(
        picker.querySelectorAll(".ui-datepicker-next")
      ).find(visible);

      return {
        found: true,
        months,
        prev: !!prev,
        next: !!next
      };
    });

    console.log(
      "WanderBeds: active calendar state:",
      JSON.stringify({
        attempt,
        target: targetKey,
        months: state.months
      })
    );

    if (!state.found || !state.months.length) {
      await page.waitForTimeout(300);
      continue;
    }

    if (state.months.some(m => m.key === targetKey)) {
      console.log(
        "WanderBeds: target month reached:",
        targetKey
      );
      return;
    }

    const targetIndex =
      Number(targetYear) * 12 + Number(targetMonth);

    const nearest = state.months
      .map(m => ({
        ...m,
        index: Number(m.year) * 12 + Number(m.month)
      }))
      .sort(
        (a, b) =>
          Math.abs(a.index - targetIndex) -
          Math.abs(b.index - targetIndex)
      )[0];

    if (!nearest) {
      await page.waitForTimeout(300);
      continue;
    }

    const direction =
      targetIndex < nearest.index
        ? "previous"
        : targetIndex > nearest.index
          ? "next"
          : null;

    console.log(
      "WanderBeds: active calendar direction:",
      JSON.stringify({
        target: targetKey,
        nearest: nearest.key,
        direction
      })
    );

    if (!direction) {
      return;
    }

    const clicked = await page.evaluate(direction => {
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          s.opacity !== "0"
        );
      };

      const pickerCandidates = Array.from(
        document.querySelectorAll("#ui-datepicker-div, .ui-datepicker")
      ).filter(visible);

      const picker = pickerCandidates
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0];

      if (!picker) return false;

      const selector =
        direction === "next"
          ? ".ui-datepicker-next"
          : ".ui-datepicker-prev";

      const button = Array.from(
        picker.querySelectorAll(selector)
      ).find(visible);

      if (!button) return false;

      button.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );

      button.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );

      button.click();

      return true;
    }, direction);

    console.log(
      "WanderBeds: active calendar navigation click:",
      JSON.stringify({
        direction,
        clicked
      })
    );

    if (!clicked) {
      throw new Error(
        `WanderBeds could not click ${direction} calendar button`
      );
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    `WanderBeds could not move calendar to ${targetKey}`
  );
}
async function selectCalendarDate(page, value) {

  const parts = String(value).split("-");

  if (parts.length !== 3) {
    throw new Error(
      "Invalid WanderBeds date: " + value
    );
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  console.log(
    "WanderBeds: selecting date:",
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  );

  /*
   * Make sure the requested month is displayed first.
   */
  await moveCalendarToMonth(
    page,
    year,
    month - 1
  );

  await page.waitForTimeout(300);

  const result = await page.evaluate(
    ({ year, month, day }) => {

      /*
       * IMPORTANT:
       *
       * Do NOT use getBoundingClientRect().
       * WanderBeds' datepicker can contain valid date cells
       * whose browser geometry reports zero.
       */

      const cells = Array.from(
        document.querySelectorAll(
          'td[data-handler="selectDay"][data-year][data-month]'
        )
      );

      const candidates = [];

      for (const td of cells) {

        const cellYear =
          Number(td.getAttribute("data-year"));

        const cellMonth =
          Number(td.getAttribute("data-month"));

        const anchor =
          td.querySelector("a[data-date]");

        if (!anchor) {
          continue;
        }

        const cellDay =
          Number(anchor.getAttribute("data-date"));

        /*
         * jQuery UI normally uses zero-based months.
         * WanderBeds markup has been observed using this format.
         */
        const monthMatches =
          cellMonth === month - 1 ||
          cellMonth === month;

        if (
          cellYear === year &&
          monthMatches &&
          cellDay === day
        ) {

          const disabled =
            td.classList.contains(
              "ui-datepicker-unselectable"
            ) ||
            td.classList.contains(
              "ui-state-disabled"
            ) ||
            td.classList.contains(
              "disabled"
            ) ||
            anchor.classList.contains(
              "ui-state-disabled"
            );

          candidates.push({
            td,
            anchor,
            disabled
          });
        }
      }

      console.log(
        "WanderBeds matching calendar dates:",
        candidates.length
      );

      if (!candidates.length) {

        return {
          ok: false,
          target: {
            year,
            month,
            day
          },

          availableCells: cells.map(td => {

            const anchor =
              td.querySelector("a[data-date]");

            return {
              date:
                anchor?.getAttribute("data-date") || "",
              year:
                td.getAttribute("data-year") || "",
              month:
                td.getAttribute("data-month") || "",
              disabled:
                td.classList.contains(
                  "ui-datepicker-unselectable"
                ) ||
                td.classList.contains(
                  "ui-state-disabled"
                ) ||
                td.classList.contains(
                  "disabled"
                )
            };

          })
        };
      }

      const target =
        candidates.find(x => !x.disabled);

      if (!target) {

        return {
          ok: false,
          target: {
            year,
            month,
            day
          },
          reason: "Target date is disabled"
        };
      }

      /*
       * Click the actual anchor.
       * This is more reliable than Playwright visibility checks.
       */
      console.log(
        "WanderBeds clicking calendar date:",
        target.anchor.outerHTML
      );

      target.anchor.click();

      return {
        ok: true,
        text:
          (target.anchor.innerText ||
           target.anchor.textContent ||
           "").trim(),
        html:
          target.anchor.outerHTML,
        year,
        month,
        day
      };

    },
    {
      year,
      month,
      day
    }
  );

  console.log(
    "WanderBeds date DOM result:",
    JSON.stringify(result)
  );

  if (!result.ok) {

    throw new Error(
      "WanderBeds calendar date " +
      value +
      " could not be selected"
    );
  }

  await page.waitForTimeout(700);

  console.log(
    "WanderBeds: date selected successfully:",
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  );
}
async function finishCalendar(page) {
  console.log("WanderBeds: finishing calendar");

  const selectors = [
    "#done",
    'button:has-text("Done")',
    'button:has-text("Apply")',
    '[data-action="done"]',
    '[data-action="apply"]'
  ];

  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      const count = await button.count().catch(() => 0);

      if (!count) continue;

      console.log("WanderBeds: Done/Apply control found:", selector);

      await button.click({ force: true }).catch(async () => {
        await button.evaluate(el => el.click());
      });

      await page.waitForTimeout(700);

      console.log("WanderBeds: calendar finished");
      return true;
    } catch (err) {
      console.log("WanderBeds: finish control failed:", selector, err.message);
    }
  }

  console.log("WanderBeds: no calendar Done/Apply control found");
  return false;
}
async function selectDates(page, checkin, checkout) {
  await openDatePicker(page);

  await selectCalendarDate(page, checkin);

  await page.waitForTimeout(300);

  await selectCalendarDate(page, checkout);

  await finishCalendar(page);
}

async function fillSearch(page, search) {
  console.log("WanderBeds: fillSearch START");

  const destination = await findVisibleInput(page, [
    /going.?to/i,
    /destination/i,
    /city/i
  ]);

  console.log("WanderBeds: destination found:", !!destination);

  if (destination) {
    const destinationRequested = String(search.destination || "").trim();

    // The portal uses "City - Country", while WanderBeds autocomplete
    // searches its destination field by city/destination text.
    // Send only the city portion to WanderBeds.
    const destinationValue =
      destinationRequested.split(/\s+-\s+/)[0].trim() ||
      destinationRequested;

    console.log(
      "WanderBeds: entering destination:",
      destinationValue
    );

    console.log(
      "WanderBeds: portal destination:",
      destinationRequested
    );

    await destination.click().catch(() => {});
    await destination.fill("");

    // IMPORTANT:
    // WanderBeds autocomplete is AJAX/keyboard driven.
    await destination.type(destinationValue, { delay: 35 });

    await page.waitForTimeout(1500);

    const autocompleteDebug = await page.locator(
      "ul.ui-autocomplete, .ui-autocomplete, [role='listbox']"
    ).evaluateAll(nodes =>
      nodes.map(n => ({
        text: String(n.innerText || n.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        html: String(n.outerHTML || "").substring(0, 5000)
      })).filter(x => x.text || x.html)
    ).catch(() => []);

    console.log(
      "WanderBeds: destination autocomplete:",
      JSON.stringify(autocompleteDebug, null, 2)
    );

    // Select the BEST autocomplete result.
    // Match the portal's City - Country destination instead of
    // blindly selecting the first autocomplete item.

    const portalDestination =
      String(search.destination || "").trim();

    const destinationParts = portalDestination
      .split(/\s+-\s+/)
      .map(x => x.trim())
      .filter(Boolean);

    const requestedCity =
      destinationParts[0] || destinationValue;

    const requestedCountry =
      destinationParts.length >= 2
        ? destinationParts.slice(1).join(" - ").trim()
        : "";

    const normalizeDestination = value =>
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

    const cityNorm = normalizeDestination(requestedCity);
    const countryNorm = normalizeDestination(requestedCountry);

    console.log(
      "WanderBeds: destination matcher input:",
      JSON.stringify({
        original: destinationRequested,
        city: requestedCity,
        country: requestedCountry,
        portalDestination
      }, null, 2)
    );

    // Use only the actual visible autocomplete <li> elements.
    const suggestionSelector =
      "ul.ui-autocomplete:visible > li.ui-menu-item";

    const suggestionInfo = await page.locator(
      suggestionSelector
    ).evaluateAll((nodes, data) => {
      const normalize = value =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\s+/g, " ")
          .trim();

      const city = normalize(data.city);
      const country = normalize(data.country);

      return nodes.map((node, index) => {
        const text = String(
          node.innerText ||
          node.textContent ||
          ""
        ).replace(/\s+/g, " ").trim();

        const normalized = normalize(text);

        let score = 0;

        // City + country is the strongest match.
        if (
          city &&
          country &&
          normalized.includes(city) &&
          normalized.includes(country)
        ) {
          score += 10000;
        }

        // Exact city at the beginning.
        if (
          city &&
          (
            normalized === city ||
            normalized.startsWith(city + " ")
          )
        ) {
          score += 2000;
        }

        // City anywhere.
        if (city && normalized.includes(city)) {
          score += 500;
        }

        // Country anywhere.
        if (country && normalized.includes(country)) {
          score += 3000;
        }

        return {
          index,
          text,
          normalized,
          score
        };
      });
    }, {
      city: requestedCity,
      country: requestedCountry
    }).catch(() => []);

    console.log(
      "WanderBeds: destination candidates:",
      JSON.stringify(suggestionInfo, null, 2)
    );

    if (suggestionInfo.length) {
      const best = [...suggestionInfo]
        .sort((a, b) => b.score - a.score)[0];

      console.log(
        "WanderBeds: BEST destination candidate:",
        JSON.stringify(best, null, 2)
      );

      const candidates = page.locator(suggestionSelector);

      const bestCandidate = candidates.nth(best.index);

      const candidateText = await bestCandidate
        .innerText()
        .catch(() => "");

      console.log(
        "WanderBeds: clicking exact destination candidate:",
        JSON.stringify({
          index: best.index,
          text: candidateText
        }, null, 2)
      );

      await bestCandidate.scrollIntoViewIfNeeded().catch(() => {});
      await bestCandidate.click();

      await page.waitForTimeout(700);
    } else {
      console.log(
        "WanderBeds: no destination candidates found; using keyboard fallback"
      );

      await destination.press("ArrowDown").catch(() => {});
      await destination.press("Enter").catch(() => {});
      await page.waitForTimeout(700);
    }
    const destinationSelected = await page.locator(
      "#sh_destination"
    ).inputValue().catch(() => "");

    const destinationCode = await page.locator(
      "#sh_destination-id"
    ).inputValue().catch(() => "");

    console.log(
      "WanderBeds: destination selection:",
      JSON.stringify({
        requested: destinationRequested,
        selected: destinationSelected,
        code: destinationCode
      }, null, 2)
    );
    if (!destinationCode) {
      console.log(
        "WanderBeds: autocomplete keyboard selection did not produce a destination code; trying direct AJAX fallback"
      );

      const ajaxResult = await page.evaluate(async (destinationValue) => {
        const clean = v => String(v || "").replace(/\s+/g, " ").trim();

        try {
          const url =
            "/ajax/autocomplete/hoteldestination/?term=" +
            encodeURIComponent(destinationValue);

          const response = await fetch(url, {
            credentials: "same-origin",
            headers: {
              "X-Requested-With": "XMLHttpRequest"
            }
          });

          const text = await response.text();

          let data;
          try {
            data = JSON.parse(text);
          } catch (_) {
            return {
              ok: false,
              status: response.status,
              contentType: response.headers.get("content-type") || "",
              preview: text.substring(0, 3000)
            };
          }

          const items = Array.isArray(data)
            ? data
            : Array.isArray(data.results)
              ? data.results
              : Array.isArray(data.data)
                ? data.data
                : [];

          const normalized = items.map(item => ({
            label: clean(
              item.label ||
              item.value ||
              item.name ||
              item.text ||
              item.title ||
              ""
            ),
            value: clean(
              item.value ||
              item.name ||
              item.label ||
              item.text ||
              ""
            ),
            code: clean(
              item.id ||
              item.code ||
              item.destination_id ||
              item.destinationId ||
              item.hotel_destination_id ||
              ""
            ),
            raw: item
          }));

          const requested = clean(destinationValue).toLowerCase();

          const exact =
            normalized.find(x =>
              x.value.toLowerCase() === requested ||
              x.label.toLowerCase() === requested
            ) ||
            normalized.find(x =>
              x.value.toLowerCase().includes(requested) ||
              x.label.toLowerCase().includes(requested)
            ) ||
            normalized[0];

          if (!exact) {
            return {
              ok: false,
              status: response.status,
              items: normalized.slice(0, 20)
            };
          }

          return {
            ok: true,
            status: response.status,
            selected: exact,
            items: normalized.slice(0, 20)
          };
        } catch (error) {
          return {
            ok: false,
            error: error.message
          };
        }
      }, destinationValue);

      console.log(
        "WanderBeds: direct destination AJAX result:",
        JSON.stringify(ajaxResult, null, 2)
      );

      if (ajaxResult.ok && ajaxResult.selected) {
        const selectedValue =
          ajaxResult.selected.value ||
          ajaxResult.selected.label ||
          destinationValue;

        const selectedCode =
          ajaxResult.selected.code || "";

        if (selectedCode) {
          await page.locator("#sh_destination").fill(selectedValue);
          await page.locator("#sh_destination-id").fill(selectedCode);

          console.log(
            "WanderBeds: destination set by AJAX fallback:",
            JSON.stringify({
              value: selectedValue,
              code: selectedCode
            }, null, 2)
          );
        }
      }

      const finalDestinationCode = await page.locator(
        "#sh_destination-id"
      ).inputValue().catch(() => "");

      if (!finalDestinationCode) {
        throw new Error(
          `WanderBeds destination code was not selected for "${destinationSelected}".`
        );
      }
    }
  }

  console.log("WanderBeds: destination DONE");

  await selectDates(page, search.checkin, search.checkout);

  console.log("WanderBeds: dates DONE");

  const nationality = await findVisibleInput(page, [
    /nationality/i,
    /country.?of.?residence/i
  ]);

  console.log("WanderBeds: nationality found:", !!nationality);

  if (nationality) {
    await nationality.fill(
      String(search.country || "United States of America")
    );
    await page.waitForTimeout(500);
    await nationality.press("ArrowDown").catch(() => {});
    await nationality.press("Enter").catch(() => {});
  }

  console.log("WanderBeds: nationality DONE");

  // Open the actual WanderBeds Rooms and guests control.
  const roomsButton = page.locator("#modal_rooms_caption").first();

  console.log(
    "WanderBeds: rooms button count:",
    await roomsButton.count().catch(() => 0)
  );

  if (
    await roomsButton.count().catch(() => 0) &&
    await roomsButton.isVisible().catch(() => false)
  ) {
    await roomsButton.click().catch(() => {});
    await page.waitForTimeout(700);

    console.log("WanderBeds: rooms popup opened");

    /*
     * WanderBeds room guest controls are READONLY inputs.
     * The value must be changed using the +/- buttons.
     *
     * Actual WanderBeds controls:
     *   #sh_rooms_1_adt
     *   #sh_rooms_1_chd
     */
    const adultsInput = page.locator("#sh_rooms_1_adt").first();

    const adults = Math.max(
      1,
      Number(search.adults ?? search.guests ?? 1)
    );

    console.log(
      "WanderBeds: setting adults:",
      adults
    );

    if (
      await adultsInput.count().catch(() => 0) &&
      await adultsInput.isVisible().catch(() => false)
    ) {
      let currentAdults =
        Number(
          await adultsInput.inputValue().catch(() => "1")
        ) || 1;

      console.log(
        "WanderBeds: current adults:",
        currentAdults,
        "target:",
        adults
      );

      /*
       * WanderBeds uses readonly inputs.
       * Operate the supplier's actual +/- button.
       */
      const adjustAdults = async (direction, count) => {
        for (let i = 0; i < count; i++) {

          const result = await page.evaluate((direction) => {
            const input =
              document.querySelector("#sh_rooms_1_adt");

            if (!input) {
              return {
                ok: false,
                reason: "adult input not found"
              };
            }

            const increment =
              input.closest(".increment");

            if (!increment) {
              return {
                ok: false,
                reason: "adult increment container not found"
              };
            }

            const button =
              increment.querySelector(
                `button[data-dir="${direction}"]`
              );

            if (!button) {
              return {
                ok: false,
                reason:
                  `adult ${direction} button not found`
              };
            }

            const before =
              String(input.value || "");

            button.click();

            return {
              ok: true,
              direction,
              before,
              afterImmediate:
                String(input.value || "")
            };
          }, direction);

          console.log(
            "WanderBeds: adult button action:",
            JSON.stringify(result)
          );

          if (!result.ok) {
            throw new Error(
              "WanderBeds adult adjustment failed: " +
              result.reason
            );
          }

          await page.waitForTimeout(150);

          const actual =
            Number(
              await adultsInput
                .inputValue()
                .catch(() => "")
            );

          console.log(
            "WanderBeds: adult value after click:",
            actual
          );

          if (!Number.isFinite(actual)) {
            throw new Error(
              "WanderBeds adult value became invalid"
            );
          }

          currentAdults = actual;

          if (currentAdults === adults) {
            break;
          }
        }
      };

      if (currentAdults < adults) {
        const clicksNeeded =
          adults - currentAdults;

        console.log(
          "WanderBeds: increasing adults:",
          clicksNeeded
        );

        await adjustAdults("+", clicksNeeded);
      }

      if (currentAdults > adults) {
        const clicksNeeded =
          currentAdults - adults;

        console.log(
          "WanderBeds: decreasing adults:",
          clicksNeeded
        );

        await adjustAdults("-", clicksNeeded);
      }

      const finalAdults =
        Number(
          await adultsInput
            .inputValue()
            .catch(() => "")
        );

      console.log(
        "WanderBeds: adults after adjustment:",
        finalAdults
      );

      if (finalAdults !== adults) {
        throw new Error(
          `WanderBeds adult count mismatch: target=${adults}, actual=${finalAdults}`
        );
      }
    }
const childrenInput = page.locator("#sh_rooms_1_chd").first();

const children = Math.max(
      0,
      Number(search.children || 0)
    );

    console.log(
      "WanderBeds: setting children:",
      children
    );

    if (
      await childrenInput.count().catch(() => 0) &&
      await childrenInput.isVisible().catch(() => false)
    ) {
      const currentChildren =
        Number(
          await childrenInput.inputValue().catch(() => "0")
        ) || 0;

      console.log(
        "WanderBeds: current children:",
        currentChildren,
        "target:",
        children
      );

      const clicksNeeded = Math.max(
        0,
        children - currentChildren
      );

      if (clicksNeeded > 0) {
        const plusButton = page
          .locator(
            '#sh_rooms_1_chd + button[data-dir="+"]'
          )
          .first();

        for (let i = 0; i < clicksNeeded; i++) {
          await plusButton.click();
          await page.waitForTimeout(100);
        }
      }

      console.log(
        "WanderBeds: children after adjustment:",
        await childrenInput.inputValue().catch(() => "")
      );
    }
    const doneButton = page.locator("#modal_rooms #done").first();

    if (
      await doneButton.count().catch(() => 0) &&
      await doneButton.isVisible().catch(() => false)
    ) {
      console.log("WanderBeds: clicking rooms Done");

      const doneHtml =
        await doneButton
          .evaluate(el => el.outerHTML)
          .catch(() => "");

      console.log(
        "WanderBeds: Done button HTML:",
        doneHtml
      );

      /*
       * WanderBeds native handler:
       *
       *   function modalDone(btn) {
       *     let modal = $(btn).closest('.modal');
       *     initCancel(modal);
       *     modal.modal('hide');
       *   }
       *
       * Call the site's own function directly.
       */
      await doneButton.evaluate((el) => {
        if (typeof window.modalDone === "function") {
          window.modalDone(el);
        } else {
          el.click();
        }
      }).catch(err => {
        console.log(
          "WanderBeds: modalDone execution error:",
          err.message
        );
      });

      /*
       * Wait until Bootstrap actually removes the
       * visible modal state.
       */
      try {
        await page.waitForFunction(() => {
          const modal = document.querySelector("#modal_rooms");

          if (!modal) return true;

          const style = window.getComputedStyle(modal);

          return (
            !modal.classList.contains("show") &&
            style.display === "none"
          );
        }, null, { timeout: 5000 });

        console.log(
          "WanderBeds: Rooms modal CLOSED successfully"
        );
      } catch (err) {
        console.log(
          "WanderBeds: Rooms modal did NOT close:",
          err.message
        );

        console.log(
          "WanderBeds: modal state:",
          await page.locator("#modal_rooms").evaluate(el => ({
            className: el.className,
            display: window.getComputedStyle(el).display,
            ariaHidden: el.getAttribute("aria-hidden")
          })).catch(() => null)
        );
      }

      await page.waitForTimeout(300);
    } else {
      console.log(
        "WanderBeds: Rooms Done button NOT found/visible"
      );
    }

    console.log(
      "WanderBeds: ROOMS DOM:",
      await page.locator(
        "input, select, button, [role='button']"
      ).evaluateAll(els =>
        els
          .filter(e => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map(e => ({
            tag: e.tagName,
            type: e.type || "",
            id: e.id || "",
            name: e.name || "",
            value: e.value || "",
            text: (e.innerText || "").trim(),
            aria: e.getAttribute("aria-label") || "",
            title: e.getAttribute("title") || "",
            cls: typeof e.className === "string" ? e.className : ""
          }))
      )
    );

    console.log(
      "WanderBeds: rooms popup text:",
      (await page.locator("body").innerText().catch(() => ""))
        .slice(-3000)
    );
  }

  console.log(
    "WanderBeds: rooms caption:",
    await roomsButton.innerText().catch(() => "")
  );

  console.log(
    "WanderBeds: INPUT DEBUG:",
    await page.locator("input, select, button").evaluateAll(els =>
      els
        .filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(e => ({
          tag: e.tagName,
          type: e.type || "",
          id: e.id || "",
          name: e.name || "",
          placeholder: e.placeholder || "",
          aria: e.getAttribute("aria-label") || "",
          text: (e.innerText || "").trim(),
          value: e.value || ""
        }))
    )
  );

  // Use the actual WanderBeds Search button.
  const searchButton = page.locator("#search").first();

  console.log(
    "WanderBeds: #search count:",
    await searchButton.count().catch(() => 0)
  );

  if (
    await searchButton.count().catch(() => 0) &&
    await searchButton.isVisible().catch(() => false)
  ) {
    console.log("WanderBeds: inspecting search form...");

    try {
      const formInfo = await searchButton.evaluate((button) => {
        const form = button.closest("form");

        if (!form) {
          return {
            found: false,
            reason: "Search button has no parent form"
          };
        }

        return {
          found: true,
          action: form.action,
          method: form.method,
          target: form.target,
          enctype: form.enctype,
          id: form.id,
          className: form.className,
          html: form.outerHTML.substring(0, 12000)
        };
      });

      console.log(
        "WanderBeds: SEARCH FORM INFO:",
        JSON.stringify(formInfo, null, 2)
      );
    } catch (err) {
      console.log(
        "WanderBeds: search form inspection error:",
        err.message
      );
    }

    console.log("WanderBeds: SEARCH FORM FIELDS:");

try {
  const formFields = await searchButton.evaluate((button) => {
    const form = button.closest("form");
    if (!form) return [];

    return Array.from(form.elements).map((el) => ({
      tag: el.tagName,
      type: el.type || "",
      id: el.id || "",
      name: el.name || "",
      value: el.value || "",
      disabled: !!el.disabled
    }));
  });

  console.log(
    "WanderBeds: SEARCH FORM FIELDS:",
    JSON.stringify(formFields, null, 2)
  );
} catch (err) {
  console.log(
    "WanderBeds: SEARCH FORM FIELDS ERROR:",
    err.message
  );
}

console.log("WanderBeds: CLICKING #search");

    try {
      await searchButton.click({ noWaitAfter: true });
      console.log("WanderBeds: #search click completed");
    } catch (err) {
      console.log(
        "WanderBeds: #search click error:",
        err.message
      );
    }

    await page.waitForTimeout(8000);

    console.log(
      "WanderBeds: URL after search:",
      page.url()
    );
  } else {
    console.log("WanderBeds: #search not found");
  }
  console.log("WanderBeds: fillSearch END");
}
async function extractResults(page, search, cfg) {
  const waitMs = Number(cfg.results_wait_ms) || 10000;

  console.log(
    "WanderBeds: waiting for results:",
    waitMs,
    "ms"
  );

  await page.waitForTimeout(waitMs);

  console.log(
    "WanderBeds: extracting results from URL:",
    page.url()
  );

  const body = await page.locator("body").innerText().catch(() => "");

  console.log(
    "WanderBeds: result page text preview:",
    body.substring(0, 5000)
  );

  /*
   * Current WanderBeds result cards contain:
   *
   * Hotel name
   * Hotel details link
   * XX.XX USD avg/night
   * XX.XX USD total for N nights
   *
   * Therefore we use the hotel-details links rather than
   * relying on a "View Rates" button.
   */

  /*
   * WANDERBEDS HOTEL CARD DEBUG
   *
   * The Hotel details link is inside a nested row.
   * Inspect higher-level ancestors to locate the actual
   * hotel-name element.
   */
  const wanderBedsCards = await page.locator(
    'a[href*="/book/"][href*="/hoteldetails/"]'
  ).evaluateAll((els) =>
    els.slice(0, 5).map((el, index) => {
      const ancestors = [];

      let node = el;

      for (let level = 0; level < 8 && node; level++) {
        ancestors.push({
          level,
          tag: node.tagName || "",
          id: node.id || "",
          className: node.className || "",
          text: (node.innerText || "")
            .trim()
            .replace(/\s+/g, " ")
            .substring(0, 3000),
          html: (node.outerHTML || "")
            .substring(0, 12000)
        });

        node = node.parentElement;
      }

      return {
        index,
        linkText: (el.innerText || "")
          .trim()
          .replace(/\s+/g, " "),
        href: el.href || "",
        ancestors
      };
    })
  ).catch(() => []);

  console.log(
    "========== WANDERBEDS HOTEL CARD DEBUG =========="
  );

  console.log(
    JSON.stringify(
      wanderBedsCards,
      null,
      2
    )
  );

  console.log(
    "========== END WANDERBEDS HOTEL CARD DEBUG =========="
  );
  /*
   * WanderBeds hotel cards:
   *
   * The hotel name is stored in:
   *   h5.card-title
   *
   * The /hoteldetails/ link only contains:
   *   "Hotel details >"
   *
   * Therefore hotel name must be extracted from the card title.
   */
  /*
   * WanderBeds hotel name extraction FIX
   *
   * The /hoteldetails/ anchor contains only:
   *   "Hotel details >"
   *
   * The real hotel name is inside:
   *   h5.card-title
   *
   * Example:
   *   <div class="card-body">
   *      <h5 class="card-title text-truncate">
   *          Rowaa Al Aziziyah Hotel
   *      </h5>
   *   </div>
   */

  /*
   * WANDERBEDS DYNAMIC PAGINATION
   *
   * Do not assume a fixed number of pages.
   *
   * Example:
   *   Showing 1 to 18 of 68 entries
   *
   * The connector automatically reads the total and continues
   * until all entries have been loaded.
   */

  const allLinks = [];
  const seenHotelLinks = new Set();

  let paginationPage = 1;
  let paginationTotal = null;
  let paginationPageSize = null;

  for (;;) {
    const currentBody = await page
      .locator("body")
      .innerText()
      .catch(() => "");

    const rangeMatch = currentBody.match(
      /Showing\s+([\d,]+)\s+to\s+([\d,]+)\s+of\s+([\d,]+)\s+entries/i
    );

    let shownFrom = null;
    let shownTo = null;

    if (rangeMatch) {
      shownFrom = Number(rangeMatch[1].replace(/,/g, ""));
      shownTo = Number(rangeMatch[2].replace(/,/g, ""));
      paginationTotal = Number(rangeMatch[3].replace(/,/g, ""));

      if (
        Number.isFinite(shownFrom) &&
        Number.isFinite(shownTo) &&
        shownTo >= shownFrom
      ) {
        paginationPageSize = shownTo - shownFrom + 1;
      }
    }

    console.log(
      "WanderBeds: pagination state:",
      JSON.stringify({
        page: paginationPage,
        from: shownFrom,
        to: shownTo,
        total: paginationTotal,
        pageSize: paginationPageSize
      }, null, 2)
    );

    /*
     * WanderBeds extraction:
     * Inspect each visible hotel card first.
     *
     * Do not depend on /book/1/, /book/2/, /book/3/, etc.
     * The booking number can change between searches.
     */
    const visibleCards = page.locator(".card:visible");

    const pageLinks = await visibleCards
      .evaluateAll((cards) =>
        cards.map((card) => {
          const title =
            card.querySelector("h5.card-title") ||
            card.querySelector(
              ".card-title, h5, [class*='card-title']"
            );

          const name =
            (title?.innerText || "")
              .replace(/\s+/g, " ")
              .trim();

          const anchors = Array.from(
            card.querySelectorAll("a[href]")
          );

          const detailAnchor =
            anchors.find((a) => {
              const href = String(a.href || "");
              const anchorText =
                (a.innerText || a.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim();

              return (
                /\/book\/[^/]+\/hoteldetails\//i.test(href) ||
                /\/hoteldetails\//i.test(href) ||
                /hotel\s*details/i.test(anchorText)
              );
            }) || null;

          const href = detailAnchor
            ? String(detailAnchor.href || "")
            : "";

          const cardText =
            (card.innerText || "")
              .replace(/\s+/g, " ")
              .trim();

          return {
            name,
            href,
            text: cardText
          };
        })
        .filter((item) => item.name && item.href)
      )
      .catch(() => []);

    console.log(
      "WanderBeds: pagination page cards:",
      await visibleCards.count().catch(() => 0)
    );

    console.log(
      "WanderBeds: pagination page links:",
      pageLinks.length
    );

    let newLinksThisPage = 0;

    for (const item of pageLinks) {
      if (!item.name || !item.href) continue;

      if (seenHotelLinks.has(item.href)) continue;

      seenHotelLinks.add(item.href);
      allLinks.push(item);
      newLinksThisPage++;
    }

    console.log(
      "WanderBeds: pagination collected:",
      JSON.stringify({
        page: paginationPage,
        pageLinks: pageLinks.length,
        newLinks: newLinksThisPage,
        totalCollected: allLinks.length,
        totalExpected: paginationTotal
      }, null, 2)
    );

    /*
     * If the supplier tells us exactly how many entries exist
     * and we have collected them all, stop immediately.
     */
    if (
      Number.isFinite(paginationTotal) &&
      paginationTotal > 0 &&
      allLinks.length >= paginationTotal
    ) {
      console.log(
        "WanderBeds: pagination COMPLETE by total count:",
        allLinks.length,
        "/",
        paginationTotal
      );
      break;
    }

    /*
     * Locate the actual Next pagination control.
     *
     * Support common jQuery/DataTables pagination structures
     * without depending on a fixed page number.
     */
    /*
     * WanderBeds pagination.
     *
     * The actual supplier pagination is:
     *
     * .pager_bottom [class*="table_book_hotels_"][class*="_pager"]
     *   nav > ul > li > a > i.bi-arrow-right
     *
     * The arrow itself is an <i>, but the clickable element is
     * its parent <a>. We therefore resolve the arrow and click
     * the parent anchor.
     *
     * Completion is determined by the supplier's:
     * "Showing X to Y of Z entries"
     * value, never by a hard-coded number of pages.
     */

    const nextInfo = await page.evaluate(() => {
      const pager = document.querySelector(
        '[class*="table_book_hotels_"][class*="_pager"]'
      );

      if (!pager) {
        return {
          found: false,
          reason: 'pagination container not found'
        };
      }

      const items = Array.from(
        pager.querySelectorAll('li')
      );

      const candidates = items.map((li, index) => {
        const anchor = li.querySelector('a');
        const icon = li.querySelector(
          'i.bi-arrow-right, i[class*="arrow-right"]'
        );

        const text = (li.innerText || '').replace(/\s+/g, ' ').trim();

        const cls = String(li.className || '');

        return {
          index,
          text,
          className: cls,
          hasAnchor: !!anchor,
          hasArrowRight: !!icon,
          href: anchor ? anchor.href : '',
          disabled:
            cls.includes('disabled') ||
            !!li.getAttribute('aria-disabled') &&
              li.getAttribute('aria-disabled') !== 'false'
        };
      });

      /*
       * Prefer the li containing the actual right-arrow icon.
       */
      const arrowCandidate = candidates.find(
        x => x.hasArrowRight && x.hasAnchor
      );

      /*
       * Fallback: look for a pager link whose text/title/aria-label
       * indicates Next.
       */
      const nextCandidate = candidates.find(x => {
        if (!x.hasAnchor) return false;

        const haystack = [
          x.text,
          x.href
        ].join(' ').toLowerCase();

        return (
          haystack.includes('next') ||
          haystack.includes('arrow-right')
        );
      });

      const chosen = arrowCandidate || nextCandidate;

      return {
        found: !!chosen,
        reason: chosen ? 'next candidate found' : 'next candidate not found',
        candidate: chosen || null,
        candidates
      };
    });

    console.log(
      "WanderBeds: actual pagination diagnostic:",
      JSON.stringify(nextInfo, null, 2)
    );

    /*
     * WanderBeds keeps the right-arrow element in the DOM even when
     * there is no further numbered page. Check the actual numbered
     * pager before trusting the arrow.
     */
    const pagerPageNumbers = await page.evaluate(() => {
      const selectors = [
        "[class*='table_book_hotels_'][class*='_pager']",
        "[class*='table_book_hotels_'][class*='_pager'] nav",
        ".dataTables_paginate",
        ".pagination",
        "nav[aria-label*='pagination' i]"
      ];

      const matches = [];

      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          matches.push({
            selector,
            tag: el.tagName,
            className: String(el.className || ""),
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000),
            html: el.outerHTML.slice(0, 5000)
          });
        }
      }

      console.log(
        "WanderBeds: PAGINATION DOM DIAGNOSTIC:",
        JSON.stringify(matches, null, 2)
      );

      const numberTexts = [];

      for (const el of document.querySelectorAll(
        "[class*='table_book_hotels_'][class*='_pager'] li, " +
        ".dataTables_paginate li, " +
        ".pagination li"
      )) {
        const text = (el.innerText || "").trim();

        if (/^\d+$/.test(text)) {
          numberTexts.push(Number(text));
        }
      }

      return [...new Set(numberTexts)];
    }).catch(() => []);

    const highestPagerPage = pagerPageNumbers.length
      ? Math.max(...pagerPageNumbers)
      : null;

    const currentPagerPage = await page.evaluate(() => {
      const active = document.querySelector(
        "[class*='table_book_hotels_'][class*='_pager'] li.active"
      );

      if (!active) return null;

      const text = (active.innerText || "").trim();

      return /^\d+$/.test(text) ? Number(text) : null;
    }).catch(() => null);

    console.log(
      "WanderBeds: pager numbered pages:",
      JSON.stringify(pagerPageNumbers),
      "highest:",
      highestPagerPage,
      "current:",
      currentPagerPage
    );

    if (
      highestPagerPage !== null &&
      currentPagerPage !== null &&
      currentPagerPage >= highestPagerPage
    ) {
      console.log(
        "WanderBeds: current page is the highest numbered pager page. " +
        "Stopping pagination."
      );
      break;
    }

    if (!nextInfo.found || !nextInfo.candidate) {
      console.log(
        "WanderBeds: no Next pagination control found. " +
        "Stopping pagination."
      );
      break;
    }

    if (nextInfo.candidate.disabled) {
      console.log(
        "WanderBeds: Next pagination control is disabled. " +
        "Pagination complete."
      );
      break;
    }

    /*
     * Capture the current page signature before clicking.
     * This prevents us from continuing while the same page is
     * still rendered.
     */
    const oldSignature = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll(
          'a[href*="/book/"][href*="/hoteldetails/"]'
        )
      )
        .map(el => el.href || '')
        .join('|');
    }).catch(() => '');

    const oldRange = await page.locator("body")
      .innerText()
      .catch(() => "");

    console.log(
      "WanderBeds: current pagination range:",
      (oldRange.match(
        /Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+[\d,]+\s+entries/i
      ) || [])[0] || "not detected"
    );

    /*
     * Re-find the actual clickable <a> immediately before clicking.
     * Do NOT retain a stale DOM element.
     */
    const nextControl = page.locator(
      '[class*="table_book_hotels_"][class*="_pager"] nav ul li:has(i.bi-arrow-right) a, ' +
      '[class*="table_book_hotels_"][class*="_pager"] nav ul li:has(i[class*="arrow-right"]) a'
    ).first();

    const nextCount = await nextControl.count().catch(() => 0);

    console.log(
      "WanderBeds: actual Next anchor count:",
      nextCount
    );

    if (!nextCount) {
      /*
       * Fallback to any Next-labelled anchor inside the actual pager.
       */
      const fallbackNext = page.locator(
        '[class*="table_book_hotels_"][class*="_pager"] nav a'
      ).filter({
        hasText: /next/i
      }).first();

      const fallbackCount = await fallbackNext.count().catch(() => 0);

      console.log(
        "WanderBeds: fallback Next anchor count:",
        fallbackCount
      );

      if (!fallbackCount) {
        throw new Error(
          "WanderBeds pagination: actual Next button could not be located."
        );
      }

      await fallbackNext.scrollIntoViewIfNeeded().catch(() => {});

      console.log(
        "WanderBeds: clicking fallback Next, page:",
        paginationPage + 1
      );

      try {
        await fallbackNext.click({ timeout: 5000 });
      } catch (clickErr) {
        const msg = String(clickErr && clickErr.message || clickErr);

        if (!/detached from the DOM|element was detached/i.test(msg)) {
          throw clickErr;
        }

        console.log(
          "WanderBeds: fallback Next detached during click; retrying with fresh locator."
        );

        const freshFallbackNext = page.locator(
          '[class*="table_book_hotels_"][class*="_pager"] nav a'
        ).filter({
          hasText: /next/i
        }).first();

        await freshFallbackNext.dispatchEvent("click");
      }
    } else {
      await nextControl.scrollIntoViewIfNeeded().catch(() => {});

      console.log(
        "WanderBeds: clicking actual arrow-right Next, page:",
        paginationPage + 1
      );

      try {
        await nextControl.click({ timeout: 5000 });
      } catch (clickErr) {
        const msg = String(clickErr && clickErr.message || clickErr);

        if (!/detached from the DOM|element was detached/i.test(msg)) {
          throw clickErr;
        }

        console.log(
          "WanderBeds: actual Next detached during click; retrying with fresh locator."
        );

        const freshNextControl = page.locator(
          '[class*="table_book_hotels_"][class*="_pager"] nav ul li:has(i.bi-arrow-right) a, ' +
          '[class*="table_book_hotels_"][class*="_pager"] nav ul li:has(i[class*="arrow-right"]) a'
        ).first();

        await freshNextControl.dispatchEvent("click");
      }
    }

    /*
     * Give the supplier time to update the result cards.
     */
    await page.waitForTimeout(800);

    /*
     * Wait until either:
     *
     * 1. hotel links change, OR
     * 2. the supplier's Showing X to Y of Z range changes.
     *
     * This handles DataTables/jQuery-style DOM replacement.
     */
    try {
      await page.waitForFunction(
        ({ oldSignature, oldRange }) => {
          const links = Array.from(
            document.querySelectorAll(
              'a[href*="/book/"][href*="/hoteldetails/"]'
            )
          );

          const newSignature = links
            .map(el => el.href || '')
            .join('|');

          const body = document.body
            ? document.body.innerText || ''
            : '';

          const rangeMatch = body.match(
            /Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+[\d,]+\s+entries/i
          );

          const newRange = rangeMatch
            ? rangeMatch[0]
            : '';

          return (
            (
              links.length > 0 &&
              newSignature !== oldSignature
            ) ||
            (
              newRange &&
              newRange !== oldRange
            )
          );
        },
        {
          oldSignature,
          oldRange: (
            oldRange.match(
              /Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+[\d,]+\s+entries/i
            ) || ['']
          )[0]
        },
        {
          timeout: 15000
        }
      );
    } catch (waitErr) {
      console.log(
        "WanderBeds: pagination page-change wait timed out; " +
        "checking current page anyway."
      );
    }

    await page.waitForTimeout(1200);

    /*
     * Confirm what page/range the supplier actually rendered.
     */
    const afterRange = await page.locator("body")
      .innerText()
      .catch(() => "");

    const afterMatch = afterRange.match(
      /Showing\s+[\d,]+\s+to\s+[\d,]+\s+of\s+[\d,]+\s+entries/i
    );

    const afterPaginationRange =
      afterMatch ? afterMatch[0].trim() : "";

    console.log(
      "WanderBeds: pagination after Next:",
      afterPaginationRange || "range not detected"
    );

    /*
     * Only advance when WanderBeds actually changed its
     * rendered pagination range.
     *
     * If the range is unchanged, the supplier did not advance
     * even though the Next control was still present.
     */
    const beforePaginationRange =
      oldRange ? oldRange.trim() : "";

    if (
      beforePaginationRange &&
      afterPaginationRange &&
      beforePaginationRange === afterPaginationRange
    ) {
      console.log(
        "WanderBeds: supplier pagination did NOT advance."
      );

      console.log(
        "WanderBeds: unchanged pagination range:",
        afterPaginationRange
      );

      console.log(
        "WanderBeds: stopping pagination."
      );

      break;
    }

    /*
     * The supplier rendered a different range, so this is
     * a genuine pagination advance.
     */
    paginationPage++;

    console.log(
      "WanderBeds: supplier pagination ADVANCED:",
      JSON.stringify({
        page: paginationPage,
        previousRange: beforePaginationRange,
        currentRange: afterPaginationRange
      }, null, 2)
    );

    /*
     * Safety guard only. This is NOT a supplier page limit.
     */
    if (paginationPage > 1000) {
      throw new Error(
        "WanderBeds pagination safety stop: exceeded 1000 pages."
      );
    }
  }

  console.log(
    "WanderBeds: ALL PAGINATION RESULTS COLLECTED:",
    JSON.stringify({
      pagesRead: paginationPage,
      totalCollected: allLinks.length,
      totalExpected: paginationTotal
    }, null, 2)
  );

  const links = allLinks;
  console.log(
    "WanderBeds: hotel detail links found:",
    links.length
  );

  console.log(
    "WanderBeds: extracted hotel names:",
    JSON.stringify(
      links.slice(0, 20).map((x) => ({
        name: x.name,
        href: x.href
      })),
      null,
      2
    )
  );
  console.log(
    "WanderBeds: hotel detail links found:",
    links.length
  );

  console.log(
    "WanderBeds: extracted hotel names:",
    JSON.stringify(
      links.slice(0, 10).map((x) => ({
        name: x.name,
        href: x.href
      })),
      null,
      2
    )
  );
  console.log(
    "WanderBeds: hotel detail links found:",
    links.length
  );

  const results = [];

  for (const item of links) {
    if (!item.name || !item.href) continue;

    const text = item.text || "";

    const avgMatch = text.match(
      /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|US\$|\$)\s*avg\/night/i
    );

    const totalMatch = text.match(
      /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|US\$|\$)\s*total\s+for\s+([0-9]+)\s+nights/i
    );

    let price = null;
    let totalPrice = null;
    let nights = null;

    if (avgMatch) {
      price = Number(
        avgMatch[1].replace(/,/g, "")
      );
    }

    if (totalMatch) {
      totalPrice = Number(
        totalMatch[1].replace(/,/g, "")
      );

      nights = Number(totalMatch[3]);
    }

    if (
      price == null &&
      totalPrice != null &&
      nights > 0
    ) {
      price = totalPrice / nights;
    }

    if (
      price == null ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue;
    }

    results.push({
      hotel: item.name,
      room: "Hotel rate",
      view: item.href,
      board: "Not specified",
      cancellation: "",
      price,
      currency: "USD",
      total_price: totalPrice,
      nights,
      url: item.href,
      source: "wanderbeds"
    });
  }

  /*
   * Remove duplicate hotel/rate entries.
   */
  const unique = [];
  const seen = new Set();

  for (const result of results) {
    const key =
      `${result.hotel}|${result.price}|${result.url}`;

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(result);
  }

  console.log(
    "WanderBeds: complete priced hotel results:",
    unique.length
  );

  if (unique.length > 0) {
    console.log(
      "WanderBeds: first results:",
      JSON.stringify(unique.slice(0, 10), null, 2)
    );

    return unique;
  }

  throw new Error(
    `WanderBeds returned no complete priced hotel rates. URL: ${page.url()}`
  );
}
async function getWanderBedsPage(source, cfg) {
  const sourceKey = [
    source.login_url || HOME_URL,
    source.site_username || '',
    source.agent_code || source.site_agent_code || cfg.agent_code || ''
  ].join('|');

  if (
    wanderBedsPage &&
    !wanderBedsPage.isClosed() &&
    wanderBedsSourceKey === sourceKey
  ) {
    console.log('WanderBeds: reusing existing browser session');
    return wanderBedsPage;
  }

  /*
   * IMPORTANT:
   * Never close an existing WanderBeds browser session here.
   * Repeated login/browser recreation can trigger supplier security
   * controls and potentially ban the account.
   *
   * Keep the authenticated browser instance alive and reuse it.
   */
  if (wanderBedsBrowser) {
    console.log(
      "WanderBeds: reusing existing browser session; NOT closing it"
    );
  }

  /*
   * WanderBeds session persistence.
   *
   * IMPORTANT:
   * Reuse the authenticated profile between Node restarts.
   * Do not close an existing browser session during normal searches.
   */
  if (!fs.existsSync(WANDERBEDS_SESSION_DIR)) {
    fs.mkdirSync(WANDERBEDS_SESSION_DIR, { recursive: true });
  }

  wanderBedsContext = await chromium.launchPersistentContext(
    WANDERBEDS_SESSION_DIR,
    {
      headless: false,
      slowMo: 100,
      viewport: {
        width: 1440,
        height: 1000
      }
    }
  );

  wanderBedsBrowser = wanderBedsContext.browser();

  wanderBedsPage = await wanderBedsContext.newPage();

  wanderBedsPage.setDefaultTimeout(
    Number(cfg.timeout_ms) || 15000
  );

  wanderBedsSourceKey = sourceKey;

  await wanderBedsPage.goto(
    source.login_url || HOME_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  await wanderBedsPage.waitForTimeout(
    Number(cfg.initial_wait_ms) || 3000
  );

  await blocked(wanderBedsPage);

  return wanderBedsPage;
}

async function ensureWanderBedsLogin(page, source, password, cfg) {
  if (await isWanderBedsLoggedIn(page)) {
    console.log('WanderBeds: existing login session detected');
    return true;
  }

  if (wanderBedsLoginPromise) {
    await wanderBedsLoginPromise;
    return await isWanderBedsLoggedIn(page);
  }

  wanderBedsLoginPromise = (async () => {
    console.log('WanderBeds: starting automatic login');

    await login(
      page,
      source,
      cfg
    );

    const verified = await isWanderBedsLoggedIn(page);

    if (!verified) {
      throw new Error(
        'WanderBeds login was not verified after Sign in'
      );
    }

    console.log('WanderBeds: login completed and verified');
    console.log(
      'WanderBeds: URL after login:',
      page.url()
    );
  })();

  try {
    await wanderBedsLoginPromise;

    const verified =
      await isWanderBedsLoggedIn(page);

    if (!verified) {
      throw new Error(
        'WanderBeds login verification failed'
      );
    }

    return true;
  } finally {
    wanderBedsLoginPromise = null;
  }
}

async function isWanderBedsLoggedIn(page) {
  if (!page || page.isClosed()) return false;

  const passwordVisible =
    await page.locator('input[type="password"]:visible')
      .count()
      .catch(() => 0);

  if (passwordVisible > 0) return false;

  const dashboardControls =
    await page.locator(
      '#sh_destination, #modal_dates_caption, #modal_rooms_caption, #search'
    ).count().catch(() => 0);

  if (dashboardControls > 0) return true;

  return false;
}

async function waitForWanderBedsManualLogin(page, timeoutMs = 180000) {
  console.log('WanderBeds: waiting for manual login / Trusted device...');

  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    if (!page || page.isClosed()) {
      throw new Error('WanderBeds browser was closed during manual login');
    }

    const text = await bodyText(page);

    if (/trusted device|redirecting/i.test(text)) {
      console.log('WanderBeds: Trusted device redirect detected');
    }

    if (await isWanderBedsLoggedIn(page)) {
      console.log('WanderBeds: manual login verified');
      return true;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(
    'WanderBeds manual login timed out. Complete the login and Trusted device step in the WanderBeds browser.'
  );
}

async function openWanderBedsManualLogin(source, cfg = {}) {
  const page = await getWanderBedsPage(source, cfg);

  await acceptWanderBedsCookies(page);

  const loggedIn = await isWanderBedsLoggedIn(page);

  if (loggedIn) {
    console.log('WanderBeds: already manually logged in');
    return {
      ok: true,
      loggedIn: true,
      url: page.url()
    };
  }

  console.log('WanderBeds: manual login browser ready');
  return {
    ok: true,
    loggedIn: false,
    url: page.url()
  };
}

async function completeWanderBedsManualLogin(timeoutMs = 180000) {
  if (!wanderBedsPage || wanderBedsPage.isClosed()) {
    throw new Error('WanderBeds manual-login browser is not open');
  }

  await waitForWanderBedsManualLogin(
    wanderBedsPage,
    timeoutMs
  );

  return {
    ok: true,
    loggedIn: true,
    url: wanderBedsPage.url()
  };
}

async function getWanderBedsRates(hotelDetailsUrl, search = {}) {
  if (
    !/^https?:\/\/(?:www\.)?wanderbeds\.com\/book\/\d+\/hoteldetails\//i.test(
      String(hotelDetailsUrl || "")
    )
  ) {
    throw new Error("Invalid WanderBeds hotel details URL");
  }

  if (!wanderBedsPage || !wanderBedsContext) {
    throw new Error("WanderBeds browser session is not available");
  }

  await blocked(wanderBedsPage);

  const ratePage = await wanderBedsContext.newPage();

  try {
    ratePage.setDefaultTimeout(20000);

    const detailPayloadResult = await wanderBedsPage.evaluate(async (url) => {
      try {
        const response = await fetch(url, {
          credentials: "include"
        });

        const text = await response.text();

        let payload = null;

        try {
          payload = JSON.parse(text);
        } catch (_) {}

        return {
          ok: response.ok,
          status: response.status,
          payload,
          text: text.slice(0, 5000)
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          payload: null,
          text: String(e && e.message || e || "")
        };
      }
    }, String(hotelDetailsUrl));

    console.log("WANDERBEDS DETAIL RESPONSE DEBUG:", JSON.stringify({
      status: detailPayloadResult.status,
      ok: detailPayloadResult.ok,
      hasPayload: !!detailPayloadResult.payload,
      payloadKeys: detailPayloadResult.payload
        ? Object.keys(detailPayloadResult.payload)
        : [],
      payloadHtmlKeys:
        detailPayloadResult.payload &&
        detailPayloadResult.payload.html
          ? Object.keys(detailPayloadResult.payload.html)
          : [],
      responsePreview: String(detailPayloadResult.text || "").slice(0, 2000)
    }, null, 2));

    if (!detailPayloadResult.ok) {
      throw new Error(
        "WanderBeds hotel details request failed: HTTP " +
        detailPayloadResult.status +
        (detailPayloadResult.text
          ? " - " + detailPayloadResult.text.slice(0, 300)
          : "")
      );
    }

    const detailPayload = detailPayloadResult.payload;

    const modalHtml =
      detailPayload &&
      detailPayload.html &&
      detailPayload.html[".modal-content"];

    if (!modalHtml) {
      throw new Error(
        "WanderBeds hotel details HTML was not returned. " +
        "Response preview: " +
        String(detailPayloadResult.text || "").slice(0, 500)
      );
    }

    await ratePage.setContent(
      "<!doctype html><html><body>" +
      modalHtml +
      "</body></html>",
      { waitUntil: "domcontentloaded" }
    );

    const roomsHref = await ratePage.locator("a[href]").evaluateAll(
      (anchors) => {
        for (const a of anchors) {
          const href = String(a.href || "");
          const text = (a.innerText || a.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          if (
            /\/book\/\d+\/rooms\//i.test(href) &&
            /view\s*rates|rates|rooms/i.test(text)
          ) {
            return href;
          }
        }

        for (const a of anchors) {
          const href = String(a.href || "");

          if (/\/book\/\d+\/rooms\//i.test(href)) {
            return href;
          }
        }

        return "";
      }
    );

    if (!roomsHref) {
      throw new Error("WanderBeds View Rates / rooms link was not found");
    }

    const absoluteRoomsHref = new URL(
      roomsHref,
      "https://wanderbeds.com"
    ).href;

    await ratePage.goto(absoluteRoomsHref, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await ratePage.waitForTimeout(1500);
    await blocked(ratePage);

    const rateLinks = await ratePage.locator("a[href]").evaluateAll(
      (anchors) => {
        const found = [];
        const seen = new Set();

        for (const a of anchors) {
          const href = String(a.href || "");
          const text = (a.innerText || a.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          if (
            /\/book\/\d+\/roomrates\//i.test(href) ||
            /more\s*rates/i.test(text)
          ) {
            if (
              href &&
              !seen.has(href) &&
              /wanderbeds\.com/i.test(href)
            ) {
              seen.add(href);
              found.push(href);
            }
          }
        }

        return found;
      }
    );

    const uniqueRateLinks = [...new Set(rateLinks)];

    if (!uniqueRateLinks.length) {
      throw new Error("WanderBeds More Rates links were not found");
    }

const rates = [];

    for (const ratesUrl of uniqueRateLinks) {
      try {
        ratePage.setDefaultTimeout(20000);

        await ratePage.goto(ratesUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000
        });

        await ratePage.waitForTimeout(1000);
        await blocked(ratePage);

        const cardRates = await ratePage.locator(".card").evaluateAll(
          (cards) => cards.map((card) => {
            const clean = (value) =>
              String(value || "").replace(/\s+/g, " ").trim();

            const room =
              clean(
                card.querySelector("h5.card-title")?.innerText ||
                card.querySelector(".card-title")?.innerText ||
                ""
              );

            const cardText = clean(card.innerText || "");

            const mealMatch = cardText.match(
              /Meal\s*:\s*(.*?)(?=\s+Deadline\s*:|\s+[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:USD|US\$|\$))/i
            );

            const cancellationMatch = cardText.match(
              /Non[- ]?refundable|Free Cancellation|Refundable/i
            );

            const deadlineMatch = cardText.match(
              /Deadline\s*:\s*(.*?)(?=\s+[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:USD|US\$|\$))/i
            );

            const avgMatch = cardText.match(
              /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|US\$|\$)\s*avg\/night/i
            );

            const totalMatch = cardText.match(
              /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|US\$|\$)\s*total\s+for\s+([0-9]+)\s+nights?/i
            );

            if (!room || !avgMatch) {
              return null;
            }

            const price = Number(
              avgMatch[1].replace(/,/g, "")
            );

            const totalPrice = totalMatch
              ? Number(totalMatch[1].replace(/,/g, ""))
              : null;

            const nights = totalMatch
              ? Number(totalMatch[3])
              : null;

            if (!Number.isFinite(price) || price <= 0) {
              return null;
            }

            const selectLink = card.querySelector(
              'a.pagelink[href*="/selecthotel/"]'
            );

            return {
              room,
              meal: mealMatch
                ? mealMatch[1].trim()
                : "",
              cancellation: cancellationMatch
                ? cancellationMatch[0].trim()
                : "",
              deadline: deadlineMatch
                ? deadlineMatch[1].trim()
                : "",
              price,
              total_price:
                totalPrice != null &&
                Number.isFinite(totalPrice)
                  ? totalPrice
                  : null,
              nights:
                nights != null &&
                Number.isFinite(nights)
                  ? nights
                  : null,
              url: selectLink
                ? new URL(
                    selectLink.getAttribute("href"),
                    window.location.origin
                  ).href
                : window.location.href
            };
          })
        );

        for (const cardRate of cardRates) {
          if (!cardRate) continue;

          rates.push({
            hotel: String(search.hotel || "").trim(),
            room: cardRate.room,
            meal: cardRate.meal,
            cancellation: cardRate.cancellation,
            deadline: cardRate.deadline,
            price: cardRate.price,
            currency: "USD",
            total_price: cardRate.total_price,
            nights: cardRate.nights,
            url: cardRate.url,
            view: cardRate.url,
            source: "wanderbeds"
          });
        }

        console.log(
          "WanderBeds: extracted room cards:",
          cardRates.filter(Boolean).length,
          "from",
          ratesUrl
        );
      } catch (e) {
        console.log(
          "WanderBeds: rate page extraction failed:",
          String(e && e.message || e || "")
        );
      }
    }

    const uniqueRates = [];
    const seen = new Set();

    for (const rate of rates) {
      const key = [
        rate.room,
        rate.meal,
        rate.cancellation,
        rate.deadline,
        rate.price,
        rate.total_price
      ].join("|");

      if (seen.has(key)) continue;

      seen.add(key);
      uniqueRates.push(rate);
    }

    return {
      ok: true,
      hotel: String(search.hotel || "").trim(),
      roomsUrl: roomsHref,
      rates: uniqueRates
    };
  } finally {
    console.log("WanderBeds: keeping visible rates tab open:", ratePage.url());
  }
}

async function searchWanderBedsSource(source, search) {
  const cfg = source.browser_config || {};

  if (
    !source.login_url ||
    !source.site_username ||
    !source.site_password_enc ||
    !(
      source.agent_code ||
      source.site_agent_code ||
      cfg.agent_code
    )
  ) {
    return {
      configured: false,
      results: [],
      error:
        'WanderBeds requires login URL, agent code, username and encrypted password'
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

  try {
    const page = await getWanderBedsPage(
      source,
      cfg
    );

    await acceptWanderBedsCookies(page);

    await ensureWanderBedsLogin(
      page,
      source,
      password,
      cfg
    );


    console.log("WanderBeds: BEFORE findSearchPage");
    await findSearchPage(page, cfg);
    console.log("WanderBeds: AFTER findSearchPage");

    console.log("WanderBeds: BEFORE fillSearch");

    try {
      await fillSearch(
        page,
        search
      );
      console.log("WanderBeds: AFTER fillSearch");
    } catch (error) {
      console.log(
        "WanderBeds: fillSearch ERROR:",
        error.message
      );
      throw error;
    }

    const results =
      await extractResults(
        page,
        search,
        cfg
      );

    if (!results.length) {
      throw new Error(
        `WanderBeds returned no complete priced hotel rates. URL: ${page.url()}`
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
  }
}

async function healthWanderBedsSource(source) {
  try {
    const cfg = source.browser_config || {};

    if (
      !source.login_url ||
      !source.site_username ||
      !source.site_password_enc ||
      !(source.agent_code || source.site_agent_code || cfg.agent_code)
    ) {
      return {
        configured: false,
        live: false,
        error: "WanderBeds credentials are incomplete"
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

    const page = await getWanderBedsPage(source, cfg);

    await acceptWanderBedsCookies(page);

    await ensureWanderBedsLogin(
      page,
      source,
      password,
      cfg
    );

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
  }
};













async function wanderBedsManualLoginStatus() {
  if (!wanderBedsPage || wanderBedsPage.isClosed()) {
    return {
      ok: true,
      loggedIn: false,
      url: null
    };
  }

  return {
    ok: true,
    loggedIn: await isWanderBedsLoggedIn(wanderBedsPage),
    url: wanderBedsPage.url()
  };
}

module.exports = {
  searchWanderBedsSource,
  healthWanderBedsSource,
  openWanderBedsManualLogin,
  completeWanderBedsManualLogin,
  isWanderBedsLoggedIn,
  wanderBedsManualLoginStatus,
  getWanderBedsRates
};















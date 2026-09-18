const { searchHadafSource, healthHadafSource } = require('./hadaf-browser-v6');
const { searchWanderBedsSource, healthWanderBedsSource } = require('./wanderbeds-browser-v1');
const { searchBrowserSource } = require('./browser');

const CONNECTORS = [
  { id: 'hadaf', name: 'Hadaf Holidays', type: 'browser' },
  { id: 'wanderbeds', name: 'WanderBeds', type: 'browser' },
  { id: 'locanda', name: 'Locanda', type: 'browser' },
  { id: 'rezlive', name: 'RezLive', type: 'browser' }
];

function filterPricedResults(rows) {
  const input = Array.isArray(rows) ? rows : [];

  console.log("CENTRAL PRICE FILTER: input results =", input.length);

  const fields = [
    "price",
    "total_price",
    "totalPrice",
    "amount",
    "rate",
    "net_price",
    "netPrice",
    "selling_price",
    "sellingPrice"
  ];

  const counts = {};
  for (const field of fields) counts[field] = 0;

  let noPrice = 0;

  for (const row of input) {
    if (!row || typeof row !== "object") {
      noPrice++;
      continue;
    }

    let found = false;

    for (const field of fields) {
      const v = row[field];
      if (v === undefined || v === null) continue;

      const value = String(v).trim();

      if (
        !value ||
        /^(n\/?a|na|none|null|undefined|not available|not available price|-|—)$/i.test(value)
      ) {
        continue;
      }

      const cleaned = value
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "")
        .trim();

      const price = Number(cleaned);

      if (Number.isFinite(price) && price > 0) {
        counts[field]++;
        found = true;
      }
    }

    if (!found) noPrice++;
  }

  console.log("========== PRICE FIELD COUNTS ==========");
  console.log(JSON.stringify(counts, null, 2));
  console.log("Rows with NO valid price:", noPrice);
  console.log("========================================");

  const output = input.filter(row => {
    if (!row || typeof row !== "object") return false;

    // Locanda first returns hotel-list rows without prices.
    // Rates are loaded later when the user clicks "View Rates".
    // Keep those hotel rows so they can be displayed in the portal.
    if (
      /locanda/i.test(String(row.supplier || row.source || row.connector || "")) &&
      (
        String(row.hotel || "").trim() ||
        String(row.availability || "").trim()
      )
    ) {
      return true;
    }

    for (const field of fields) {
      const v = row[field];
      if (v === undefined || v === null) continue;

      const value = String(v).trim();

      if (
        !value ||
        /^(n\/?a|na|none|null|undefined|not available|not available price|-|—)$/i.test(value)
      ) {
        continue;
      }

      const cleaned = value
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "")
        .trim();

      const price = Number(cleaned);

      if (Number.isFinite(price) && price > 0) return true;
    }

    return false;
  });

  console.log("CENTRAL PRICE FILTER: priced results =", output.length);

  return output;
}
function configuredConnectors() {
  return CONNECTORS.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    configured: true,
    status: 'database'
  }));
}

function pick(sources, pattern) {
  const candidates = Array.isArray(sources) ? sources : [];

  return candidates.find(x => {
    if (!x || x.enabled === false) return false;

    /*
     * Match both the database name and id.
     * Some installations use connector ids such as
     * "hadaf", "wanderbeds", or "rezlive" while the
     * display name can differ.
     */
    const name = String(x.name || '');
    const id = String(x.id || '');

    if (!pattern.test(name) && !pattern.test(id)) {
      return false;
    }

    /*
     * Browser connectors normally declare browser/playwright.
     * Keep accepting a source when browser_config exists, because
     * older database rows may not have connector_type populated.
     */
    const type = String(x.connector_type || '').toLowerCase();

    return (
      type === 'browser' ||
      type === 'playwright' ||
      !!x.browser_config
    );
  });
}

async function runSource(s, search) {
  const name = String(s.name || '');
  const id = String(s.id || '');

  console.log("");
  console.log("========================================================");
  console.log("CONNECTOR START:", name, "ID:", id);
  console.log("========================================================");

  try {
    let result;

    if (/hadaf/i.test(name) || /hadaf/i.test(id)) {
      console.log("CONNECTOR TYPE: Hadaf");
      result = await searchHadafSource(s, search);
    } else if (/wanderbeds/i.test(name) || /wanderbeds/i.test(id)) {
      console.log("CONNECTOR TYPE: WanderBeds");
      result = await searchWanderBedsSource(s, search);
    } else {
      console.log("CONNECTOR TYPE: Browser/RezLive/Locanda");
      result = await searchBrowserSource(s, search);
    }

    const rows = Array.isArray(result?.results)
      ? result.results
      : [];

    console.log("CONNECTOR FINISHED:", name);
    console.log("CONNECTOR CONFIGURED:", result?.configured);
    console.log("CONNECTOR ERROR:", result?.error || null);
    console.log("CONNECTOR RESULT COUNT:", rows.length);

    if (rows.length > 0) {
      console.log(
        "CONNECTOR FIRST RESULT:",
        JSON.stringify(rows[0], null, 2)
      );
    }

    console.log("========================================================");
    console.log("");

    return result || { results: [] };

  } catch (error) {
    console.error("");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("CONNECTOR FAILED:", name, "ID:", id);
    console.error("ERROR:", error?.message || error);
    console.error("STACK:", error?.stack || "");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("");

    return {
      results: [],
      configured: true,
      error: error?.message || String(error)
    };
  }
}

async function searchAll(search, sources = []) {
  /* ACTIVE SEARCH: Hadaf + WanderBeds + RezLive + Locanda */
  const selected = [
    pick(sources, /hadaf/i),
    pick(sources, /wanderbeds/i),
    pick(sources, /rezlive/i),
    pick(sources, /locanda/i)
  ].filter(Boolean);

  console.log("");
  console.log("========================================================");
  console.log("ACTIVE HOTEL SEARCH SUPPLIERS");
  console.log("========================================================");
  console.log(selected.map(s => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    connector_type: s.connector_type
  })));
  console.log("========================================================");

  const responses = await Promise.all(
    selected.map(async s => {
      const r = await runSource(s, search);
      return {
        results: r.results || [],
        status: {
          id: String(s.id),
          name: s.name,
          configured: r.configured,
          ok: !r.error,
          error: r.error || null,
          status: r.configured ? (r.error ? 'offline' : 'live') : 'offline'
        }
      };
    })
  );

  const activeIds = new Set(selected.map(s => String(s.id)));

  const statuses = CONNECTORS
    .map(c => responses.find(r => r.status.id === c.id)?.status)
    .filter(Boolean)
    .filter(s => activeIds.has(s.id));

  return {
    results: filterPricedResults(responses.flatMap(r => r.results)),
    statuses
  };
}

async function healthSources(sources = []) {
  const selected = [
    pick(sources, /hadaf/i),
    pick(sources, /wanderbeds/i),
    pick(sources, /rezlive/i)
  ].filter(Boolean);

  return Promise.all(
    selected.map(async s => {
      const name = String(s.name || '');

      if (/locanda/i.test(name) &&
          !(s.agent_code && s.site_username && s.site_password_enc)) {
        return {
          id: String(s.id),
          name: s.name,
          configured: false,
          ok: false,
          status: 'offline',
          error: 'Locanda requires agent code, email and encrypted password',
          checkedAt: new Date().toISOString()
        };
      }

      const r = await (
        /hadaf/i.test(name)
          ? healthHadafSource(s)
          : /wanderbeds/i.test(name)
            ? healthWanderBedsSource(s)
            : /rezlive/i.test(name)
              ? {
                  configured: !!(
                    s.login_url &&
                    s.site_username &&
                    s.site_password_enc
                  ),
                  error: null
                }
              : searchBrowserSource(s, {
                  destination: 'Madinah - Saudi Arabia',
                  checkin: '2026-10-02',
                  checkout: '2026-10-03',
                  guests: 2,
                  rooms: 1,
                  board: 'ROOM_ONLY'
                })
      );

      return {
        id: String(s.id),
        name: s.name,
        configured: r.configured,
        ok: !r.error,
        status: r.error ? 'offline' : 'live',
        error: r.error || null,
        checkedAt: new Date().toISOString()
      };
    })
  );
}

module.exports = {
  CONNECTORS,
  configuredConnectors,
  searchAll,
  healthSources
};



















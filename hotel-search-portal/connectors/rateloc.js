/**
 * RateLoc connector helpers.
 *
 * RateLoc is already registered in connectors/index.js as an API connector.
 * This module keeps RateLoc-specific request/auth handling isolated so the
 * provider can be wired to the exact API contract once RateLoc supplies the
 * endpoint/auth specification for this agent account.
 *
 * No portal password is stored here. API credentials must be supplied through
 * environment variables at runtime.
 */

function buildRateLocHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  const apiKey = process.env.RATELOC_API_KEY || '';
  const bearer = process.env.RATELOC_BEARER_TOKEN || '';
  const username = process.env.RATELOC_API_USERNAME || '';

  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (apiKey) headers['x-api-key'] = apiKey;
  if (username) headers['x-api-username'] = username;

  return headers;
}

function buildRateLocSearchPayload(search) {
  return {
    destination: search.destination,
    checkIn: search.checkin,
    checkOut: search.checkout,
    guests: Number(search.guests || 1),
    adults: Number(search.adults || search.guests || 1),
    children: Number(search.children || 0),
    rooms: Number(search.rooms || 1),
    board: search.board || undefined
  };
}

async function searchRateLoc(search) {
  const url = process.env.RATELOC_API_URL;
  if (!url) {
    return {
      configured: false,
      results: [],
      error: null,
      status: 'awaiting_api'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildRateLocHeaders(),
      body: JSON.stringify(buildRateLocSearchPayload(search)),
      signal: controller.signal
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`RateLoc returned invalid JSON (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`RateLoc returned HTTP ${response.status}`);
    }

    return { configured: true, results: data, error: null, status: 'live' };
  } catch (error) {
    return {
      configured: true,
      results: [],
      error: error?.name === 'AbortError' ? 'RateLoc timed out' : error.message,
      status: 'error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildRateLocHeaders,
  buildRateLocSearchPayload,
  searchRateLoc
};

const CONNECTORS = [
  { id: 'wanderbeds', name: 'WanderBeds', env: 'WANDERBEDS_API_URL' },
  { id: 'mawasim', name: 'Mawasim', env: 'MAWASIM_API_URL' },
  { id: 'arabian-oryx', name: 'Arabian Oryx', env: 'ARABIAN_ORYX_API_URL' },
  { id: 'gatetours', name: 'GateTours', env: 'GATETOURS_API_URL' },
  { id: 'rezlive', name: 'RezLive', env: 'REZLIVE_API_URL' },
  { id: 'webbeds', name: 'WebBeds', env: 'WEBBEDS_API_URL' },
  { id: 'ratehawk', name: 'RateHawk', env: 'RATEHAWK_API_URL' }
];

function configuredConnectors() {
  return CONNECTORS.map(c => ({
    id: c.id,
    name: c.name,
    configured: Boolean(process.env[c.env])
  }));
}

function normalize(raw, connector, search) {
  const items = Array.isArray(raw) ? raw : (raw?.hotels || raw?.results || raw?.data || []);
  if (!Array.isArray(items)) return [];
  return items.map((h, i) => ({
    id: String(h.id ?? h.hotelId ?? h.code ?? `${connector.id}-${i}`),
    supplier: connector.name,
    hotel: h.hotel ?? h.hotelName ?? h.name ?? 'Hotel',
    room: h.room ?? h.roomName ?? h.roomType ?? h.room_type ?? '',
    board: h.board ?? h.boardName ?? h.boardType ?? search.board,
    price: Number(h.price ?? h.totalPrice ?? h.amount ?? NaN),
    currency: h.currency ?? h.currencyCode ?? '',
    cancellation: h.cancellation ?? h.cancellationPolicy ?? h.cancelPolicy ?? '',
    image: h.image ?? h.imageUrl ?? h.photo ?? '',
    raw: h
  }));
}

async function callGeneric(connector, search) {
  const url = process.env[connector.env];
  if (!url) return { configured: false, results: [], error: null };
  const key = process.env[`${connector.id.toUpperCase().replace(/-/g, '_')}_API_KEY`] || '';
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify(search)
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON response (${response.status})`); }
    if (!response.ok) throw new Error(`Supplier returned HTTP ${response.status}`);
    return { configured: true, results: normalize(data, connector, search), error: null };
  } catch (e) {
    return { configured: true, results: [], error: e.name === 'AbortError' ? 'Supplier timed out' : e.message };
  } finally { clearTimeout(timer); }
}

async function searchAll(search) {
  const settled = await Promise.all(CONNECTORS.map(c => callGeneric(c, search)));
  const results = [];
  const statuses = [];
  settled.forEach((r, i) => {
    const c = CONNECTORS[i];
    statuses.push({ id: c.id, name: c.name, configured: r.configured, ok: !r.error, error: r.error });
    results.push(...r.results);
  });
  return { results, statuses };
}

module.exports = { CONNECTORS, configuredConnectors, searchAll };

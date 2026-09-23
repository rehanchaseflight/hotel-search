const { Client } = require('pg');

let client;
let connecting;

function getEnv() {
  return globalThis.__WORKER_ENV || process.env;
}

function getClient() {
  const env = getEnv();
  const url = env.DATABASE_URL;

  if (!url || !url.trim()) {
    throw new Error('DATABASE_URL is not available.');
  }

  if (!/^postgres(ql)?:\/\//i.test(url.trim())) {
    throw new Error('DATABASE_URL is invalid.');
  }

  if (!client) {
    client = new Client({
      connectionString: url.trim(),
      ssl: { rejectUnauthorized: false }
    });
  }

  return client;
}

async function connect() {
  const c = getClient();

  if (c._connected) return c;

  if (!connecting) {
    connecting = c.connect()
      .then(() => {
        c._connected = true;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }

  return connecting;
}

async function query(text, params = []) {
  const c = await connect();
  const result = await c.query(text, params);
  return { rows: result.rows };
}

async function init() {
  await query(`CREATE TABLE IF NOT EXISTS staff (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'STAFF'
      CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','STAFF')),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    login_url TEXT NOT NULL,
    deep_link_template TEXT,
    public_search_template TEXT,
    site_username TEXT,
    site_password_enc TEXT,
    agent_code TEXT,
    connector_type TEXT NOT NULL DEFAULT 'api',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    browser_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  for (const sqlText of [
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS login_url TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS deep_link_template TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS public_search_template TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS site_username TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS site_password_enc TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS agent_code TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS connector_type TEXT NOT NULL DEFAULT 'api'`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS browser_config JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_error TEXT`,
    `ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ`
  ]) {
    await query(sqlText);
  }

  await query(`CREATE TABLE IF NOT EXISTS searches (
    id SERIAL PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    checkin DATE NOT NULL,
    checkout DATE NOT NULL,
    guests INTEGER NOT NULL,
    rooms INTEGER NOT NULL DEFAULT 1,
    board TEXT NOT NULL DEFAULT 'ROOM_ONLY',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`ALTER TABLE searches ADD COLUMN IF NOT EXISTS rooms INTEGER NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE searches ADD COLUMN IF NOT EXISTS board TEXT NOT NULL DEFAULT 'ROOM_ONLY'`);

  await query(`CREATE TABLE IF NOT EXISTS comparisons (
    id SERIAL PRIMARY KEY,
    search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    price NUMERIC(12,2) NOT NULL,
    room_type TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_name_lower
    ON sources(LOWER(TRIM(name)))`);

  await query(`CREATE INDEX IF NOT EXISTS idx_searches_staff_created
    ON searches(staff_id, created_at DESC)`);

  await query(`CREATE INDEX IF NOT EXISTS idx_comparisons_search_price
    ON comparisons(search_id, price)`);
}

module.exports = { query, init };

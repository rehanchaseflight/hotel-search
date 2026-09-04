const { Pool } = require('pg');

let pool;

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url || !url.trim()) throw new Error('DATABASE_URL is not available to the Netlify Function. Set DATABASE_URL in Netlify with the Functions scope and redeploy.');
  if (!/^postgres(ql)?:\/\//i.test(url.trim())) throw new Error('DATABASE_URL is invalid. It must start with postgresql:// or postgres://');
  if (!pool) pool = new Pool({connectionString:url.trim(),ssl:{rejectUnauthorized:false},max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
  return pool;
}
async function query(text,params=[]) { return getPool().query(text,params); }
async function init() {
  await query(`CREATE TABLE IF NOT EXISTS staff (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STAFF' CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','STAFF')), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, name TEXT NOT NULL, login_url TEXT NOT NULL, deep_link_template TEXT, site_username TEXT, site_password_enc TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS searches (id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE, destination TEXT NOT NULL, checkin DATE NOT NULL, checkout DATE NOT NULL, guests INTEGER NOT NULL, rooms INTEGER NOT NULL DEFAULT 1, board TEXT NOT NULL DEFAULT 'ROOM_ONLY', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`ALTER TABLE searches ADD COLUMN IF NOT EXISTS rooms INTEGER NOT NULL DEFAULT 1`);
  await query(`ALTER TABLE searches ADD COLUMN IF NOT EXISTS board TEXT NOT NULL DEFAULT 'ROOM_ONLY'`);
  await query(`CREATE TABLE IF NOT EXISTS comparisons (id SERIAL PRIMARY KEY, search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, price NUMERIC(12,2) NOT NULL, room_type TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await query(`CREATE INDEX IF NOT EXISTS idx_searches_staff_created ON searches(staff_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_comparisons_search_price ON comparisons(search_id, price)`);
}
module.exports={query,init,get pool(){return pool;}};

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 5 });
async function query(text, params=[]) { return pool.query(text, params); }
async function init(){
 await query(`CREATE TABLE IF NOT EXISTS staff (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STAFF' CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','STAFF')), created_at TIMESTAMPTZ DEFAULT NOW())`);
 await query(`CREATE TABLE IF NOT EXISTS sources (id SERIAL PRIMARY KEY, name TEXT NOT NULL, login_url TEXT NOT NULL, deep_link_template TEXT, site_username TEXT, site_password_enc TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
 await query(`CREATE TABLE IF NOT EXISTS searches (id SERIAL PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE, destination TEXT NOT NULL, checkin DATE NOT NULL, checkout DATE NOT NULL, guests INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
 await query(`CREATE TABLE IF NOT EXISTS comparisons (id SERIAL PRIMARY KEY, search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, price NUMERIC(12,2) NOT NULL, room_type TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
 await query(`CREATE INDEX IF NOT EXISTS idx_searches_staff_created ON searches(staff_id, created_at DESC)`);
 await query(`CREATE INDEX IF NOT EXISTS idx_comparisons_search_price ON comparisons(search_id, price)`);
}
module.exports={query,init,pool};

require('dotenv').config();
const db = require('./db');

db.query(`
  SELECT id, name, login_url, site_username, agent_code,
         connector_type, enabled,
         CASE
           WHEN site_password_enc IS NULL OR site_password_enc = ''
           THEN false
           ELSE true
         END AS has_password
  FROM sources
  WHERE LOWER(name) = 'wanderbeds'
`)
.then(r => console.table(r.rows))
.catch(console.error)
.finally(() => db.pool.end());

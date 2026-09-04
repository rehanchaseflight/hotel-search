# Hotel Search Portal

Production-ready pilot version of the hotel search portal for office staff.

## Stack
- Node.js + Express
- PostgreSQL
- JWT authentication + TOTP 2FA
- AES-256-GCM encrypted supplier credentials
- Role-based access control
- Render + Neon friendly deployment

## Important
This application is suitable for an internal pilot. The current search flow is a supplier-link/aggregation shell; actual live hotel inventory requires supplier API credentials and connector implementations.

Never commit `.env`, database credentials, JWT secrets, encryption keys, or supplier passwords.

## Local setup
1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL`, `JWT_SECRET`, and `CRED_ENCRYPTION_KEY`.
3. Run `npm install`.
4. Run `npm start`.
5. Create the first staff/admin user with `node create-staff.js`.

## Render
The included `render.yaml` uses `npm install` (not `npm ci`) because this repository intentionally does not commit a lockfile in the pilot package. Configure the environment variables in Render.

## Health check
`GET /health` returns a simple service/database health response.

# Remick's Garage

Booking + maintenance tracker. Node 22+, Postgres.

## Run locally
Double-click `start.bat` (or `npm install && node server.js`). With no `DATABASE_URL` set it uses an embedded
Postgres stored in `data/` — no setup. The admin password is printed at startup (saved in `data/admin-password.txt`).
- Customers book at http://localhost:3000/
- Dashboard: http://localhost:3000/admin

## Deploy on Vercel
1. Vercel -> Add New -> Project -> import this GitHub repo (framework preset: Other).
2. Project -> Storage -> add **Neon (Postgres)** — this sets `DATABASE_URL` automatically.
3. Project -> Settings -> Environment Variables, add:
   - `ADMIN_PASSWORD` — Remick's dashboard password (required)
   - `ANTHROPIC_API_KEY` — enables AI parts suggestions (oil spec, filter part numbers, etc.). Optional; without it the app works but shows no parts list. Get one at console.anthropic.com
   - `SHOP_TIMEZONE` — e.g. `America/Chicago` (defaults to `America/New_York`; Vercel runs in UTC)
4. Redeploy. Tables are created automatically on first request.

## Parts suggestions
When a booking comes in, the server asks Claude for the parts needed (oil type/capacity, filter part numbers, wiper sizes, etc.)
for that year/make/model/engine and saves it on the booking. They appear on each appointment and roll up into the dashboard's
shopping list. They are AI suggestions and can be wrong — always labeled "verify before buying" with a confidence level.
Model defaults to `claude-opus-5-5` (override with `PARTS_MODEL`); each booking costs roughly a few cents.

## Notes
- Dashboard: Schedule (new-booking alerts, supplies list, mark Done -> car history), Cars & History
  (search by plate / name / phone), Settings (hours, bays, days off, optional ntfy.sh phone push).
- Local data (`data/`) is git-ignored. Production data lives in Neon — use its dashboard for backups.

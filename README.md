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
   - `SHOP_TIMEZONE` — e.g. `America/Chicago` (defaults to `America/New_York`; Vercel runs in UTC)
4. Redeploy. Tables are created automatically on first request.

## Notes
- Dashboard: Schedule (new-booking alerts, supplies list, mark Done -> car history), Cars & History
  (search by plate / name / phone), Settings (hours, bays, days off, optional ntfy.sh phone push).
- Local data (`data/`) is git-ignored. Production data lives in Neon — use its dashboard for backups.

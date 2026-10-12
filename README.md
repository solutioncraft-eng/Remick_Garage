# Remick's Garage

Booking + maintenance tracker. No dependencies — needs Node 22+.

**Run:** double-click `start.bat` (or `node server.js`), then open:
- Customers book at http://localhost:3000/
- Remick's dashboard: http://localhost:3000/admin (password is printed at startup and saved in `data/admin-password.txt`; or set `ADMIN_PASSWORD`)

**Data:** everything lives in `data/garage.db` (SQLite). Back up that file.

**Dashboard:** Schedule (new-booking alerts, supplies shopping list, mark Done -> saves to car history),
Cars & History (search by plate / name / phone), Settings (hours, bays, days off, phone push via ntfy.sh).

**Putting it online** so customers can reach it: run it on any always-on PC or host (Render, Railway, Fly, a VPS)
with HTTPS in front. Set `ADMIN_PASSWORD` and `PORT` env vars. Don't expose it without HTTPS.

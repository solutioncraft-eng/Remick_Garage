// Remick's Garage — booking + maintenance tracker. Zero dependencies (Node 22+).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SERVICES = ['Oil change', 'Tire rotation', 'Brake inspection', 'Air filter', 'Cabin filter',
  'Battery check', 'Wiper blades', 'Fluid top-off', 'Other (describe below)'];

// ---------- admin password ----------
const pwFile = path.join(DATA_DIR, 'admin-password.txt');
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, crypto.randomBytes(6).toString('hex'));
  ADMIN_PASSWORD = fs.readFileSync(pwFile, 'utf8').trim();
}
const sessions = new Set();

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'garage.db'));
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, phone_norm TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  plate TEXT, plate_norm TEXT, year TEXT, make TEXT NOT NULL, model TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  slot TEXT NOT NULL, services TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'booked', seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS service_records (
  id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  booking_id INTEGER, date TEXT NOT NULL, service TEXT NOT NULL,
  mileage INTEGER, parts TEXT, cost REAL, notes TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate_norm);
`);

const DEFAULTS = {
  // 0=Sun..6=Sat ; null = closed
  hours: { 0: null, 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'],
           4: ['09:00', '17:00'], 5: ['09:00', '17:00'], 6: ['09:00', '13:00'] },
  slotMinutes: 60, bays: 1, closedDates: [], ntfyTopic: '', daysAhead: 30,
  shopName: "Remick's Garage",
};
function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
  return out;
}
function saveSettings(patch) {
  const allowed = Object.keys(DEFAULTS);
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of allowed) if (k in patch) up.run(k, JSON.stringify(patch[k]));
}

// ---------- helpers ----------
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const normPlate = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normPhone = s => (s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const clean = (s, max = 300) => String(s ?? '').trim().slice(0, max);

function slotsForDate(dateStr, settings = getSettings()) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return [];
  if (settings.closedDates.includes(dateStr)) return [];
  const hrs = settings.hours[d.getDay()];
  if (!hrs) return [];
  const taken = {};
  for (const r of db.prepare("SELECT slot, COUNT(*) c FROM bookings WHERE slot LIKE ? AND status != 'cancelled' GROUP BY slot").all(dateStr + ' %'))
    taken[r.slot.slice(11)] = r.c;
  const now = new Date();
  const out = [];
  for (let m = toMin(hrs[0]); m + settings.slotMinutes <= toMin(hrs[1]); m += settings.slotMinutes) {
    const t = fromMin(m);
    const when = new Date(`${dateStr}T${t}:00`);
    out.push({ time: t, available: when > now && (taken[t] || 0) < settings.bays });
  }
  return out;
}

async function notify(settings, booking, customer, vehicle) {
  if (!settings.ntfyTopic) return;
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(settings.ntfyTopic), {
      method: 'POST',
      headers: { Title: 'New booking: ' + `${vehicle.year || ''} ${vehicle.make} ${vehicle.model}`.trim(), Tags: 'wrench' },
      body: `${booking.slot} — ${customer.name}\n${booking.services || ''}\n${booking.description || ''}`.trim(),
    });
  } catch (e) { console.error('ntfy failed:', e.message); }
}

// ---------- request plumbing ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 100_000) { reject(new HttpError(413, 'Too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new HttpError(400, 'Bad JSON')); } });
});
const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const getCookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === name)?.[1];
const isAdmin = req => sessions.has(getCookie(req, 'sid'));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/book.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------
function bookingRows(where = '', params = []) {
  return db.prepare(`
    SELECT b.*, c.name customer_name, c.phone, c.email, v.year, v.make, v.model, v.plate
    FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN vehicles v ON v.id=b.vehicle_id
    ${where} ORDER BY b.slot`).all(...params);
}

function findOrCreateCustomer({ name, phone, email }) {
  const pn = normPhone(phone);
  let c = pn ? db.prepare('SELECT * FROM customers WHERE phone_norm=?').get(pn) : null;
  if (!c && email) c = db.prepare('SELECT * FROM customers WHERE lower(email)=lower(?)').get(email);
  if (c) {
    db.prepare('UPDATE customers SET name=?, phone=COALESCE(NULLIF(?,\'\'),phone), phone_norm=COALESCE(NULLIF(?,\'\'),phone_norm), email=COALESCE(NULLIF(?,\'\'),email) WHERE id=?')
      .run(name, phone, pn, email, c.id);
    return c.id;
  }
  return Number(db.prepare('INSERT INTO customers(name,phone,phone_norm,email) VALUES(?,?,?,?)').run(name, phone, pn, email).lastInsertRowid);
}

function findOrCreateVehicle(customerId, { plate, year, make, model }) {
  const pn = normPlate(plate);
  let v = pn ? db.prepare('SELECT * FROM vehicles WHERE plate_norm=?').get(pn) : null;
  if (!v) v = db.prepare('SELECT * FROM vehicles WHERE customer_id=? AND lower(make)=lower(?) AND lower(model)=lower(?) AND COALESCE(year,\'\')=?')
    .get(customerId, make, model, year || '');
  if (v) return v.id;
  return Number(db.prepare('INSERT INTO vehicles(customer_id,plate,plate_norm,year,make,model) VALUES(?,?,?,?,?,?)')
    .run(customerId, plate.toUpperCase(), pn, year, make, model).lastInsertRowid);
}

async function handleApi(req, res, url) {
  const p = url.pathname, m = req.method;
  const id = Number(p.split('/')[4] ?? p.split('/')[3]);

  // ----- public -----
  if (p === '/api/config' && m === 'GET') {
    const s = getSettings();
    return send(res, 200, { shopName: s.shopName, services: SERVICES, daysAhead: s.daysAhead });
  }
  if (p === '/api/slots' && m === 'GET') {
    const date = url.searchParams.get('date') || '';
    return send(res, 200, { date, slots: slotsForDate(date) });
  }
  if (p === '/api/availability' && m === 'GET') { // which upcoming days have any open slot
    const s = getSettings(); const days = [];
    const d = new Date(); d.setHours(0, 0, 0, 0);
    for (let i = 0; i < s.daysAhead; i++, d.setDate(d.getDate() + 1)) {
      const ds = fmtDate(d);
      days.push({ date: ds, open: slotsForDate(ds, s).some(x => x.available) });
    }
    return send(res, 200, { days });
  }
  if (p === '/api/book' && m === 'POST') {
    const b = await readBody(req);
    if (b.website) return send(res, 200, { ok: true }); // honeypot
    const name = clean(b.name, 100), phone = clean(b.phone, 30), email = clean(b.email, 120);
    const make = clean(b.make, 50), model = clean(b.model, 50), year = clean(b.year, 4), plate = clean(b.plate, 15);
    const services = (Array.isArray(b.services) ? b.services : []).filter(x => SERVICES.includes(x)).join(', ');
    const description = clean(b.description, 1000);
    const date = clean(b.date, 10), time = clean(b.time, 5);
    if (!name || !make || !model || !(phone || email)) throw new HttpError(400, 'Please fill in your name, phone or email, and your car\'s make and model.');
    if (!services && !description) throw new HttpError(400, 'Please pick a service or describe what you need.');
    const settings = getSettings();
    let booking;
    db.exec('BEGIN IMMEDIATE');
    try {
      const slot = slotsForDate(date, settings).find(x => x.time === time);
      if (!slot || !slot.available) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another.');
      const cid = findOrCreateCustomer({ name, phone, email });
      const vid = findOrCreateVehicle(cid, { plate, year, make, model });
      const r = db.prepare('INSERT INTO bookings(vehicle_id,customer_id,slot,services,description) VALUES(?,?,?,?,?)')
        .run(vid, cid, `${date} ${time}`, services, description);
      booking = bookingRows('WHERE b.id=?', [Number(r.lastInsertRowid)])[0];
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify(settings, booking, { name }, { year, make, model });
    return send(res, 201, { ok: true, slot: booking.slot });
  }

  // ----- auth -----
  if (p === '/api/admin/login' && m === 'POST') {
    const { password } = await readBody(req);
    const a = Buffer.from(String(password ?? '')), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong password');
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  if (!p.startsWith('/api/admin/')) throw new HttpError(404, 'Not found');
  if (!isAdmin(req)) throw new HttpError(401, 'Login required');

  // ----- admin -----
  if (p === '/api/admin/bookings' && m === 'GET') {
    const from = url.searchParams.get('from') || fmtDate(new Date());
    return send(res, 200, { bookings: bookingRows("WHERE b.slot >= ? AND b.status != 'cancelled'", [from]), unseen: db.prepare("SELECT COUNT(*) c FROM bookings WHERE seen=0 AND status='booked'").get().c });
  }
  if (p === '/api/admin/bookings/seen' && m === 'POST') {
    db.prepare('UPDATE bookings SET seen=1 WHERE seen=0').run();
    return send(res, 200, { ok: true });
  }
  if (/^\/api\/admin\/bookings\/\d+\/cancel$/.test(p) && m === 'POST') {
    db.prepare("UPDATE bookings SET status='cancelled', seen=1 WHERE id=?").run(Number(p.split('/')[4]));
    return send(res, 200, { ok: true });
  }
  if (/^\/api\/admin\/bookings\/\d+\/complete$/.test(p) && m === 'POST') {
    const bid = Number(p.split('/')[4]); const b = await readBody(req);
    const bk = bookingRows('WHERE b.id=?', [bid])[0];
    if (!bk) throw new HttpError(404, 'No such booking');
    db.prepare('INSERT INTO service_records(vehicle_id,booking_id,date,service,mileage,parts,cost,notes) VALUES(?,?,?,?,?,?,?,?)')
      .run(bk.vehicle_id, bid, bk.slot.slice(0, 10), clean(b.service) || bk.services || bk.description || 'Service',
        b.mileage ? Number(b.mileage) : null, clean(b.parts), b.cost !== '' && b.cost != null ? Number(b.cost) : null, clean(b.notes, 1000));
    db.prepare("UPDATE bookings SET status='done', seen=1 WHERE id=?").run(bid);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/vehicles' && m === 'GET') {
    const q = '%' + (url.searchParams.get('q') || '').trim() + '%';
    const qp = '%' + normPlate(url.searchParams.get('q')) + '%';
    const rows = db.prepare(`
      SELECT v.*, c.name customer_name, c.phone,
        (SELECT MAX(date) FROM service_records r WHERE r.vehicle_id=v.id) last_service,
        (SELECT COUNT(*) FROM service_records r WHERE r.vehicle_id=v.id) service_count
      FROM vehicles v JOIN customers c ON c.id=v.customer_id
      WHERE c.name LIKE ? OR v.plate_norm LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR c.phone LIKE ?
      ORDER BY c.name LIMIT 200`).all(q, qp === '%%' ? q : qp, q, q, q);
    return send(res, 200, { vehicles: rows });
  }
  if (p === '/api/admin/vehicles' && m === 'POST') { // walk-in / manual add
    const b = await readBody(req);
    const name = clean(b.name, 100), make = clean(b.make, 50), model = clean(b.model, 50);
    if (!name || !make || !model) throw new HttpError(400, 'Name, make and model are required');
    const cid = findOrCreateCustomer({ name, phone: clean(b.phone, 30), email: clean(b.email, 120) });
    const vid = findOrCreateVehicle(cid, { plate: clean(b.plate, 15), year: clean(b.year, 4), make, model });
    return send(res, 201, { id: vid });
  }
  if (/^\/api\/admin\/vehicles\/\d+$/.test(p) && m === 'GET') {
    const v = db.prepare('SELECT v.*, c.name customer_name, c.phone, c.email FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE v.id=?').get(id);
    if (!v) throw new HttpError(404, 'No such vehicle');
    return send(res, 200, {
      vehicle: v,
      records: db.prepare('SELECT * FROM service_records WHERE vehicle_id=? ORDER BY date DESC, id DESC').all(id),
      upcoming: bookingRows("WHERE b.vehicle_id=? AND b.status='booked'", [id]),
    });
  }
  if (/^\/api\/admin\/vehicles\/\d+$/.test(p) && m === 'PATCH') {
    const b = await readBody(req);
    db.prepare('UPDATE vehicles SET notes=? WHERE id=?').run(clean(b.notes, 2000), id);
    return send(res, 200, { ok: true });
  }
  if (/^\/api\/admin\/vehicles\/\d+\/records$/.test(p) && m === 'POST') {
    const b = await readBody(req);
    if (!clean(b.service)) throw new HttpError(400, 'Service is required');
    db.prepare('INSERT INTO service_records(vehicle_id,date,service,mileage,parts,cost,notes) VALUES(?,?,?,?,?,?,?)')
      .run(id, clean(b.date, 10) || fmtDate(new Date()), clean(b.service), b.mileage ? Number(b.mileage) : null,
        clean(b.parts), b.cost !== '' && b.cost != null ? Number(b.cost) : null, clean(b.notes, 1000));
    return send(res, 201, { ok: true });
  }
  if (/^\/api\/admin\/records\/\d+$/.test(p) && m === 'DELETE') {
    db.prepare('DELETE FROM service_records WHERE id=?').run(id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, getSettings());
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (b.slotMinutes != null) b.slotMinutes = Math.max(15, Math.min(480, Number(b.slotMinutes) || 60));
    if (b.bays != null) b.bays = Math.max(1, Math.min(20, Number(b.bays) || 1));
    if (b.daysAhead != null) b.daysAhead = Math.max(1, Math.min(120, Number(b.daysAhead) || 30));
    if (b.ntfyTopic != null) b.ntfyTopic = clean(b.ntfyTopic, 100).replace(/[^\w-]/g, '');
    saveSettings(b);
    return send(res, 200, getSettings());
  }
  throw new HttpError(404, 'Not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}).listen(PORT, () => {
  console.log(`\nRemick's Garage running`);
  console.log(`  Customers book at:  http://localhost:${PORT}/`);
  console.log(`  Remick's dashboard: http://localhost:${PORT}/admin`);
  console.log(`  Admin password:     ${ADMIN_PASSWORD}\n`);
});

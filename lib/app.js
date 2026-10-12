// Remick's Garage — API handler. Runs under Vercel (api/index.js) or locally (server.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TZ = process.env.SHOP_TIMEZONE || 'America/New_York';

const SERVICES = ['Oil change', 'Tire rotation', 'Brake inspection', 'Air filter', 'Cabin filter',
  'Battery check', 'Wiper blades', 'Fluid top-off', 'Other (describe below)'];

// ---------- admin password + stateless sessions (works on serverless) ----------
export function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.VERCEL) return null;
  const f = path.join(DATA_DIR, 'admin-password.txt');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(6).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
}
const sign = v => crypto.createHmac('sha256', 'session:' + adminPassword()).update(v).digest('hex');
const makeToken = () => { const exp = String(Date.now() + 30 * 86400e3); return `${exp}.${sign(exp)}`; };
function isAdmin(req) {
  const tok = (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === 'sid')?.[1];
  if (!tok || !adminPassword()) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- settings ----------
const DEFAULTS = {
  hours: { 0: null, 1: ['09:00', '17:00'], 2: ['09:00', '17:00'], 3: ['09:00', '17:00'],
           4: ['09:00', '17:00'], 5: ['09:00', '17:00'], 6: ['09:00', '13:00'] }, // 0=Sun; null = closed
  slotMinutes: 60, bays: 1, closedDates: [], ntfyTopic: '', daysAhead: 30, shopName: "Remick's Garage",
};
async function getSettings(db) {
  const out = { ...DEFAULTS };
  for (const r of await db.query('SELECT key, value FROM settings')) out[r.key] = JSON.parse(r.value);
  return out;
}
async function saveSettings(db, patch) {
  for (const k of Object.keys(DEFAULTS)) if (k in patch)
    await db.query('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [k, JSON.stringify(patch[k])]);
}

// ---------- date helpers (all in the shop's time zone, as plain strings) ----------
const pad = n => String(n).padStart(2, '0');
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{2}:\d{2}$/;
const now = () => { const s = new Date().toLocaleString('sv-SE', { timeZone: TZ, hour12: false }); return { date: s.slice(0, 10), stamp: s.slice(0, 16) }; };
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = ds => new Date(ds + 'T00:00:00Z').getUTCDay();

const normPlate = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normPhone = s => (s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const clean = (s, max = 300) => String(s ?? '').trim().slice(0, max);
const numOrNull = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);

async function takenCounts(db, from, to) {
  const rows = await db.query("SELECT slot, COUNT(*)::int c FROM bookings WHERE slot >= ? AND slot < ? AND status != 'cancelled' GROUP BY slot", [from, to]);
  return Object.fromEntries(rows.map(r => [r.slot, r.c]));
}
function slotsForDate(ds, settings, taken) {
  if (!DATE_RE.test(ds) || settings.closedDates.includes(ds)) return [];
  const hrs = settings.hours[dow(ds)];
  if (!hrs) return [];
  const { stamp } = now(), out = [];
  for (let m = toMin(hrs[0]); m + settings.slotMinutes <= toMin(hrs[1]); m += settings.slotMinutes) {
    const t = fromMin(m), key = `${ds} ${t}`;
    out.push({ time: t, available: key > stamp && (taken[key] || 0) < settings.bays });
  }
  return out;
}

async function notify(settings, slot, name, v, what) {
  if (!settings.ntfyTopic) return;
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(settings.ntfyTopic), {
      method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { Title: ('New booking: ' + [v.year, v.make, v.model].filter(Boolean).join(' ')).replace(/[^\x20-\x7E]/g, ''), Tags: 'wrench' },
      body: `${slot} - ${name}\n${what}`.trim(),
    });
  } catch (e) { console.error('ntfy failed:', e.message); }
}

// ---------- http plumbing ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) { // Vercel pre-parses
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(req.body.toString() || '{}'); } catch { throw new HttpError(400, 'Bad JSON'); }
  }
  let b = '';
  for await (const c of req) { b += c; if (b.length > 100_000) throw new HttpError(413, 'Too large'); }
  try { return b ? JSON.parse(b) : {}; } catch { throw new HttpError(400, 'Bad JSON'); }
}
const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};

// ---------- queries ----------
const bookingRows = (q, where = '', params = []) => q(`
  SELECT b.*, c.name customer_name, c.phone, c.email, v.year, v.make, v.model, v.plate
  FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN vehicles v ON v.id=b.vehicle_id
  ${where} ORDER BY b.slot`, params);

async function findOrCreateCustomer(q, { name, phone, email }) {
  const pn = normPhone(phone);
  let c = pn ? (await q('SELECT * FROM customers WHERE phone_norm=?', [pn]))[0] : null;
  if (!c && email) c = (await q('SELECT * FROM customers WHERE lower(email)=lower(?)', [email]))[0];
  if (c) {
    await q("UPDATE customers SET name=?, phone=COALESCE(NULLIF(?,''),phone), phone_norm=COALESCE(NULLIF(?,''),phone_norm), email=COALESCE(NULLIF(?,''),email) WHERE id=?",
      [name, phone, pn, email, c.id]);
    return c.id;
  }
  return (await q('INSERT INTO customers(name,phone,phone_norm,email) VALUES(?,?,?,?) RETURNING id', [name, phone, pn, email]))[0].id;
}
async function findOrCreateVehicle(q, customerId, { plate, year, make, model }) {
  const pn = normPlate(plate);
  let v = pn ? (await q('SELECT * FROM vehicles WHERE plate_norm=?', [pn]))[0] : null;
  if (!v) v = (await q("SELECT * FROM vehicles WHERE customer_id=? AND lower(make)=lower(?) AND lower(model)=lower(?) AND COALESCE(year,'')=?",
    [customerId, make, model, year || '']))[0];
  if (v) return v.id;
  return (await q('INSERT INTO vehicles(customer_id,plate,plate_norm,year,make,model) VALUES(?,?,?,?,?,?) RETURNING id',
    [customerId, plate.toUpperCase(), pn, year, make, model]))[0].id;
}

// ---------- routes ----------
async function route(req, res, url) {
  const p = url.pathname, m = req.method, parts = p.split('/');
  const id = Number(parts[4]);
  const db = await getDb();
  const q = (s, params) => db.query(s, params);

  // public
  if (p === '/api/config' && m === 'GET') {
    const s = await getSettings(db);
    return send(res, 200, { shopName: s.shopName, services: SERVICES, daysAhead: s.daysAhead });
  }
  if (p === '/api/slots' && m === 'GET') {
    const date = url.searchParams.get('date') || '';
    if (!DATE_RE.test(date)) throw new HttpError(400, 'Bad date');
    const s = await getSettings(db);
    return send(res, 200, { date, slots: slotsForDate(date, s, await takenCounts(db, date, addDays(date, 1))) });
  }
  if (p === '/api/availability' && m === 'GET') {
    const s = await getSettings(db), start = now().date;
    const taken = await takenCounts(db, start, addDays(start, s.daysAhead));
    const days = [];
    for (let i = 0; i < s.daysAhead; i++) {
      const ds = addDays(start, i);
      days.push({ date: ds, open: slotsForDate(ds, s, taken).some(x => x.available) });
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
    if (!name || !make || !model || !(phone || email)) throw new HttpError(400, "Please fill in your name, phone or email, and your car's make and model.");
    if (!services && !description) throw new HttpError(400, 'Please pick a service or describe what you need.');
    if (!DATE_RE.test(date) || !TIME_RE.test(time)) throw new HttpError(400, 'Please pick a day and time.');
    const settings = await getSettings(db);
    const slot = await db.tx(async tq => {
      await tq('SELECT pg_advisory_xact_lock(7001)'); // one booking at a time -> no double-booking
      const taken = await takenCounts({ query: tq }, date, addDays(date, 1));
      const open = slotsForDate(date, settings, taken).find(x => x.time === time);
      if (!open || !open.available) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another.');
      const cid = await findOrCreateCustomer(tq, { name, phone, email });
      const vid = await findOrCreateVehicle(tq, cid, { plate, year, make, model });
      await tq('INSERT INTO bookings(vehicle_id,customer_id,slot,services,description) VALUES(?,?,?,?,?)', [vid, cid, `${date} ${time}`, services, description]);
      return `${date} ${time}`;
    });
    await notify(settings, slot, name, { year, make, model }, [services, description].filter(Boolean).join('\n'));
    return send(res, 201, { ok: true, slot });
  }

  // auth
  if (p === '/api/admin/login' && m === 'POST') {
    const pw = adminPassword();
    if (!pw) throw new HttpError(500, 'ADMIN_PASSWORD is not configured on the server');
    const { password } = await readBody(req);
    const a = Buffer.from(String(password ?? '')), b = Buffer.from(pw);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { await new Promise(r => setTimeout(r, 600)); throw new HttpError(401, 'Wrong password'); }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
  }
  if (!p.startsWith('/api/admin/')) throw new HttpError(404, 'Not found');
  if (!isAdmin(req)) throw new HttpError(401, 'Login required');

  // admin
  if (p === '/api/admin/bookings' && m === 'GET') {
    const from = url.searchParams.get('from');
    return send(res, 200, {
      bookings: await bookingRows(q, "WHERE b.slot >= ? AND b.status != 'cancelled'", [DATE_RE.test(from || '') ? from : now().date]),
      unseen: (await q("SELECT COUNT(*)::int c FROM bookings WHERE seen=0 AND status='booked'"))[0].c,
    });
  }
  if (p === '/api/admin/bookings/seen' && m === 'POST') {
    await q('UPDATE bookings SET seen=1 WHERE seen=0');
    return send(res, 200, { ok: true });
  }
  if (/^\/api\/admin\/bookings\/\d+\/cancel$/.test(p) && m === 'POST') {
    await q("UPDATE bookings SET status='cancelled', seen=1 WHERE id=?", [id]);
    return send(res, 200, { ok: true });
  }
  if (/^\/api\/admin\/bookings\/\d+\/complete$/.test(p) && m === 'POST') {
    const b = await readBody(req);
    const bk = (await bookingRows(q, 'WHERE b.id=?', [id]))[0];
    if (!bk) throw new HttpError(404, 'No such booking');
    await q('INSERT INTO service_records(vehicle_id,booking_id,date,service,mileage,parts,cost,notes) VALUES(?,?,?,?,?,?,?,?)',
      [bk.vehicle_id, id, bk.slot.slice(0, 10), clean(b.service) || bk.services || bk.description || 'Service',
        numOrNull(b.mileage), clean(b.parts), numOrNull(b.cost), clean(b.notes, 1000)]);
    await q("UPDATE bookings SET status='done', seen=1 WHERE id=?", [id]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/vehicles' && m === 'GET') {
    const raw = (url.searchParams.get('q') || '').trim(), like = `%${raw}%`, plate = `%${normPlate(raw)}%`;
    const vehicles = await q(`
      SELECT v.*, c.name customer_name, c.phone,
        (SELECT MAX(date) FROM service_records r WHERE r.vehicle_id=v.id) last_service,
        (SELECT COUNT(*)::int FROM service_records r WHERE r.vehicle_id=v.id) service_count
      FROM vehicles v JOIN customers c ON c.id=v.customer_id
      WHERE c.name ILIKE ? OR v.plate_norm LIKE ? OR v.make ILIKE ? OR v.model ILIKE ? OR c.phone ILIKE ?
      ORDER BY c.name LIMIT 200`, [like, raw ? plate : like, like, like, like]);
    return send(res, 200, { vehicles });
  }
  if (p === '/api/admin/vehicles' && m === 'POST') { // walk-in / manual add
    const b = await readBody(req);
    const name = clean(b.name, 100), make = clean(b.make, 50), model = clean(b.model, 50);
    if (!name || !make || !model) throw new HttpError(400, 'Name, make and model are required');
    const vid = await db.tx(async tq => {
      const cid = await findOrCreateCustomer(tq, { name, phone: clean(b.phone, 30), email: clean(b.email, 120) });
      return findOrCreateVehicle(tq, cid, { plate: clean(b.plate, 15), year: clean(b.year, 4), make, model });
    });
    return send(res, 201, { id: vid });
  }
  if (/^\/api\/admin\/vehicles\/\d+$/.test(p) && m === 'GET') {
    const v = (await q('SELECT v.*, c.name customer_name, c.phone, c.email FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE v.id=?', [id]))[0];
    if (!v) throw new HttpError(404, 'No such vehicle');
    return send(res, 200, {
      vehicle: v,
      records: await q('SELECT * FROM service_records WHERE vehicle_id=? ORDER BY date DESC, id DESC', [id]),
      upcoming: await bookingRows(q, "WHERE b.vehicle_id=? AND b.status='booked' AND b.slot >= ?", [id, now().date]),
    });
  }
  if (/^\/api\/admin\/vehicles\/\d+\/records$/.test(p) && m === 'POST') {
    const b = await readBody(req);
    if (!clean(b.service)) throw new HttpError(400, 'Service is required');
    await q('INSERT INTO service_records(vehicle_id,date,service,mileage,parts,cost,notes) VALUES(?,?,?,?,?,?,?)',
      [id, DATE_RE.test(b.date || '') ? b.date : now().date, clean(b.service), numOrNull(b.mileage), clean(b.parts), numOrNull(b.cost), clean(b.notes, 1000)]);
    return send(res, 201, { ok: true });
  }
  if (/^\/api\/admin\/records\/\d+$/.test(p) && m === 'DELETE') {
    await q('DELETE FROM service_records WHERE id=?', [id]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/settings' && m === 'GET') return send(res, 200, await getSettings(db));
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (b.slotMinutes != null) b.slotMinutes = Math.max(15, Math.min(480, Number(b.slotMinutes) || 60));
    if (b.bays != null) b.bays = Math.max(1, Math.min(20, Number(b.bays) || 1));
    if (b.daysAhead != null) b.daysAhead = Math.max(1, Math.min(120, Number(b.daysAhead) || 30));
    if (b.ntfyTopic != null) b.ntfyTopic = clean(b.ntfyTopic, 100).replace(/[^\w-]/g, '');
    await saveSettings(db, b);
    return send(res, 200, await getSettings(db));
  }
  throw new HttpError(404, 'Not found');
}

export async function handle(req, res) {
  try {
    await route(req, res, new URL(req.url, 'http://x'));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}

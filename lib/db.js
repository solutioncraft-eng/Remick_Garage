// Postgres access. Production/Vercel: DATABASE_URL (Neon). Local dev with no DATABASE_URL: embedded PGlite in ./data.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, phone_norm TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  plate TEXT, plate_norm TEXT, year TEXT, make TEXT NOT NULL, model TEXT NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  slot TEXT NOT NULL, services TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'booked', seen INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS service_records (
  id SERIAL PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  booking_id INTEGER, date TEXT NOT NULL, service TEXT NOT NULL,
  mileage INTEGER, parts TEXT, cost DOUBLE PRECISION, notes TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS engine TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_json TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_status TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_error TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS parts_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate_norm);
`;

// SQL is written with ? placeholders; convert to $1, $2...
const num = s => { let i = 0; return s.replace(/\?/g, () => '$' + ++i); };

let ready;
export function getDb() {
  ready ??= (async () => {
    let raw;
    if (process.env.DATABASE_URL) {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
      raw = {
        exec: s => pool.query(s),
        query: async (s, p) => (await pool.query(s, p)).rows,
        tx: async fn => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const out = await fn(async (s, p) => (await c.query(s, p)).rows);
            await c.query('COMMIT');
            return out;
          } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
          finally { c.release(); }
        },
      };
    } else {
      if (process.env.VERCEL) throw new Error('DATABASE_URL is not set');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const mod = '@electric-sql/pglite'; // computed so Vercel doesn't bundle it
      const { PGlite } = await import(mod);
      const pl = new PGlite(path.join(DATA_DIR, 'pglite'));
      raw = {
        exec: s => pl.exec(s),
        query: async (s, p) => (await pl.query(s, p)).rows,
        tx: fn => pl.transaction(tx => fn(async (s, p) => (await tx.query(s, p)).rows)),
      };
    }
    await raw.exec(SCHEMA);
    return {
      query: (s, p = []) => raw.query(num(s), p),
      tx: fn => raw.tx(run => fn((s, p = []) => run(num(s), p))),
    };
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// Local dev server. (On Vercel, api/index.js + static files in /public are used instead.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, adminPassword } from './lib/app.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  let { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/')) return handle(req, res);
  if (pathname === '/') pathname = '/book.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`\nRemick's Garage running (${process.env.DATABASE_URL ? 'Postgres' : 'local embedded database'})`);
  console.log(`  Customers book at:  http://localhost:${PORT}/`);
  console.log(`  Remick's dashboard: http://localhost:${PORT}/admin`);
  console.log(`  Admin password:     ${adminPassword()}\n`);
});

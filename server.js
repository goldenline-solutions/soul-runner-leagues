// Local server: the API plus the static site. On Vercel, api/index.js and vercel.json do this job.
//   With DATABASE_URL set: uses that PostgreSQL database.
//   Without it: uses an embedded Postgres in ./data/pglite (no install needed).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { root, loadEnv } from './src/env.js';
import { connectPostgres, setup } from './src/db.js';
import { createApp, SECURITY_HEADERS } from './src/app.js';

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const db = process.env.DATABASE_URL
  ? connectPostgres(process.env.DATABASE_URL)
  : await (await import('./src/db-local.js')).connectLocal(resolve(root, process.env.LOCAL_DB_DIR || 'data/pglite'));
if (process.env.DATABASE_URL) await setup(db);
const app = createApp({ db, env: process.env });
const publicDir = join(root, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname.startsWith('/api/')) return app.handle(req, res);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error');
  }
});

async function serveStatic(res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(publicDir, rel || 'index.html');
  if (!file.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) file = join(publicDir, 'index.html'); // single-page app fallback
  const data = await readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Cache-Control': extname(file) === '.png' ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(data);
}

function send(res, status, textBody) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(textBody);
}

server.listen(PORT, () => {
  console.log(`Soul Runner leagues running at http://localhost:${PORT}`);
  console.log(process.env.DATABASE_URL ? 'Database: PostgreSQL (DATABASE_URL)' : 'Database: embedded Postgres in data/pglite');
  if (!app.auth.enabled) console.warn('ADMIN_PASSWORD is not set: commissioner login is disabled.');
  if (!app.ingest.apiKey) console.warn('OPENAI_API_KEY is not set: screenshot reading is disabled (manual entry still works).');
  if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: commissioner logins reset when the server restarts.');
});

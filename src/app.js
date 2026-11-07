// The JSON API. Shared by the local server (server.js) and the Vercel function (api/index.js).
import { createAuth, parseCookies } from './auth.js';
import { UserError } from './league.js';
import * as api from './api.js';
import { ingestConfig, ingestScreenshot, readScreenshot } from './ingest.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const MAX_ID = 2 ** 31 - 1;
const id = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ID) throw new UserError('Not found.', 404);
  return n;
};

export function createApp({ db, env = process.env }) {
  const serverless = Boolean(env.VERCEL);
  const auth = createAuth({
    adminPassword: env.ADMIN_PASSWORD,
    // Serverless instances don't share memory, so a random per-instance secret would log people out.
    sessionSecret: env.SESSION_SECRET,
    requireSecret: serverless,
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' : serverless,
  });
  const ingest = ingestConfig(env);

  // [method, pattern, handler, options]. Handlers receive ctx and return JSON-able data.
  const routes = [
    ['GET', /^\/api\/bootstrap$/, ctx => api.bootstrap(db, { admin: ctx.admin })],
    ['GET', /^\/api\/games\/(\d+)$/, ctx => api.gameDetail(db, id(ctx.params[0]))],
    ['GET', /^\/api\/stats$/, ctx => api.stats(db, {
      league: ctx.query.get('league') || 'premier', phase: ctx.query.get('phase') || 'regular',
    })],
    ['GET', /^\/api\/players\/(\d+)$/, ctx => api.playerLog(db, id(ctx.params[0]))],
    ['GET', /^\/api\/awards$/, ctx => api.awards(db, ctx.voter().id)],
    ['POST', /^\/api\/awards\/vote$/, async ctx => {
      const voter = ctx.voter();
      await api.vote(db, voter.id, ctx.body);
      return api.awards(db, voter.id);
    }],
    ['POST', /^\/api\/register$/, async ctx => {
      if (ctx.body.website) return { ok: true }; // honeypot field: bots fill it, people never see it
      if (!(await api.rateLimit(db, `register:${ctx.ip}`, 20, 3600))) throw new UserError('Too many submissions. Try again later.', 429);
      await api.register(db, ctx.body);
      return { ok: true };
    }],

    ['POST', /^\/api\/login$/, async ctx => {
      if (!auth.enabled) throw new UserError('Commissioner login is not set up on this server.', 503);
      if (!(await api.rateLimit(db, `login:${ctx.ip}`, 10, 900))) throw new UserError('Too many attempts. Try again in 15 minutes.', 429);
      if (!auth.passwordMatches(ctx.body.password)) throw new UserError('Incorrect password.', 401);
      ctx.setCookie(auth.sessionCookie());
      return { admin: true };
    }],
    ['POST', /^\/api\/logout$/, ctx => {
      ctx.setCookie(auth.clearCookie);
      return { admin: false };
    }],

    ['GET', /^\/api\/admin\/registrations$/, () => api.listRegistrations(db), { admin: true }],
    ['PATCH', /^\/api\/admin\/registrations\/(\d+)$/, ctx => api.setRegistrationStatus(db, id(ctx.params[0]), ctx.body.status), { admin: true }],
    ['PUT', /^\/api\/admin\/teams\/(\d+)$/, ctx => api.updateTeam(db, id(ctx.params[0]), ctx.body), { admin: true }],
    ['PUT', /^\/api\/admin\/series\/(\d+)$/, ctx => api.assignSeries(db, id(ctx.params[0]), ctx.body), { admin: true }],
    ['POST', /^\/api\/admin\/games$/, ctx => api.recordGame(db, ctx.body), { admin: true }],
    ['PUT', /^\/api\/admin\/games\/(\d+)$/, ctx => api.recordGame(db, ctx.body, id(ctx.params[0])), { admin: true }],
    ['POST', /^\/api\/admin\/rosters\/fill$/, () => api.fillRostersFromGames(db), { admin: true }],
    ['DELETE', /^\/api\/admin\/games\/(\d+)$/, ctx => api.deleteGame(db, id(ctx.params[0])), { admin: true }],
    ['POST', /^\/api\/admin\/news$/, ctx => api.postNews(db, ctx.body), { admin: true }],
    ['PUT', /^\/api\/admin\/news\/(\d+)$/, ctx => api.postNews(db, ctx.body, id(ctx.params[0])), { admin: true }],
    ['DELETE', /^\/api\/admin\/news\/(\d+)$/, ctx => api.deleteNews(db, id(ctx.params[0])), { admin: true }],
    ['PUT', /^\/api\/admin\/allstar$/, ctx => api.saveAllstar(db, ctx.body), { admin: true }],
    ['GET', /^\/api\/admin\/export$/, () => api.exportAll(db), { admin: true }],
    ['POST', /^\/api\/admin\/ingest$/, ctx => ingestScreenshot(db, ingest, ctx.body), { admin: true, maxBody: 15e6 }],
    ['GET', /^\/api\/screenshots\/(\d+)$/, ctx => readScreenshot(db, id(ctx.params[0]), ctx.admin), { raw: true }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      await route(req, res, url);
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      const status = err instanceof UserError ? err.status : 500;
      const message = err instanceof UserError ? err.message : 'Something went wrong on the server.';
      if (!res.headersSent) sendJson(res, status, { error: message });
    }
  }

  async function route(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    let found, params;
    for (const r of routes) {
      const m = r[0] === req.method && url.pathname.match(r[1]);
      if (m) { found = r; params = m.slice(1); break; }
    }
    if (!found) throw new UserError('Not found.', 404);
    const [, , handler, options = {}] = found;
    const admin = auth.isAdmin(cookies);
    if (options.admin && !admin) throw new UserError('Commissioner login required.', 401);

    let body = {};
    if (req.method !== 'GET') {
      // JSON-only writes double as CSRF protection: cross-site forms can't send application/json.
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new UserError('Send JSON.', 415);
      }
      body = await readJson(req, options.maxBody || 1e6);
    }

    const cookiesOut = [];
    let voter;
    const ctx = {
      params, body, admin, query: url.searchParams,
      // Vercel sets x-real-ip / x-forwarded-for itself, so clients can't spoof them there.
      ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown',
      setCookie: c => cookiesOut.push(c),
      voter: () => {
        voter ??= auth.voterId(cookies);
        if (voter.cookie) { cookiesOut.push(voter.cookie); voter.cookie = null; }
        return voter;
      },
    };
    const result = await handler(ctx);
    if (cookiesOut.length) res.setHeader('Set-Cookie', cookiesOut);
    if (options.raw) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': result.mime, 'Cache-Control': 'private, max-age=3600' });
      return res.end(result.data);
    }
    sendJson(res, 200, result ?? { ok: true });
  }

  return { handle, auth, ingest };
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new UserError('Upload is too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        if (chunks.length) return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        // Some hosts hand over an already-read body.
        const pre = req.body;
        resolve(typeof pre === 'string' ? JSON.parse(pre) : Buffer.isBuffer(pre) ? JSON.parse(pre.toString('utf8')) : pre || {});
      } catch { reject(new UserError('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

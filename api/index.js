// Vercel serverless function. vercel.json rewrites every /api/* request here; req.url keeps the
// original path, so the shared router in src/app.js works unchanged.
// The database must already be set up (npm run db:setup, or paste db/setup.sql): this function
// never creates tables, so cold starts stay fast.
import { connectPostgres } from '../src/db.js';
import { createApp, sendJson } from '../src/app.js';

let app;

export default async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return sendJson(res, 503, { error: 'DATABASE_URL is not set in the Vercel project settings.' });
  }
  app ??= createApp({ db: connectPostgres(process.env.DATABASE_URL), env: process.env });
  return app.handle(req, res);
}

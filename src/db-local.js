// Embedded PostgreSQL (PGlite) for local development and tests: no database server needed.
// Data lives in a folder (default ./data/pglite) or in memory when dir is omitted.
// Never imported by the Vercel function, so PGlite stays out of the deployed bundle.
import { mkdirSync } from 'node:fs';
import { wrap, setup } from './db.js';

// A folder can be open only once, so two callers in one process (npm run dev:test runs the site
// and the bot together) share the connection.
const open = new Map();
export function connectLocal(dir) {
  if (!dir) return openLocal();
  if (!open.has(dir)) open.set(dir, openLocal(dir));
  return open.get(dir);
}

async function openLocal(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  await lite.waitReady;
  const adapt = q => async (sql, p) => {
    const r = await q.query(sql, p);
    return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
  };
  const db = wrap(adapt(lite), sql => lite.exec(sql));
  db.tx = fn => lite.transaction(t => fn(wrap(adapt(t), sql => t.exec(sql))));
  db.close = () => lite.close();
  await setup(db);
  return db;
}

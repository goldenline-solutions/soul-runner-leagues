// Database access. Production uses any PostgreSQL server through `pg` (Neon, Supabase, Vercel
// Postgres, your own). Local dev and tests use the same SQL on an embedded Postgres (db-local.js).
//
// Every adapter exposes the same small async API:
//   all(sql, ...params) -> rows          get(sql, ...params) -> first row
//   run(sql, ...params) -> { changes }   exec(sql) -> runs a multi-statement script
//   tx(async t => ...) -> runs fn inside BEGIN/COMMIT; t offers the same API
// SQL is written with `?` placeholders; they become $1..$n here. (No SQL in this codebase puts a
// literal `?` inside a string.)
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedSql } from './seed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const toPg = sql => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

// query(sql, params) must resolve to { rows, rowCount }.
export function wrap(query, execScript) {
  const api = {
    all: async (sql, ...p) => (await query(toPg(sql), p)).rows,
    get: async (sql, ...p) => (await query(toPg(sql), p)).rows[0],
    run: async (sql, ...p) => ({ changes: (await query(toPg(sql), p)).rowCount }),
    exec: async sql => { await execScript(sql); },
  };
  api.tx = fn => fn(api); // already inside a transaction: nested calls join it
  return api;
}

export function connectPostgres(url, { max = Number(process.env.PG_POOL_MAX || 3) } = {}) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 10_000 });
  const db = wrap((sql, p) => pool.query(sql, p), sql => pool.query(sql));
  db.tx = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap((sql, p) => client.query(sql, p), sql => client.query(sql)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  return db;
}

export function migrationFiles() {
  const dir = join(root, 'migrations');
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

// Applies every migrations/*.sql file not yet recorded, then loads the season if the database is
// empty. Safe to run repeatedly and from several places at once (an advisory lock serializes it).
export async function setup(db) {
  return db.tx(async t => {
    await t.get('SELECT pg_advisory_xact_lock(727274)');
    await t.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Set((await t.all('SELECT name FROM _migrations')).map(r => r.name));
    const ran = [];
    for (const { name, sql } of migrationFiles()) {
      if (applied.has(name)) continue;
      await t.exec(sql);
      await t.run('INSERT INTO _migrations (name) VALUES (?)', name);
      ran.push(name);
    }
    const seeded = !(await t.get('SELECT 1 AS x FROM leagues LIMIT 1'));
    if (seeded) await t.exec(seedSql());
    return { ran, seeded };
  });
}

// Creates or updates the database: applies new migrations/*.sql files, then loads Season 1
// (teams, both schedules, playoff bracket) if the database is empty. Safe to run again any time.
//
//   npm run db:setup                         uses DATABASE_URL from .env or the environment
//   DATABASE_URL="postgres://..." npm run db:setup
import { loadEnv } from '../src/env.js';
import { connectPostgres, setup } from '../src/db.js';

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Put it in .env or run: DATABASE_URL="postgres://..." npm run db:setup');
  process.exit(1);
}

const db = connectPostgres(url, { max: 1 });
try {
  const { ran, seeded } = await setup(db);
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Schema already up to date.');
  console.log(seeded ? 'Loaded Season 1: leagues, teams, schedules, playoff bracket.' : 'Season data already present (not reloaded).');
  const counts = await db.get(`SELECT
    (SELECT COUNT(*)::int FROM teams) AS teams,
    (SELECT COUNT(*)::int FROM weeks) AS weeks,
    (SELECT COUNT(*)::int FROM series) AS matchups,
    (SELECT COUNT(*)::int FROM games) AS games,
    (SELECT COUNT(*)::int FROM players) AS players`);
  console.log(`Database now has: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
} catch (err) {
  console.error(`Setup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}

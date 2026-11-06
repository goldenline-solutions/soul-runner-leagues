// Saves every league table (not screenshots) to backups/league-<timestamp>.json.
// Same data as "Download data backup" in the Commissioner's Desk.
//   npm run db:backup
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, loadEnv } from '../src/env.js';
import { connectPostgres } from '../src/db.js';
import { exportAll } from '../src/api.js';

loadEnv();
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in .env or the environment.');
  process.exit(1);
}
const db = connectPostgres(process.env.DATABASE_URL, { max: 1 });
try {
  const data = await exportAll(db);
  const dir = join(root, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `league-${data.exported_at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Saved ${file} (${data.games.length} games, ${data.box_scores.length} box score lines).`);
} finally {
  await db.close();
}

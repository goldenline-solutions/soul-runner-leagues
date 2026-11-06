// Writes db/setup.sql: the full schema plus Season 1 data as one SQL script, for pasting into a
// database console (Neon / Supabase SQL editor, psql). Same result as `npm run db:setup`.
// Re-run after adding a migration or changing seed/schedule.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../src/env.js';
import { buildSetupSql } from '../src/setup-sql.js';

mkdirSync(join(root, 'db'), { recursive: true });
writeFileSync(join(root, 'db', 'setup.sql'), buildSetupSql());
console.log('Wrote db/setup.sql');

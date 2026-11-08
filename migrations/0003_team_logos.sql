-- Team logos / mascots, uploaded by the commissioner. One image per team, stored in the database
-- (hosts like Vercel have no persistent disk). teams.logo_version changes on every upload so
-- browsers can cache /api/teams/:id/logo?v=N forever. Positive = has a logo; removing one makes it
-- negative, so a later upload still gets a URL no browser has cached.
CREATE TABLE team_logos (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  image BYTEA NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
ALTER TABLE teams ADD COLUMN logo_version INTEGER NOT NULL DEFAULT 0;

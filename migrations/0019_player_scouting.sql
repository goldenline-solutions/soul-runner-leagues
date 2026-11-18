-- AI-written scouting reports, one per player per league. `signature` is the body of work the
-- report was written from (games played and the main totals): the report is written again only
-- after a new or corrected box score. `report` is JSON.
CREATE TABLE player_scouting (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  signature TEXT NOT NULL,
  report TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (player_id, league_id)
);

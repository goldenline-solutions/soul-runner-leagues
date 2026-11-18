-- AI-written archetype names, one per player per league. `signature` is the stat profile the name
-- was written for (best skill, second skill, two-way or not): the name is only written again when
-- that profile changes, so a player keeps their name from game to game and the model is rarely called.
CREATE TABLE player_archetypes (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  signature TEXT NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (player_id, league_id)
);

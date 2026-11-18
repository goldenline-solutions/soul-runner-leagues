-- Player photos: the owner of a claimed profile (or the commissioner) uploads one picture. Stored
-- in the database like team logos. players.photo_version works like teams.logo_version: it changes
-- on every upload so /api/players/:id/photo?v=N can be cached for good; negative = no photo.
CREATE TABLE player_photos (
  player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  image BYTEA NOT NULL,
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
ALTER TABLE players ADD COLUMN photo_version INTEGER NOT NULL DEFAULT 0;

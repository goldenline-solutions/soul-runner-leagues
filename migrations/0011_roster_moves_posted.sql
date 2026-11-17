-- Roster changes made on the site now reach Discord: the bot picks up every move it has not
-- handled yet, fixes the player's roles and posts it in the transactions channel (bot/roster.js).

-- Where the change was made: a /roster command ('discord') or the site's roster editor ('site').
ALTER TABLE roster_moves ADD COLUMN source TEXT NOT NULL DEFAULT 'discord' CHECK (source IN ('discord', 'site'));
-- False until the bot has handled the move. Moves from before this migration count as handled.
ALTER TABLE roster_moves ADD COLUMN posted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE roster_moves ALTER COLUMN posted SET DEFAULT FALSE;
CREATE INDEX roster_moves_unposted ON roster_moves (id) WHERE NOT posted;

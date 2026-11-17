-- Owner and captain changes go in the move log too, so one made on the site reaches Discord
-- (the bot gives or takes the team role and the Owner / Captain roles).
ALTER TABLE roster_moves DROP CONSTRAINT roster_moves_action_check;
ALTER TABLE roster_moves ADD CONSTRAINT roster_moves_action_check
  CHECK (action IN ('sign', 'release', 'move', 'free_agent', 'free_agent_removed', 'staff'));
-- An owner or captain need not be a player: a staff move names the Discord account instead.
ALTER TABLE roster_moves ALTER COLUMN player_id DROP NOT NULL;
ALTER TABLE roster_moves ADD COLUMN discord_id TEXT;

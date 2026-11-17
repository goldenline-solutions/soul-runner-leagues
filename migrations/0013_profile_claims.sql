-- Profile claims: someone logged in with Discord on the site claims their player record
-- (players.discord_id). The claim goes in the move log so the bot gives them their roles.
ALTER TABLE roster_moves DROP CONSTRAINT roster_moves_action_check;
ALTER TABLE roster_moves ADD CONSTRAINT roster_moves_action_check
  CHECK (action IN ('sign', 'release', 'move', 'free_agent', 'free_agent_removed', 'staff', 'claim'));

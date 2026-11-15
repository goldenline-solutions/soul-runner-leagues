-- roster_moves also records someone being taken out of the free agent pool without a signing
-- (/roster freeagent remove, or a member who left the server).
ALTER TABLE roster_moves DROP CONSTRAINT roster_moves_action_check;
ALTER TABLE roster_moves ADD CONSTRAINT roster_moves_action_check
  CHECK (action IN ('sign', 'release', 'move', 'free_agent', 'free_agent_removed'));

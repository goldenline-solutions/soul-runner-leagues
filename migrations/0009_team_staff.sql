-- Who may run the limited roster commands for a team: its owners and captains (src/roster.js).
-- Keyed by Discord id, because an owner does not have to be a player. Set with /roster staff.
CREATE TABLE team_staff (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  discord_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner', 'captain')),
  PRIMARY KEY (team_id, discord_id)
);
CREATE INDEX team_staff_member ON team_staff (discord_id);

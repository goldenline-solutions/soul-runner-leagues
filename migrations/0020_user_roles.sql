-- The Discord server roles a logged-in person held when last checked (a JSON array of role ids).
-- The site reads them at "Log in with Discord": the Commissioner role opens the commissioner pages,
-- and the Owner or Captain role together with a team's role lets them manage that team's roster.
ALTER TABLE users ADD COLUMN discord_roles TEXT;
ALTER TABLE users ADD COLUMN roles_checked_at TIMESTAMPTZ;

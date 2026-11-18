-- The second league is now called the G-League. Its id stays 'affiliate', so teams, weeks and
-- matchups keep pointing at it.
UPDATE leagues SET name = 'G-League', season_name = 'G-League: Season 1' WHERE id = 'affiliate';

-- Game recaps in Discord: the bot posts a short game and series summary in the news channel for
-- every game saved, on the site or with the bot's Save button (bot/gamenews.js).

-- False until the bot has handled the game. Games from before this migration count as handled.
ALTER TABLE games ADD COLUMN news_posted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE games ALTER COLUMN news_posted SET DEFAULT FALSE;
CREATE INDEX games_news_unposted ON games (id) WHERE NOT news_posted;

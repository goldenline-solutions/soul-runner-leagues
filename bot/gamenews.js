// Game recaps in the news channel. Every game saved, on the site or with the Save button under a
// /boxscore reading, is picked up here within a few seconds and posted in GAME_NEWS_CHANNEL_ID as
// a short summary (src/gamenews.js). A game is posted once: later corrections to it are not.
// Games saved while the bot is off are posted when it starts.
import { gameNews, newsMessage, gamesToPost, markNewsPosted } from '../src/gamenews.js';

const TICK_MS = 20_000;

export async function postGameNews(client, ctx) {
  for (const { id } of await gamesToPost(ctx.db)) {
    await markNewsPosted(ctx.db, id); // first: a game that cannot be posted is not retried forever
    if (!ctx.newsChannelId) continue;
    const news = await gameNews(ctx.db, ctx.ingest, id, ctx.fetchImpl ?? fetch);
    const channel = await client.channels.fetch(ctx.newsChannelId);
    await channel.send(newsMessage(news, { siteUrl: ctx.siteUrl }));
  }
}

function start(client, ctx) {
  if (!ctx.newsChannelId) console.warn('GAME_NEWS_CHANNEL_ID is not set: game recaps are not posted.');
  let busy = false; // a recap can take longer than one tick to write
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await postGameNews(client, ctx); } catch (err) { console.error(err); } finally { busy = false; }
  };
  run();
  setInterval(run, TICK_MS);
}

export default { commands: [], names: [], start };

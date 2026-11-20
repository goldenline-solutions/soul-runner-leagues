import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { saveGame } from '../src/league.js';
import { gameFacts, gameNews, newsMessage } from '../src/gamenews.js';
import { postGameNews } from '../bot/gamenews.js';

const line = (side, tag, stats) => ({ side, tag, pts: 0, fgm: 0, fga: 0, ...stats });

async function seed() {
  const db = await connectLocal();
  const s = await db.get(`SELECT s.*, th.name AS home, ta.name AS away FROM series s
    JOIN teams th ON th.id = s.home_team_id JOIN teams ta ON ta.id = s.away_team_id
    WHERE s.stage = 'regular' AND s.league_id = 'premier' ORDER BY s.id LIMIT 1`);
  const play = (n, home, away, star) => saveGame(db, {
    series_id: s.id, game_number: n, home_score: home, away_score: away,
    box: [
      line('home', 'Star*Guy', { pts: star, fgm: star / 2, fga: star, reb: 11, ast: 4 }),
      line('home', 'Helper', { pts: 6, fgm: 3, fga: 6 }),
      line('away', 'Rival', { pts: 18, fgm: 9, fga: 20, ast: 6 }),
    ],
  });
  return { db, s, play };
}

function fakeModel(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (reply instanceof Error) return new Response(JSON.stringify({ error: { message: reply.message } }), { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
  return { calls, fetchImpl };
}
const cfg = { apiKey: 'test', model: 'gpt-4o', baseUrl: 'http://model.test/v1' };

test('game facts: result, series state, performers with season notes, standings', async () => {
  const { db, s, play } = await seed();
  const g1 = await play(1, 60, 50, 20);
  let f = await gameFacts(db, g1);
  assert.deepEqual([f.winner, f.loser, f.winner_score, f.loser_score, f.margin], [s.home, s.away, 60, 50, 10]);
  assert.equal(f.series.text, `${s.home} lead the series 1-0`);
  assert.match(f.round, /^Weekend \d\d$/);
  assert.deepEqual(f.performers.map(p => [p.token, p.tag, p.won]), [['P1', 'Star*Guy', true], ['P2', 'Rival', false], ['P3', 'Helper', true]]);
  assert.ok(f.performers[0].notes.includes('double-double'));
  assert.ok(f.performers[0].notes.includes('first Premier League game'));
  assert.deepEqual(f.standings.map(t => [t.team, t.place, t.games]), [[s.home, 1, '1-0'], [s.away, f.standings[1].place, '0-1']]);

  const g2 = await play(2, 40, 55, 12);
  f = await gameFacts(db, g2);
  assert.equal(f.series.text, 'Series tied 1-1');
  assert.equal(f.winner, s.away);

  const g3 = await play(3, 70, 52, 34);
  f = await gameFacts(db, g3);
  assert.deepEqual([f.series.text, f.series.decided], [`${s.home} win the series 2-1`, true]);
  const star = f.performers[0];
  assert.ok(star.notes.includes('season high in points'));
  assert.ok(star.notes.includes('most points in a Premier League game this season'));
  assert.deepEqual([star.season.games, star.season.ppg], [3, 22]);
  assert.equal(f.standings[0].matchups, '1-0');
  // The facts for Game 1 still describe the series as it stood then.
  assert.equal((await gameFacts(db, g1)).series.text, `${s.home} lead the series 1-0`);
  await assert.rejects(gameFacts(db, 99999), /Game not found/);
});

test('game news: the model gets no player names, tags come back, and a plain recap covers a failure', async () => {
  const { db, s, play } = await seed();
  const id = await play(1, 60, 50, 20);
  const model = fakeModel({ headline: `P1 lifts ${s.home}`, recap: `P1 scored 20 with 11 rebounds as ${s.home} took Game 1. P2 answered with 18 for ${s.away}, who trail 1-0.` });
  const news = await gameNews(db, cfg, id, model.fetchImpl);
  assert.equal(news.ai, true);
  const sent = model.calls[0].messages[0].content;
  assert.doesNotMatch(sent, /Star\*Guy|Rival|Helper/, 'no player names in the prompt');
  assert.ok(sent.includes(s.home) && sent.includes('"name": "P1"'));
  assert.equal(news.headline, `Star\\*Guy lifts ${s.home}`);
  assert.ok(news.recap.startsWith('**Star\\*Guy** scored 20'));
  assert.ok(news.recap.includes('**Rival** answered'));

  const msg = newsMessage(news, { siteUrl: 'https://league.test/' });
  const [embed] = msg.embeds;
  assert.equal(embed.title, `FINAL: ${s.home} 60, ${s.away} 50`);
  assert.equal(embed.url, `https://league.test/#box/${id}`);
  assert.deepEqual(embed.fields.map(x => x.name), ['Series', 'Top performers', 'Standings']);
  assert.match(embed.fields[1].value, /^\*\*Star\\\*Guy\*\* \(.+\): 20 PTS, 11 REB, 4 AST · double-double/);
  assert.deepEqual(msg.allowedMentions, { parse: [] });

  // Model down, or no key: the recap is written here instead.
  for (const plain of [await gameNews(db, cfg, id, fakeModel(new Error('down')).fetchImpl), await gameNews(db, { ...cfg, apiKey: '' }, id)]) {
    assert.equal(plain.ai, false);
    assert.equal(plain.headline, `${s.home} 60, ${s.away} 50`);
    assert.ok(plain.recap.startsWith(`${s.home} beat ${s.away} 60-50 in Game 1 of their Premier League matchup.`));
    assert.match(plain.recap, /\*\*Star\\\*Guy\*\* led .+ with 20 points and 11 rebounds \(double-double\)\./);
    assert.match(plain.recap, /are 1st of \d+ in the Premier League at 1-0 in games\.$/);
  }
});

test('the bot posts each new game once, and a forfeit gets a short notice', async () => {
  const { db, s, play } = await seed();
  const sent = [];
  const client = { channels: { fetch: async id => ({ send: async m => { sent.push([id, m]); } }) } };
  const ctx = { db, ingest: { apiKey: '' }, newsChannelId: 'news-1', siteUrl: 'https://league.test' };

  await postGameNews(client, ctx);
  assert.equal(sent.length, 0, 'nothing to post yet');
  const id = await play(1, 60, 50, 20);
  await postGameNews(client, ctx);
  assert.deepEqual([sent.length, sent[0][0]], [1, 'news-1']);
  assert.equal(sent[0][1].embeds[0].url, `https://league.test/#box/${id}`);

  // A correction to the game is not posted again.
  await saveGame(db, { home_score: 61, away_score: 50, box: [line('home', 'Star*Guy', { pts: 21, fgm: 10, fga: 20 })] }, id);
  await postGameNews(client, ctx);
  assert.equal(sent.length, 1);

  await saveGame(db, { series_id: s.id, game_number: 2, home_score: 0, away_score: 0, forfeit: 'away' });
  await postGameNews(client, ctx);
  assert.equal(sent.length, 2);
  const forfeit = sent[1][1].embeds[0];
  assert.match(forfeit.description, /by forfeit/);
  assert.deepEqual(forfeit.fields.map(x => x.name), ['Series', 'Standings']);
  assert.match(forfeit.fields[0].value, /win the series 2-0/);

  // With no news channel set, new games are still marked handled, so they don't flood the channel later.
  const s2 = await db.get("SELECT id FROM series WHERE stage = 'regular' AND league_id = 'premier' AND id <> ? ORDER BY id LIMIT 1", s.id);
  await saveGame(db, { series_id: s2.id, game_number: 1, home_score: 30, away_score: 20, box: [line('home', 'Someone', { pts: 30, fgm: 15, fga: 20 })] });
  await postGameNews(client, { ...ctx, newsChannelId: '' });
  await postGameNews(client, ctx);
  assert.equal(sent.length, 2);
});

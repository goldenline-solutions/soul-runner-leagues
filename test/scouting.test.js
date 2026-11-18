import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { saveGame } from '../src/league.js';
import { playerScouting } from '../src/scouting.js';

const line = (side, tag, stats) => ({ side, tag, pts: 0, fgm: 0, fga: 0, ...stats });

// Four games for "dimes" on the home team of two matchups: "gunner" plays the first two with
// them (and takes the shots), then sits out the next two.
async function seedGames(db) {
  const [s1, s2] = await db.all(`SELECT * FROM series WHERE stage = 'regular' AND league_id = 'premier'
    AND home_team_id = (SELECT home_team_id FROM series WHERE stage = 'regular' AND league_id = 'premier' ORDER BY id LIMIT 1) ORDER BY id LIMIT 2`);
  const play = (s, n, withGunner) => saveGame(db, {
    series_id: s.id, game_number: n, home_score: withGunner ? 60 : 40, away_score: withGunner ? 50 : 55,
    box: [
      line('home', 'dimes', withGunner ? { pts: 8, fgm: 4, fga: 8, ast: 12 } : { pts: 20, fgm: 10, fga: 22, ast: 3 }),
      ...(withGunner ? [line('home', 'gunner', { pts: 30, fgm: 15, fga: 25 })] : []),
      line('home', 'big', { pts: 6, fgm: 3, fga: 5, reb: 11 }),
      line('away', 'rival', { pts: 20, fgm: 10, fga: 20 }),
    ],
  });
  await play(s1, 1, true);
  await play(s1, 2, true);
  await play(s2, 1, false);
  await play(s2, 2, false);
  return (await db.get("SELECT id FROM players WHERE discord_tag = 'dimes'")).id;
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
const REPLY = {
  headline: 'PLAYER runs the show',
  summary: 'PLAYER averages 7.5 assists. It is a small sample.',
  strengths: ['PLAYER sets up MATE_1 for easy shots.', 'Shares the ball: 12 assists with MATE_1 on the floor.'],
  weaknesses: ['Scores less next to MATE_1.'],
  with_teammates: 'PLAYER likely feeds MATE_1, and MATE_2 probably cleans the glass.',
  game_plan: 'Deny MATE_1 and make PLAYER score.',
};

test('scouting report: teammate context goes to the model without names, and names come back in the text', async () => {
  const db = await connectLocal();
  const id = await seedGames(db);
  const model = fakeModel(REPLY);
  const { report, ai } = await playerScouting(db, cfg, id, 'premier', model.fetchImpl);
  assert.equal(ai, true);
  assert.equal(model.calls.length, 1);

  const sent = model.calls[0].messages[0].content;
  assert.doesNotMatch(sent, /dimes|gunner|"big"|rival/, 'no player names in the prompt');
  const facts = JSON.parse(sent.slice(sent.indexOf('Data:') + 5));
  assert.equal(facts.games, 4);
  assert.equal(facts.team_record_in_those_games, '2-2');
  // "big" played all four games, "gunner" two: most games together comes first.
  assert.deepEqual(facts.teammates.map(m => [m.name, m.games_together]), [['MATE_1', 4], ['MATE_2', 2]]);
  const gunner = facts.teammates[1];
  assert.equal(gunner.their_per_game_in_those_games.pts, 30);
  assert.equal(gunner.PLAYER_with_them.ast, 12);
  assert.equal(gunner.PLAYER_without_them.pts, 20);
  assert.deepEqual([gunner.team_record_together, gunner.team_record_without_them], ['2-0', '0-2']);
  assert.equal(facts.teammates[0].PLAYER_with_them, undefined, 'no with/without split for a teammate who never sat out');
  assert.equal(facts.share_of_team_totals_pct.assists, 100);
  assert.equal(facts.recent_games_oldest_first.length, 4);
  assert.match(facts.recent_games_oldest_first[0].result, /^W 60-50$/);

  assert.equal(report.headline, 'dimes runs the show');
  assert.equal(report.with_teammates, 'dimes likely feeds big, and gunner probably cleans the glass.');
  assert.equal(report.game_plan, 'Deny big and make dimes score.');
  assert.deepEqual([report.games, report.confidence, report.strengths.length], [4, 'medium', 2]);

  // Saved: a second view makes no model call.
  assert.deepEqual((await playerScouting(db, cfg, id, 'premier', model.fetchImpl)).report, report);
  assert.equal(model.calls.length, 1);
});

test('scouting report: none without a key or enough games, and the old one stays when the model fails', async () => {
  const db = await connectLocal();
  const id = await seedGames(db);
  assert.deepEqual(await playerScouting(db, { ...cfg, apiKey: '' }, id, 'premier', fakeModel(REPLY).fetchImpl), { report: null, ai: false });
  assert.equal((await playerScouting(db, cfg, id, 'affiliate', fakeModel(REPLY).fetchImpl)).report, null);
  assert.equal((await playerScouting(db, cfg, id, 'premier', fakeModel(new Error('down')).fetchImpl)).report, null);
  await assert.rejects(playerScouting(db, cfg, id, 'nope', fakeModel(REPLY).fetchImpl), /Unknown league/);

  const first = (await playerScouting(db, cfg, id, 'premier', fakeModel(REPLY).fetchImpl)).report;
  // A new box score makes the saved report out of date; with the model down, the saved one is shown.
  const s = await db.get(`SELECT s.* FROM series s WHERE s.stage = 'regular' AND s.league_id = 'premier'
    AND s.home_team_id = (SELECT team_id FROM box_scores WHERE player_id = ? LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM games g WHERE g.series_id = s.id) ORDER BY s.id LIMIT 1`, id);
  await saveGame(db, { series_id: s.id, game_number: 1, home_score: 50, away_score: 40, box: [line('home', 'dimes', { pts: 10, fgm: 5, fga: 9 })] });
  const stale = await playerScouting(db, cfg, id, 'premier', fakeModel(new Error('down')).fetchImpl);
  assert.equal(stale.report.games, 4);
  assert.equal(stale.report.headline, first.headline);
  const fresh = fakeModel({ ...REPLY, headline: 'PLAYER after five' });
  assert.equal((await playerScouting(db, cfg, id, 'premier', fresh.fetchImpl)).report.headline, 'dimes after five');
  assert.equal(fresh.calls.length, 1);
});

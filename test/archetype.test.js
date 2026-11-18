import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { saveGame } from '../src/league.js';
import { playerArchetype } from '../src/archetype.js';

const line = (side, tag, stats) => ({ side, tag, pts: 0, fgm: 0, fga: 0, ...stats });

// Two games in one matchup: "dimes" passes, "boards" rebounds and blocks.
async function seedGames(db) {
  const s = await db.get("SELECT * FROM series WHERE stage = 'regular' AND league_id = 'premier' ORDER BY id LIMIT 1");
  for (const n of [1, 2]) {
    await saveGame(db, {
      series_id: s.id, game_number: n, home_score: 60, away_score: 50,
      box: [
        line('home', 'dimes', { pts: 8, fgm: 4, fga: 8, ast: 12, reb: 2 }),
        line('home', 'boards', { pts: 10, fgm: 5, fga: 9, reb: 14, blk: 3 }),
        line('away', 'other', { pts: 20, fgm: 8, fga: 18, reb: 4, ast: 2 }),
      ],
    });
  }
  return (await db.get("SELECT id FROM players WHERE discord_tag = 'dimes'")).id;
}

// A stand-in for the OpenAI API that counts calls and answers with `reply`.
function fakeModel(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) return new Response(JSON.stringify({ error: { message: reply.message } }), { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
  return { calls, fetchImpl };
}
const cfg = { apiKey: 'test', model: 'gpt-4o', baseUrl: 'http://model.test/v1' };

test('AI archetype: written once, saved, and reused while the profile is the same', async () => {
  const db = await connectLocal();
  const id = await seedGames(db);
  const model = fakeModel({ name: '  Court "Vision"\nMaestro ', tagline: 'Runs the offense with 12 assists a night.' });
  const first = await playerArchetype(db, cfg, id, 'premier', model.fetchImpl);
  assert.deepEqual(first, { name: 'Court Vision Maestro', tagline: 'Runs the offense with 12 assists a night.', ai: true });
  assert.equal(model.calls.length, 1);
  const sent = model.calls[0].body.messages[0].content;
  assert.match(sent, /"assists": 12/);
  assert.doesNotMatch(sent, /dimes/, 'the player name is not sent to the model');
  assert.deepEqual(await playerArchetype(db, cfg, id, 'premier', model.fetchImpl), first);
  assert.equal(model.calls.length, 1, 'second view comes from the database');
});

test('AI archetype falls back to the rule-based name', async () => {
  const db = await connectLocal();
  const id = await seedGames(db);
  const noKey = await playerArchetype(db, { ...cfg, apiKey: '' }, id, 'premier', fakeModel({}).fetchImpl);
  assert.equal(noKey.ai, false);
  assert.match(noKey.name, /Floor General/);
  const broken = fakeModel(new Error('model down'));
  assert.deepEqual(await playerArchetype(db, cfg, id, 'premier', broken.fetchImpl), noKey);
  assert.equal(broken.calls.length, 1);
  // Not enough games in the other league: no name at all, and no model call.
  const quiet = fakeModel({ name: 'x', tagline: 'y' });
  assert.equal((await playerArchetype(db, cfg, id, 'affiliate', quiet.fetchImpl)).name, null);
  assert.equal(quiet.calls.length, 0);
  await assert.rejects(playerArchetype(db, cfg, id, 'nope', quiet.fetchImpl), /Unknown league/);
});

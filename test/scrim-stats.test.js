// Scrim stats (scrim_box_scores) and the fake opponent used for testing alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import * as scrim from '../src/scrim.js';
import scrimBot from '../bot/scrim.js';

// Fake OpenAI endpoint, as in ingest.test.js.
let replies = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const name = JSON.parse(body).response_format.json_schema.name;
    const content = name === 'ScreenshotValidation'
      ? { is_valid_rec_screenshot: true, has_basketball_stats: true, has_player_gamertags: true, has_team_scores: true, has_nba2k_interface: true, is_5v5_game: true, reason: '' }
      : replies.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
});
let cfg;
before(async () => {
  await new Promise(r => fake.listen(0, r));
  cfg = { apiKey: 'test', model: 'gpt-4o', baseUrl: `http://127.0.0.1:${fake.address().port}`, validate: true };
});
after(() => { fake.close(); });

const line = pts => ({ pts, reb: 2, ast: 1, stl: 0, blk: 0, fouls: 1, tov: 0, fgm: pts / 2, fga: pts / 2, tpm: 0, tpa: 0, ftm: 0, fta: 0 });
// AWAY scores 30, HOME scores 40.
function extraction(away, home) {
  const pts = [10, 8, 6, 4, 2];
  return {
    metadata: { season_label: null, mode_label: null, extracted_from: 'x', platform_hint: 'PC', has_platform_icons_before_names: false },
    game: { away_score: 30, home_score: 40, quarters: { away: [null, null, null, null], home: [null, null, null, null] } },
    teams: [{ side: 'AWAY', grade: 'B', totals: line(30) }, { side: 'HOME', grade: 'A', totals: line(40) }],
    players: [
      ...away.map((n, i) => ({ side: 'AWAY', row_index: i, gamertag: n, grade: 'B', stats: line(pts[i]) })),
      ...home.map((n, i) => ({ side: 'HOME', row_index: i, gamertag: n, grade: 'A', stats: line(pts[i] + 2) })),
    ],
    indicated_matchups: null,
  };
}
const png = n => `data:image/png;base64,${Buffer.from(`scrim-shot-${n}`).toString('base64')}`;

// Two captained teams with an accepted 5v5 match between them.
async function acceptedMatch() {
  const db = await connectLocal();
  const teams = await db.all('SELECT id, name FROM teams ORDER BY id LIMIT 2');
  const captains = [];
  for (const [i, team] of teams.entries()) {
    const user = await scrim.upsertUser(db, { discordId: `cap${i}` });
    await scrim.setMember(db, team.id, user.id, 'captain');
    captains.push(user);
  }
  await scrim.joinQueue(db, captains[0].id);
  const { match } = await scrim.joinQueue(db, captains[1].id);
  await scrim.respondToMatch(db, captains[0].id, true);
  await scrim.respondToMatch(db, captains[1].id, true);
  return { db, teams, captains, match };
}
const count = async (db, table) => (await db.get(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;

test('a reported 5v5 result saves its box score as scrim stats, apart from league stats', async () => {
  const { db, teams, captains: [a], match } = await acceptedMatch();
  await db.run("INSERT INTO players (discord_tag) VALUES ('Ace')");
  const playersBefore = await count(db, 'players');
  replies = [extraction(['Ace', 'B2', 'B3', 'B4', 'AI Player'], ['H1', 'H2', 'H3', 'H4', 'H5'])];

  // Team A reports 40-30 in its own favour, so the screenshot's HOME side (40) is team A.
  const { warning } = await scrim.reportResult(db, cfg, a.id, { score_a: 40, score_b: 30, image: png(1) });
  assert.equal(warning, null);

  const rows = await db.all('SELECT * FROM scrim_box_scores WHERE match_id = ? ORDER BY id', match.id);
  assert.equal(rows.length, 9); // ten rows read, the AI player left out
  const by = name => rows.find(r => r.name === name);
  assert.equal(by('H1').team_id, teams[0].id);
  assert.deepEqual([by('H1').pts, by('H1').reb, by('H1').pf, by('H1').fgm], [12, 2, 1, 6]);
  assert.equal(by('Ace').team_id, teams[1].id);
  assert.ok(by('Ace').player_id, 'a known league player keeps the link');
  assert.equal(by('B2').player_id, null);
  assert.equal(rows.filter(r => r.team_id === teams[0].id).reduce((s, r) => s + r.pts, 0), 40);

  // League data is untouched: no league box score, no game, no new players.
  assert.equal(await count(db, 'box_scores'), 0);
  assert.equal(await count(db, 'games'), 0);
  assert.equal(await count(db, 'players'), playersBefore);
});

test('a screenshot that disagrees with the reported score is flagged and saves no stats', async () => {
  const { db, captains: [a], match } = await acceptedMatch();
  replies = [extraction(['A1', 'A2', 'A3', 'A4', 'A5'], ['H1', 'H2', 'H3', 'H4', 'H5'])];
  const { warning, match: reported } = await scrim.reportResult(db, cfg, a.id, { score_a: 55, score_b: 30, image: png(2) });
  assert.match(warning, /screenshot reads 30-40, but 55-30 was reported\. Player stats were not saved/);
  assert.equal(reported.status, 'awaiting_result'); // the report itself still stands
  assert.equal(await count(db, 'scrim_box_scores'), 0);
  assert.equal(match.id, reported.id);
});

test('3v3 results and servers without a reader save the score only', async () => {
  const { db, captains: [a] } = await acceptedMatch();
  const { warning } = await scrim.reportResult(db, { apiKey: '' }, a.id, { score_a: 21, score_b: 15, image: png(3) });
  assert.equal(warning, null);
  assert.equal(await count(db, 'scrim_box_scores'), 0);
  assert.equal(await count(db, 'match_results'), 1);
});

// ---------- fake opponent ----------

test('the fake opponent queues an empty team, matches, never answers, and times out', async () => {
  const db = await connectLocal();
  const [mine] = await db.all('SELECT id, name FROM teams ORDER BY id LIMIT 1');
  const me = await scrim.upsertUser(db, { discordId: 'solo' });
  await scrim.setMember(db, mine.id, me.id, 'captain');

  const opponent = await scrim.queueFakeOpponent(db, { mode: 'scrim', team_size: 5 });
  assert.notEqual(opponent.team.id, mine.id);
  await assert.rejects(scrim.queueFakeOpponent(db), /already in the queue/);

  const { entry, match } = await scrim.joinQueue(db, me.id);
  assert.equal(match.team_a_id, opponent.team.id);
  assert.deepEqual((await scrim.matchMembers(db, match)).map(u => u.discord_id), ['solo']); // nobody fake to add or ping
  await scrim.respondToMatch(db, me.id, true);

  await db.run("UPDATE matches SET created_at = now() - interval '6 minutes' WHERE id = ?", match.id);
  await scrim.runMatcher(db);
  assert.equal((await scrim.matchDetail(db, match.id)).status, 'cancelled');
  assert.equal((await db.get('SELECT status FROM queue_entries WHERE id = ?', entry.id)).status, 'waiting'); // you accepted, so you wait again
  assert.equal((await scrim.queueFakeOpponent(db)).match.status, 'pending_accept'); // reusable: same fake team, matched at once
});

test('/team testopponent in Discord: thread and match card for one real captain', async () => {
  const db = await connectLocal();
  const posts = [], added = [];
  const thread = { id: 'thread1', members: { add: async id => { added.push(id); } }, send: async p => { posts.push(p); }, setArchived: async () => {} };
  const channel = {
    send: async () => ({ id: 'live', pin: async () => {} }),
    messages: { edit: async () => ({}) },
    threads: { create: async () => thread },
  };
  const client = { channels: { fetch: async id => (id === 'queue-channel' ? channel : thread) } };
  const ctx = { db, ingest: { apiKey: '' }, queueChannelId: 'queue-channel' };
  const run = async (discordId, command, options = {}) => {
    const replies_ = [];
    await scrimBot.handle({
      client, user: { id: discordId, username: discordId }, commandName: command.split(' ')[0],
      isAutocomplete: () => false, isChatInputCommand: () => true,
      options: { getSubcommand: () => command.split(' ')[1], getString: k => options[k] ?? null, getInteger: k => options[k] ?? null, getUser: k => options[k] },
      reply: async p => { replies_.push(p.content); },
    }, ctx);
    return replies_.join('\n');
  };
  const [mine] = await db.all('SELECT id FROM teams ORDER BY id LIMIT 1');
  await run('commish', 'team captain', { team: String(mine.id), user: { id: 'solo', username: 'solo' } });

  assert.match(await run('commish', 'team testopponent'), /Fake opponent \*\*.+\*\* is in the queue for scrim 5v5/);
  assert.match(await run('solo', 'queue join'), /is matched/);
  assert.deepEqual(added, ['solo']);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].allowedMentions.users, ['solo']);
  assert.match(await run('solo', 'match accept'), /Waiting on the other captain/);
});

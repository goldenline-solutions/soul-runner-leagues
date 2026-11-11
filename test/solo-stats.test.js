// Solo queue results: the result card, the upload form, and stats saved to solo_box_scores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import { upsertUser } from '../src/scrim.js';
import * as solo from '../src/solo.js';
import soloBot, { matchPayload } from '../bot/solo.js';

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
const png = n => `data:image/png;base64,${Buffer.from(`solo-shot-${n}`).toString('base64')}`;
const AWAY = ['Ace', 'B2', 'B3', 'B4', 'AI Player'], HOME = ['H1', 'H2', 'H3', 'H4', 'H5'];

// Ten players seated and all accepted: the game is in progress.
async function startedGame() {
  const db = await connectLocal();
  const users = [];
  for (const [i, p] of [...solo.POSITIONS, ...solo.POSITIONS].entries()) {
    const user = await upsertUser(db, { discordId: `p${i}`, name: `p${i}` });
    users.push(user);
    await solo.joinQueue(db, user.id, { positions: [p] });
  }
  for (const u of users) await solo.respondToMatch(db, u.id, true);
  const match = await db.get('SELECT * FROM solo_matches');
  assert.equal(match.status, 'in_progress');
  return { db, users, match };
}
const count = async (db, table) => (await db.get(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;

test('a reported solo game saves its box score to solo_box_scores, apart from league and scrim stats', async () => {
  const { db, users, match } = await startedGame();
  await db.run("INSERT INTO players (discord_tag) VALUES ('Ace')");
  const playersBefore = await count(db, 'players');
  replies = [extraction(AWAY, HOME)];

  // Team A won, so the screenshot's winning side (HOME, 40) is Team A. Nobody typed a score.
  const done = await solo.reportResult(db, cfg, users[0].id, { winner: 'A', image: png(1) });
  assert.deepEqual([done.status, done.team_a_score, done.team_b_score, done.reported_by_user_id], ['completed', 40, 30, users[0].id]);
  assert.ok(done.screenshot_id);

  const rows = await db.all('SELECT * FROM solo_box_scores WHERE match_id = ? ORDER BY id', match.id);
  assert.equal(rows.length, 9); // ten rows read, the AI player left out
  const by = name => rows.find(r => r.name === name);
  assert.equal(by('H1').side, 'A');
  assert.deepEqual([by('H1').pts, by('H1').reb, by('H1').pf, by('H1').fgm], [12, 2, 1, 6]);
  assert.equal(by('Ace').side, 'B');
  assert.ok(by('Ace').player_id, 'a known league player keeps the link');
  assert.equal(by('B2').player_id, null);
  assert.equal(rows.filter(r => r.side === 'A').reduce((s, r) => s + r.pts, 0), 40);

  for (const table of ['box_scores', 'games', 'scrim_box_scores']) assert.equal(await count(db, table), 0);
  assert.equal(await count(db, 'players'), playersBefore);
});

test('an unreadable screenshot is refused and the game stays open; a game is reported once', async () => {
  const { db, users, match } = await startedGame();
  await assert.rejects(solo.reportResult(db, cfg, users[0].id, { winner: 'B', image: 'nope' }), /PNG, JPG/);
  assert.equal((await db.get('SELECT status FROM solo_matches WHERE id = ?', match.id)).status, 'in_progress');

  replies = [extraction(AWAY, HOME)];
  const done = await solo.reportResult(db, cfg, users[5].id, { winner: 'B', image: png(2) });
  assert.deepEqual([done.team_a_score, done.team_b_score], [30, 40]); // Team B won, so Team B has the 40
  await assert.rejects(solo.reportResult(db, cfg, users[0].id, { winner: 'A', image: png(2) }), /in progress/);
  assert.equal(await count(db, 'solo_box_scores'), 9);
});

test('in Discord: the game start posts a result card, and its form takes only the screenshot', async () => {
  const { db, users, match } = await startedGame();
  const card = matchPayload(match, await solo.matchPlayers(db, match.id));
  assert.match(card.embeds[0].title, /report the result/);
  assert.deepEqual(card.components[0].components.map(b => [b.custom_id, b.label]), [['solo:result:A', 'Team A won'], ['solo:result:B', 'Team B won']]);

  const ctx = { db, ingest: cfg, fetchImpl: async () => new Response(Buffer.from('solo-shot-4')) };
  const client = { channels: { fetch: async () => null } };
  const shown = [], said = [];
  const press = (customId, extra) => soloBot.handle({
    client, user: { id: users[2].discord_id, username: 'p2' }, customId, isChatInputCommand: () => false,
    showModal: async m => { shown.push(m); },
    deferReply: async function defer() { this.deferred = true; },
    editReply: async p => { said.push(p.content); },
    reply: async p => { said.push(p.content); },
    ...extra,
  }, ctx);

  // The "Team B won" button opens a form with one field: the screenshot.
  await press('solo:result:B');
  assert.equal(shown[0].custom_id, 'solo:resultform:B');
  assert.deepEqual(shown[0].components.map(c => [c.type, c.component.type, c.component.custom_id]), [[18, 19, 'screenshot']]);

  // Submitting it reads the score, ends the game and saves the stats.
  replies = [extraction(AWAY, HOME)];
  const file = { contentType: 'image/png', size: 11, url: 'https://cdn.example/shot.png' };
  const fields = { getUploadedFiles: () => ({ first: () => file }) };
  await press('solo:resultform:B', { fields });
  assert.match(said.at(-1), /Result reported by <@p2>: \*\*Team A\*\* 30 . 40 \*\*Team B\*\*\. Player stats saved\./);
  assert.equal((await db.get('SELECT status FROM solo_matches WHERE id = ?', match.id)).status, 'completed');
  assert.equal(await count(db, 'solo_box_scores'), 9);
  assert.equal((await db.get("SELECT side FROM solo_box_scores WHERE name = 'H1'")).side, 'B'); // HOME scored 40 = Team B

  // A second report is answered, not thrown.
  await press('solo:resultform:A', { fields });
  assert.match(said.at(-1), /don't have a solo game in progress/);
});

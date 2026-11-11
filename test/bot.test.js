import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import boxscore, { commands, formatReading, attachmentToDataUrl, SLASH_NAME, MENU_NAME } from '../bot/boxscore.js';

// Fake OpenAI endpoint, as in ingest.test.js.
let replies = [];
let modelCalls = 0;
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    modelCalls++;
    const name = JSON.parse(body).response_format.json_schema.name;
    const content = name === 'ScreenshotValidation'
      ? { is_valid_rec_screenshot: true, has_basketball_stats: true, has_player_gamertags: true, has_team_scores: true, has_nba2k_interface: true, is_5v5_game: true, reason: '' }
      : replies.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
});

let db, ctx;
before(async () => {
  await new Promise(r => fake.listen(0, r));
  db = await connectLocal();
  const fetchImpl = async url => ({ ok: true, arrayBuffer: async () => Buffer.from(`image-bytes:${url}`) });
  ctx = { db, siteUrl: 'https://league.test/', fetchImpl, ingest: { apiKey: 'test', model: 'gpt-4o', baseUrl: `http://127.0.0.1:${fake.address().port}`, validate: true } };
});
after(async () => { fake.close(); await db.close(); });

const line = pts => ({ pts, reb: 1, ast: 1, stl: 0, blk: 0, fouls: 0, tov: 0, fgm: pts / 2, fga: pts / 2, tpm: 0, tpa: 0, ftm: 0, fta: 0 });
function extraction(away, home) {
  const pts = [10, 8, 6, 4, 2];
  const players = [
    ...away.map((n, i) => ({ side: 'AWAY', row_index: i, gamertag: n, grade: 'B', stats: line(pts[i]) })),
    ...home.map((n, i) => ({ side: 'HOME', row_index: i, gamertag: n, grade: 'A', stats: line(pts[i] + 2) })),
  ];
  return {
    metadata: { season_label: null, mode_label: null, extracted_from: 'x', platform_hint: 'PC', has_platform_icons_before_names: false },
    game: { away_score: 30, home_score: 40, quarters: { away: [null, null, null, null], home: [null, null, null, null] } },
    teams: [{ side: 'AWAY', grade: 'B', totals: line(30) }, { side: 'HOME', grade: 'A', totals: line(40) }],
    players,
    indicated_matchups: null,
  };
}

function interaction(commandName, attachments) {
  const sent = [];
  return {
    commandName, sent,
    options: { getAttachment: () => attachments[0] },
    targetMessage: { attachments: new Map(attachments.map((a, i) => [String(i), a])) },
    deferReply: async () => { sent.push('defer'); },
    editReply: async payload => { sent.push(payload); },
  };
}
const png = name => ({ url: `https://cdn.test/${name}.png`, contentType: 'image/png', size: 1000 });

test('commands are server-only and limited to Manage Server by default', () => {
  assert.deepEqual(commands.map(c => [c.type, c.name]), [[1, SLASH_NAME], [3, MENU_NAME]]);
  for (const c of commands) {
    assert.equal(c.default_member_permissions, '32');
    assert.deepEqual(c.contexts, [0]);
  }
  assert.equal(commands[0].options[0].type, 11);
});

test('/boxscore reads the upload, stores the reading and saves no game', async () => {
  await db.run("INSERT INTO players (discord_tag) VALUES ('Ace')");
  replies = [extraction(['Ace', 'B2', 'B3', 'B4', 'AI Player'], ['H1', 'H2', 'H3', 'H4', 'H5'])];
  const it = interaction(SLASH_NAME, [png('one')]);
  await boxscore.handle(it, ctx);

  assert.equal(it.sent[0], 'defer');
  const reply = it.sent[1];
  assert.match(reply.content, /Box score read: Away 30, Home 40/);
  assert.match(reply.content, /\n Ace +10 /); // known league player: no flag
  assert.match(reply.content, /\n\*B2 +8 /); // unknown name
  assert.match(reply.content, /\n~AI Player +2 /);
  assert.match(reply.content, /https:\/\/league\.test\/#game/);
  assert.ok(reply.content.length <= 2000);
  assert.deepEqual(reply.embeds, [{ image: { url: 'https://cdn.test/one.png' } }]);
  assert.deepEqual(reply.allowedMentions, { parse: [] });

  assert.equal((await db.get('SELECT count(*)::int AS n FROM screenshots')).n, 1);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM games')).n, 0);
});

test('the same image is not read twice', async () => {
  const before = modelCalls;
  const it = interaction(SLASH_NAME, [png('one')]);
  await boxscore.handle(it, ctx);
  assert.equal(modelCalls, before);
  assert.match(it.sent[1].content, /read earlier, no new model call/);
});

test('Read box score uses the first image on the message', async () => {
  replies = [extraction(['A1', 'A2', 'A3', 'A4', 'A5'], ['H1', 'H2', 'H3', 'H4', 'H5'])];
  const it = interaction(MENU_NAME, [{ url: 'https://cdn.test/clip.mp4', contentType: 'video/mp4', size: 5 }, png('two')]);
  await boxscore.handle(it, ctx);
  assert.match(it.sent[1].content, /Box score read/);
  assert.deepEqual(it.sent[1].embeds, []);

  const none = interaction(MENU_NAME, []);
  await boxscore.handle(none, ctx);
  assert.match(none.sent[1].content, /Couldn't read it: That message has no PNG/);
});

test('bad uploads are refused before any download or model call', async () => {
  const calls = modelCalls;
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return { ok: true, arrayBuffer: async () => Buffer.alloc(1) }; };
  await assert.rejects(attachmentToDataUrl({ url: 'x', contentType: 'application/pdf', size: 10 }, fetchImpl), /PNG, JPG/);
  await assert.rejects(attachmentToDataUrl({ url: 'x', contentType: 'image/png', size: 11 * 1024 * 1024 }, fetchImpl), /10 MB/);
  assert.equal(fetched, 0);
  assert.equal(modelCalls, calls);
});

test('a long warning list still fits in one Discord message', () => {
  const stats = line(10);
  const lines = ['away', 'home'].flatMap(side => [0, 1, 2, 3, 4].map(i => ({ side, tag: `Player\`${side}${i}`, read_as: 'x', ai: false, match: null, stats })));
  const text = formatReading({ away_score: 50, home_score: 50, lines, warnings: Array.from({ length: 40 }, (_, i) => `Warning ${i} `.repeat(8)) });
  assert.ok(text.length <= 2000);
  assert.match(text, /more on the site/);
  assert.equal(text.match(/```/g).length, 2); // names can't break out of the code block
});

test('an image already saved as a game links to its box score', () => {
  assert.equal(formatReading({ screenshot_id: 1, duplicate_game_id: 7, message: 'x' }, { siteUrl: 'https://league.test' }),
    'This exact screenshot is already saved as a game. https://league.test/#box/7');
});

// ---------- matchup detection and the Save button ----------

function press(customId, message, { admin = true } = {}) {
  const sent = [];
  const it = {
    customId, sent, message, user: { id: '42' }, deferred: false,
    memberPermissions: { has: () => admin },
    deferUpdate: async () => { it.deferred = true; },
    editReply: async payload => { sent.push(payload); },
    reply: async payload => { sent.push(payload); },
    followUp: async payload => { sent.push(payload); },
  };
  return it;
}
const saveId = reply => reply.components[0]?.components[0].custom_id;

test('the matchup is found from the rosters, and Save records the game', async () => {
  const api = await import('../src/api.js');
  const series = await db.get(`SELECT s.*, th.name AS home, ta.name AS away FROM series s
    JOIN teams th ON th.id = s.home_team_id JOIN teams ta ON ta.id = s.away_team_id WHERE s.stage = 'regular' ORDER BY s.id LIMIT 1`);
  await api.updateTeam(db, series.home_team_id, { roster: { PG: 'Hx1', SG: 'Hx2', SF: 'Hx3', PF: 'Hx4', C: 'Hx5' } });
  await api.updateTeam(db, series.away_team_id, { roster: { PG: 'Ax1', SG: 'Ax2', SF: 'Ax3', PF: 'Ax4', C: 'Ax5' } });

  // The league's home team is on the screenshot's AWAY side (30 points), so sides flip.
  replies = [extraction(['Hx1', 'Hx2', 'Hx3', 'Hx4', 'Hx5'], ['Ax1', 'Ax2', 'Ax3', 'Ax4', 'Ax5'])];
  const read = interaction(SLASH_NAME, [png('league-1')]);
  await boxscore.handle(read, ctx);
  const reply = read.sent[1];
  assert.ok(reply.content.includes(`Box score read: ${series.away} 40, ${series.home} 30`));
  assert.match(reply.content, /Weekend \d+ · Game 1/);
  assert.match(reply.content, /Press Save below/);
  assert.equal(reply.components[0].components[0].label, 'Save as Game 1');
  assert.equal(saveId(reply).replace(/:[0-9]+:/, ':N:'), `box:save:N:${series.id}:1`);

  const outsider = press(saveId(reply), reply, { admin: false });
  await boxscore.handle(outsider, ctx);
  assert.match(outsider.sent[0].content, /Only members with Manage Server/);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM games')).n, 0);

  const ok = press(saveId(reply), reply);
  await boxscore.handle(ok, ctx);
  const game = await db.get('SELECT * FROM games WHERE series_id = ?', series.id);
  assert.deepEqual([game.game_number, game.home_score, game.away_score], [1, 30, 40]);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM box_scores WHERE game_id = ?', game.id)).n, 10);
  assert.equal((await db.get('SELECT game_id FROM screenshots WHERE id = ?', Number(saveId(reply).split(':')[2]))).game_id, game.id);
  assert.deepEqual(ok.sent[0].components, []);
  assert.ok(ok.sent[0].content.includes(`✅ Saved as Game 1 by <@42>. https://league.test/#box/${game.id}`));
  assert.doesNotMatch(ok.sent[0].content, /Not saved yet/);
  assert.ok(ok.sent[0].content.length <= 2000);

  // Pressing a stale Save button again changes nothing.
  const twice = press(saveId(reply), reply);
  await boxscore.handle(twice, ctx);
  assert.match(twice.sent[0].content, /Couldn't save it: This screenshot is already saved as a game/);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM games')).n, 1);
});

test('unknown names need a second press, and the next screenshot is Game 2', async () => {
  replies = [extraction(['Ax1', 'Ax2', 'Ax3', 'Ax4', 'Newbie'], ['Hx1', 'Hx2', 'Hx3', 'Hx4', 'Hx5'])];
  const read = interaction(MENU_NAME, [png('league-2')]);
  await boxscore.handle(read, ctx);
  const reply = read.sent[1];
  assert.equal(reply.components[0].components[0].label, 'Save as Game 2');

  const first = press(saveId(reply), reply);
  await boxscore.handle(first, ctx);
  assert.equal(first.sent[0].components[0].components[0].label, 'Add 1 new player (*) and save');
  assert.equal((await db.get('SELECT count(*)::int AS n FROM games')).n, 1);

  const second = press(saveId(first.sent[0]), reply);
  await boxscore.handle(second, ctx);
  assert.match(second.sent[0].content, /Saved as Game 2/);
  assert.equal((await db.get('SELECT count(*)::int AS n FROM games')).n, 2);
  assert.ok(await db.get("SELECT 1 AS x FROM players WHERE discord_tag = 'Newbie'"));
});

test('no Save button for a recorded game, a decided series, or players that fit no matchup', async () => {
  // Same ten players and score as Game 1, from a different image.
  replies = [extraction(['Ax1', 'Ax2', 'Ax3', 'Ax4', 'Ax5'], ['Hx1', 'Hx2', 'Hx3', 'Hx4', 'Hx5'])];
  const repeat = interaction(SLASH_NAME, [png('league-3')]);
  await boxscore.handle(repeat, ctx);
  assert.deepEqual(repeat.sent[1].components, []);
  assert.match(repeat.sent[1].content, /Duplicate game found/);

  // The series stands 1-1; a third game decides it.
  const lineup = [['Ax1', 'Ax2', 'Ax3', 'Ax4', 'AI Player'], ['Hx1', 'Hx2', 'Hx3', 'Hx4', 'Hx5']];
  replies = [extraction(...lineup)];
  const third = interaction(SLASH_NAME, [png('league-5')]);
  await boxscore.handle(third, ctx);
  assert.equal(third.sent[1].components[0].components[0].label, 'Save as Game 3');
  await db.run('INSERT INTO games (series_id, game_number, home_score, away_score) SELECT series_id, 3, 50, 45 FROM games LIMIT 1');
  replies = [extraction(lineup[0], ['Hx1', 'Hx2', 'Hx3', 'Hx4', 'AI Player'])];
  // These teams meet again later in the season, so the next screenshot goes to that matchup.
  const next = interaction(SLASH_NAME, [png('league-6')]);
  await boxscore.handle(next, ctx);
  const [, , , nextSeries, nextGame] = saveId(next.sent[1]).split(':');
  assert.notEqual(nextSeries, saveId(third.sent[1]).split(':')[3]);
  assert.equal(nextGame, '1');
  // With every meeting decided there is nothing left to save into.
  await db.run(`INSERT INTO games (series_id, game_number, home_score, away_score)
    SELECT s.id, n, 50, 45 FROM series s, generate_series(1, 2) n
    WHERE s.id <> ? AND (s.home_team_id, s.away_team_id) IN (SELECT home_team_id, away_team_id FROM series WHERE id = ?
      UNION SELECT away_team_id, home_team_id FROM series WHERE id = ?)`, Number(saveId(third.sent[1]).split(':')[3]), Number(nextSeries), Number(nextSeries));
  replies = [extraction(['Ax1', 'Ax2', 'Ax3', 'AI Player', 'Ax5'], lineup[1])];
  const decided = interaction(SLASH_NAME, [png('league-7')]);
  await boxscore.handle(decided, ctx);
  assert.deepEqual(decided.sent[1].components, []);
  assert.match(decided.sent[1].content, /series already decided/);

  replies = [extraction(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'], ['Y1', 'Y2', 'Y3', 'Y4', 'Y5'])];
  const unknown = interaction(SLASH_NAME, [png('league-4')]);
  await boxscore.handle(unknown, ctx);
  assert.deepEqual(unknown.sent[1].components, []);
  assert.match(unknown.sent[1].content, /Couldn't tell which matchup/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import { saveGame } from '../src/league.js';
import * as api from '../src/api.js';
import { ingestScreenshot, readScreenshot, cleanGamertag, fuzzRatio, matchPlayer } from '../src/ingest.js';

// Fake OpenAI endpoint: answers validation and extraction calls from queued responses.
let replies = [];
const calls = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    calls.push(parsed);
    const name = parsed.response_format.json_schema.name;
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

const stats = (pts, extra = {}) => ({ pts, reb: 1, ast: 1, stl: 0, blk: 0, fouls: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, ...extra });
function extraction(awayNames, homeNames, { awayPts = [10, 8, 6, 4, 2], homePts = [12, 10, 5, 3, 1] } = {}) {
  const players = [
    ...awayNames.map((n, i) => ({ side: 'AWAY', row_index: i, gamertag: n, grade: 'B', stats: stats(awayPts[i]) })),
    ...homeNames.map((n, i) => ({ side: 'HOME', row_index: i, gamertag: n, grade: 'A', stats: stats(homePts[i]) })),
  ];
  const sum = a => a.reduce((s, v) => s + v, 0);
  return {
    metadata: { season_label: null, mode_label: null, extracted_from: 'x', platform_hint: 'PC', has_platform_icons_before_names: false },
    game: { away_score: sum(awayPts), home_score: sum(homePts), quarters: { away: [null, null, null, null], home: [null, null, null, null] } },
    teams: [{ side: 'AWAY', grade: 'B', totals: stats(sum(awayPts)) }, { side: 'HOME', grade: 'A', totals: stats(sum(homePts)) }],
    players,
    indicated_matchups: null,
  };
}
const png = n => `data:image/png;base64,${Buffer.from(`fake-image-${n}`).toString('base64')}`;

test('name helpers match the 2K-app behaviour', () => {
  assert.equal(cleanGamertag('🔊 _Ace_Hoops! '), 'Ace_Hoops');
  assert.equal(cleanGamertag('0 Blaze'), 'Blaze');
  assert.equal(cleanGamertag('0ptimus'), '0ptimus');
  assert.equal(Math.round(fuzzRatio('acehoops', 'acehoop')), 93);
  const players = [{ id: 1, discord_tag: 'Ace#1', steam_tag: 'AceHoops' }];
  assert.equal(matchPlayer(players, 'acehoops').how, 'exact');
  assert.equal(matchPlayer(players, 'AceHoop').how, 'fuzzy');
  assert.equal(matchPlayer(players, 'Zed'), null);
});

test('screenshot becomes a draft mapped onto the matchup, then links to the saved game', async () => {
  const db = await connectLocal();
  const series = await db.get("SELECT * FROM series WHERE stage = 'regular' ORDER BY id LIMIT 1");
  // Home team roster uses H1..H5, away team roster uses A1..A5.
  await api.updateTeam(db, series.home_team_id, { roster: { PG: 'H1', SG: 'H2', SF: 'H3', PF: 'H4', C: 'H5' } });
  await api.updateTeam(db, series.away_team_id, { roster: { PG: 'A1', SG: 'A2', SF: 'A3', PF: 'A4', C: 'A5' } });

  // The screenshot shows the league home team on the 2K AWAY side, so sides must flip.
  replies.push(extraction(['H1', 'h2', '🔊H3', 'H4', 'AI Player'], ['A1', 'A2', 'A3', 'A4', 'Newbie']));
  const draft = await ingestScreenshot(db, cfg, { image: png(1), series_id: series.id });
  assert.equal(draft.swap, true);
  assert.equal(draft.home_score, 30);
  assert.equal(draft.away_score, 31);
  const h3 = draft.lines.find(l => l.read_as === 'H3');
  assert.equal(h3.side, 'home');
  assert.equal(h3.match.how, 'exact');
  assert.ok(draft.lines.find(l => l.read_as === 'AI Player').ai);
  assert.ok(draft.warnings.some(w => w.includes('"Newbie" is not a known league player')));

  // Same image again: no model call, served from the stored extraction.
  const before = calls.length;
  const again = await ingestScreenshot(db, cfg, { image: png(1), series_id: series.id });
  assert.equal(calls.length, before);
  assert.equal(again.cached, true);

  const box = draft.lines.filter(l => !l.ai).map(l => ({ side: l.side, tag: l.tag, ...l.stats }));
  const gameId = await saveGame(db, { series_id: series.id, game_number: 1, home_score: draft.home_score, away_score: draft.away_score, box, screenshot_id: draft.screenshot_id });
  assert.equal((await api.gameDetail(db, gameId)).screenshot_id, draft.screenshot_id);
  const shot = await readScreenshot(db, draft.screenshot_id, false);
  assert.equal(shot.data.toString(), 'fake-image-1', 'image bytes stored in the database');

  const third = await ingestScreenshot(db, cfg, { image: png(1), series_id: series.id });
  assert.equal(third.duplicate_game_id, gameId);
});

test('integrity problems trigger one retry with feedback', async () => {
  const db = await connectLocal();
  const bad = extraction(['a1', 'a2', 'a3', 'a4', 'a5'], ['h1', 'h2', 'h3', 'h4', 'h5']);
  bad.teams[0].totals.pts = 99;
  const good = extraction(['a1', 'a2', 'a3', 'a4', 'a5'], ['h1', 'h2', 'h3', 'h4', 'h5']);
  replies.push(bad, good);
  const start = calls.length;
  const draft = await ingestScreenshot(db, cfg, { image: png(2) });
  const prompts = calls.slice(start).map(c => c.messages[0].content[1].text);
  assert.ok(prompts.some(p => p.includes('player points sum (30) != team total (99)')));
  assert.ok(!draft.warnings.some(w => w.includes('points sum')));
});

test('missing API key gives a clear message', async () => {
  const db = await connectLocal();
  await assert.rejects(ingestScreenshot(db, { ...cfg, apiKey: '' }, { image: png(3) }), /OPENAI_API_KEY/);
});

test('a crew-leader name read as a player triggers a retry with feedback', async () => {
  const db = await connectLocal();
  const shifted = extraction(['Leader', 'a1', 'a2', 'a3', 'a4'], ['h1', 'h2', 'h3', 'h4', 'h5']);
  shifted.teams[0].header_name = 'Leader';
  const fixed = extraction(['a1', 'a2', 'a3', 'a4', 'a5'], ['h1', 'h2', 'h3', 'h4', 'h5']);
  fixed.teams[0].header_name = 'Leader';
  replies.push(shifted, fixed);
  const start = calls.length;
  const draft = await ingestScreenshot(db, cfg, { image: png(4) });
  const prompts = calls.slice(start).map(c => c.messages[0].content[1].text);
  assert.ok(prompts.some(p => p.includes('"Leader" is the name in the AWAY table\'s header row')));
  assert.ok(!draft.lines.some(l => l.read_as === 'Leader'));
  assert.ok(!draft.warnings.some(w => w.includes('header row')));
});

test('matching tries the matchup rosters first and never gives one player to two rows', async () => {
  const db = await connectLocal();
  const series = await db.get("SELECT * FROM series WHERE stage = 'regular' ORDER BY id LIMIT 1");
  const other = await db.get('SELECT id FROM teams WHERE id NOT IN (?, ?) LIMIT 1', series.home_team_id, series.away_team_id);
  await api.updateTeam(db, series.home_team_id, { roster: { PG: 'Winnebago', SG: 'Blaze' } });
  await api.updateTeam(db, other.id, { roster: { PG: 'Raymond Reddington' } });
  // 82% like a roster player: matched. 76% like a player on another team: not matched (needs 88).
  replies.push(extraction(['Winebag0', 'Blaze', 'Blazer', 'Raymond Red', 'x4'], ['h1', 'h2', 'h3', 'h4', 'h5']));
  const draft = await ingestScreenshot(db, cfg, { image: png(5), series_id: series.id });
  const row = name => draft.lines.find(l => l.read_as === name);
  assert.equal(row('Winebag0').tag, 'Winnebago');
  assert.equal(row('Winebag0').match.how, 'roster');
  assert.equal(row('Blaze').match.how, 'exact');
  assert.equal(row('Blazer').match, null, 'Blaze is already taken by the exact row');
  assert.equal(row('Raymond Red').match, null);
});

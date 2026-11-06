import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { saveGame, deleteGame } from '../src/league.js';
import * as api from '../src/api.js';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildSetupSql } from '../src/setup-sql.js';

const fresh = () => connectLocal(); // in-memory Postgres, migrated and seeded
const firstSeries = db => db.get("SELECT * FROM series WHERE stage = 'regular' ORDER BY id LIMIT 1");
const count = async (db, sql, ...p) => (await db.get(`SELECT COUNT(*)::int AS n FROM ${sql}`, ...p)).n;
const line = (side, tag, pts, extra = {}) => ({ side, tag, pts, fgm: 0, fga: 0, ...extra });

test('seed builds both leagues and the playoff bracket', async () => {
  const db = await fresh();
  assert.equal(await count(db, 'teams'), 18);
  assert.equal(await count(db, 'roster_slots'), 18 * 7);
  assert.equal(await count(db, "series WHERE stage = 'regular' AND league_id = 'premier'"), 132);
  assert.equal(await count(db, "series WHERE stage = 'regular' AND league_id = 'affiliate'"), 60);
  assert.equal(await count(db, "series WHERE stage <> 'regular'"), 7);
  assert.equal(await count(db, 'series WHERE home_team_id IS NULL AND stage = ?', 'regular'), 0, 'every scheduled team name resolved');
});

test('best-of-3 rules: order, ties, decided series', async () => {
  const db = await fresh();
  const s = await firstSeries(db);
  await assert.rejects(saveGame(db, { series_id: s.id, game_number: 2, home_score: 50, away_score: 40 }), /earlier series games/);
  await assert.rejects(saveGame(db, { series_id: s.id, game_number: 1, home_score: 40, away_score: 40 }), /non-tied/);
  await saveGame(db, { series_id: s.id, game_number: 1, home_score: 50, away_score: 40 });
  await assert.rejects(saveGame(db, { series_id: s.id, game_number: 1, home_score: 50, away_score: 40 }), /already recorded/);
  await saveGame(db, { series_id: s.id, game_number: 2, home_score: 30, away_score: 0, forfeit: 'away' });
  await assert.rejects(saveGame(db, { series_id: s.id, game_number: 3, home_score: 50, away_score: 40 }), /already decided/);
});

test('box score saves players, edit replaces lines, delete only from the end', async () => {
  const db = await fresh();
  const s = await firstSeries(db);
  const id = await saveGame(db, {
    series_id: s.id, game_number: 1, home_score: 21, away_score: 18,
    box: [line('home', 'Ace#1', 21, { fgm: 9, fga: 15, tpm: 3, tpa: 5 }), line('away', 'Blaze', 18), { side: 'home', tag: '' }],
  });
  assert.equal(await count(db, 'box_scores WHERE game_id = ?', id), 2);
  await saveGame(db, { home_score: 21, away_score: 18, box: [line('home', 'ace#1', 21)] }, id);
  assert.equal(await count(db, 'box_scores WHERE game_id = ?', id), 1);
  assert.equal(await count(db, 'players'), 2, 'tags match case-insensitively');
  const g2 = await saveGame(db, { series_id: s.id, game_number: 2, home_score: 10, away_score: 12 });
  await assert.rejects(deleteGame(db, id), /later series games/);
  await deleteGame(db, g2);
  await deleteGame(db, id);
});

test('a failed save leaves nothing behind', async () => {
  const db = await fresh();
  const s = await firstSeries(db);
  // Second line has a team id that violates nothing, but a duplicate tag is caught before the
  // transaction; force a mid-transaction failure with an out-of-range screenshot id instead.
  await assert.rejects(saveGame(db, { series_id: s.id, game_number: 1, home_score: 1, away_score: 0, box: [line('home', 'A', 1, { fgm: 1, fga: 1 })], screenshot_id: 2 ** 40 }));
  assert.equal(await count(db, 'games'), 0);
  assert.equal(await count(db, 'players'), 0);
});

test('box score rejects impossible shooting lines and duplicates', async () => {
  const db = await fresh();
  const s = await firstSeries(db);
  const base = { series_id: s.id, game_number: 1, home_score: 20, away_score: 10 };
  await assert.rejects(saveGame(db, { ...base, box: [line('home', 'A', 10, { fgm: 5, fga: 4 })] }), /exceed attempts/);
  await assert.rejects(saveGame(db, { ...base, box: [line('home', 'A', 10, { fgm: 2, fga: 6, tpm: 3, tpa: 3 })] }), /3-pointers/);
  await assert.rejects(saveGame(db, { ...base, box: [line('home', 'A', 1), line('away', 'a', 1)] }), /more than once/);
});

test('stats aggregate regular season lines per player', async () => {
  const db = await fresh();
  const s = await firstSeries(db);
  await saveGame(db, { series_id: s.id, game_number: 1, home_score: 30, away_score: 20, box: [line('home', 'Ace', 30, { fgm: 12, fga: 20, tpm: 6, tpa: 9 })] });
  await saveGame(db, { series_id: s.id, game_number: 2, home_score: 25, away_score: 20, box: [line('home', 'Ace', 25, { fgm: 10, fga: 18, tpm: 5, tpa: 10 })] });
  const [row] = await api.stats(db, { league: 'premier' });
  assert.equal(row.gp, 2);
  assert.equal(row.pts, 55);
  assert.equal(row.tpm, 11);
});

test('registrations validate and stay private; approval creates the player', async () => {
  const db = await fresh();
  await assert.rejects(api.register(db, { kind: 'player', discordTag: 'x' }), /Steam Tag/);
  await api.register(db, { kind: 'player', discordTag: 'Zed', steamTag: 'zed_s', recWinPercent: 61, fgShootingPercent: 50, threePtShootingPercent: 38 });
  const [reg] = await api.listRegistrations(db);
  assert.equal(reg.data.discordTag, 'Zed');
  assert.equal((await api.bootstrap(db, { admin: false })).players.length, 0);
  await api.setRegistrationStatus(db, reg.id, 'approved');
  assert.equal((await api.bootstrap(db, { admin: false })).players[0].tag, 'Zed');
});

test('team update sets roster slots and rejects bad stream links', async () => {
  const db = await fresh();
  const team = await db.get('SELECT id FROM teams LIMIT 1');
  await assert.rejects(api.updateTeam(db, team.id, { stream_url: 'javascript:alert(1)' }), /stream link/);
  await api.updateTeam(db, team.id, { owner_coach: 'Coach K', stream_url: 'https://twitch.tv/x', roster: { PG: 'Ace', C: 'Big' } });
  const roster = (await api.bootstrap(db, { admin: false })).roster.filter(r => r.team_id === team.id && r.tag);
  assert.deepEqual(roster.map(r => r.tag).sort(), ['Ace', 'Big']);
});

test('one award vote per voter, changeable', async () => {
  const db = await fresh();
  await api.updateTeam(db, 1, { roster: { PG: 'Ace', SG: 'Blaze' } });
  const [ace, blaze] = (await api.bootstrap(db, { admin: false })).players;
  await api.vote(db, 'v1', { award: 'mvp', player_id: ace.id });
  await api.vote(db, 'v1', { award: 'mvp', player_id: blaze.id });
  await api.vote(db, 'v2', { award: 'mvp', player_id: blaze.id });
  const { tallies, mine } = await api.awards(db, 'v1');
  assert.deepEqual(tallies.map(t => [t.tag, t.votes]), [['Blaze', 2]]);
  assert.equal(mine.mvp, blaze.id);
});

test('rate limit counts per key inside the window', async () => {
  const db = await fresh();
  for (let i = 0; i < 3; i++) assert.equal(await api.rateLimit(db, 'login:1.2.3.4', 3, 900), true);
  assert.equal(await api.rateLimit(db, 'login:1.2.3.4', 3, 900), false);
  assert.equal(await api.rateLimit(db, 'login:5.6.7.8', 3, 900), true);
});

test('db/setup.sql is current and builds the same database on its own', async () => {
  const sql = buildSetupSql();
  const onDisk = readFileSync(new URL('../db/setup.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(onDisk, sql, 'run `npm run db:sql` to regenerate db/setup.sql');
  const lite = new PGlite();
  await lite.exec(sql);
  const n = async t => (await lite.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
  assert.equal(await n('teams'), 18);
  assert.equal(await n('series'), 199);
  assert.equal(await n('_migrations'), 2);
  await lite.close();
});

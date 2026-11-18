import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as api from '../src/api.js';
import { totals, derive, mergeByPlayer, rate, archetype, insights, highs } from '../public/js/profile.js';

const zero = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
const game = (extra = {}) => ({ ...zero, won: true, ...extra });
// A league row: per-game figures times the games played.
const peer = (player_id, gp, perGame) => ({ player_id, tag: `p${player_id}`, gp, ...zero, ...Object.fromEntries(Object.entries(perGame).map(([k, v]) => [k, v * gp])) });

test('profile maths: totals, percentages, merged league rows', () => {
  const t = totals([game({ pts: 20, fgm: 8, fga: 16, tpm: 2, tpa: 5, ftm: 2, fta: 2, ast: 6, tov: 3 }), game({ pts: 10, fgm: 4, fga: 9, ast: 2, tov: 1, ftm: 2, fta: 4 })]);
  const d = derive(t);
  assert.equal(t.gp, 2);
  assert.equal(d.ppg, 15);
  assert.equal(d.fg, 12 / 25);
  assert.equal(d.astTo, 2);
  assert.equal(d.threeShare, 6 / 30);
  assert.equal(derive(totals([])).fg, null, 'no attempts: no percentage');
  const merged = mergeByPlayer([{ player_id: 1, tag: 'a', gp: 2, ...zero, pts: 30 }, { player_id: 1, tag: 'a', gp: 1, ...zero, pts: 12 }, { player_id: 2, tag: 'b', gp: 1, ...zero }]);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].gp, merged[0].pts], [3, 42]);
});

test('archetype follows the two best skills and needs two games', () => {
  const peers = [
    peer(1, 6, { pts: 12, fgm: 5, fga: 11, ast: 3, reb: 4, stl: 1, blk: 0.5, tpm: 1, tpa: 3 }),
    peer(2, 6, { pts: 15, fgm: 6, fga: 13, ast: 4, reb: 5, stl: 1, blk: 0.5, tpm: 1, tpa: 3 }),
    peer(3, 6, { pts: 9, fgm: 4, fga: 9, ast: 2, reb: 6, stl: 1, blk: 1, tpm: 0, tpa: 1 }),
    peer(4, 6, { pts: 11, fgm: 4, fga: 10, ast: 5, reb: 3, stl: 1.5, blk: 0, tpm: 2, tpa: 5 }),
  ];
  // Passes and rebounds more than anyone, scores little.
  const me = { ...peer(9, 6, { pts: 6, fgm: 3, fga: 7, ast: 11, reb: 9, stl: 0.5, blk: 0 }) };
  const rated = rate(me, [...peers, me]);
  assert.equal(rated.compared, true);
  assert.equal(archetype(rated, 6).name, 'Glass-Cleaning Floor General');
  assert.equal(archetype(rated, 1), null);
  assert.ok(rated.overall >= 40 && rated.overall <= 99);
  for (const s of rated.skills) assert.ok(s.rating >= 40 && s.rating <= 99);
  // Alone in the league: still gets a name, from typical figures instead of rankings.
  const solo = rate(me, [me]);
  assert.equal(solo.compared, false);
  assert.equal(archetype(solo, 6).name, 'Glass-Cleaning Floor General');
});

test('insights: league rank, double-doubles, form, highs', () => {
  const peers = [1, 2, 3, 4, 5].map(i => peer(i, 6, { pts: 8 + i, fgm: 4, fga: 10, ast: 2, reb: 3 }));
  const games = [10, 12, 14, 30, 32, 34].map((pts, i) => game({ pts, reb: 11, ast: 3, fgm: pts / 2, fga: pts, won: i > 2, game_id: i + 1 }));
  const me = { ...totals(games), player_id: 9, tag: 'me' };
  const list = insights({ games, peers: [...peers, me], leagueName: 'Premier League', playerId: 9 });
  assert.ok(list.length <= 5);
  assert.ok(list.some(f => f.title === 'League leader' && /1st in the Premier League in points per game \(22\.0\)/.test(f.text)));
  assert.ok(list.some(f => /6 double-doubles in 6 games/.test(f.text)));
  assert.ok(list.some(f => f.title === 'Heating up'));
  assert.ok(list.some(f => f.title === '20+ point nights' && /3–0/.test(f.text)));
  assert.deepEqual(insights({ games: [], peers, leagueName: 'x', playerId: 9 }), []);
  const top = highs(games).find(h => h.key === 'pts');
  assert.deepEqual([top.value, top.game.game_id], [34, 6]);
  assert.equal(highs(games).some(h => h.key === 'blk'), false, 'stats that never happened are left out');
});

test('player photos: only the owner or the commissioner, versioned read, remove', async () => {
  const db = await connectLocal();
  const { id } = await db.get("INSERT INTO players (discord_tag, discord_id) VALUES ('shooter', '111') RETURNING id");
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const image = `data:image/png;base64,${png.toString('base64')}`;
  const owner = { commissioner: false, discordId: '111' }, stranger = { commissioner: false, discordId: '222' };
  await assert.rejects(api.savePlayerPhoto(db, id, stranger, { image }), /your own profile/);
  await assert.rejects(api.savePlayerPhoto(db, id, owner, { image: 'data:image/svg+xml;base64,PHN2Zz4=' }), /PNG, JPG or WebP/);
  await assert.rejects(api.savePlayerPhoto(db, id, owner, { image: `data:image/png;base64,${Buffer.alloc(api.PHOTO_MAX_BYTES + 1).toString('base64')}` }), /too large/);
  await assert.rejects(api.readPlayerPhoto(db, id, false), /No photo/);
  assert.equal((await api.savePlayerPhoto(db, id, owner, { image })).photo_version, 1);
  const photo = await api.readPlayerPhoto(db, id, true);
  assert.deepEqual([photo.mime, photo.data], ['image/png', png]);
  assert.match(photo.cache, /immutable/);
  assert.equal((await api.playerLog(db, id)).player.photo_version, 1);
  assert.equal((await api.savePlayerPhoto(db, id, { commissioner: true }, { image })).photo_version, 2);
  await assert.rejects(api.deletePlayerPhoto(db, id, stranger), /your own profile/);
  await api.deletePlayerPhoto(db, id, owner);
  await assert.rejects(api.readPlayerPhoto(db, id, true), /No photo/);
  assert.equal((await api.bootstrap(db, { admin: false })).players.find(p => p.id === id).photo_version, -2);
});

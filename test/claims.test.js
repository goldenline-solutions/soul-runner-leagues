import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { saveGame } from '../src/league.js';
import * as api from '../src/api.js';
import * as roster from '../src/roster.js';

const line = (side, tag, pts) => ({ side, tag, pts, fgm: 0, fga: 0 });
const id = async (db, tag) => (await db.get('SELECT id FROM players WHERE discord_tag = ?', tag))?.id;

// "DiscName" was signed in Discord (linked to account 500, on a roster). The same person's box
// scores were read under their in-game name, "InGame", which made a second, unclaimed record.
async function split() {
  const db = await connectLocal();
  const s = await db.get("SELECT * FROM series WHERE stage = 'regular' AND league_id = 'premier' ORDER BY id LIMIT 1");
  await api.updateTeam(db, s.home_team_id, { roster: { PG: 'DiscName' } });
  await db.run("UPDATE players SET discord_id = '500' WHERE discord_tag = 'DiscName'");
  for (const n of [1, 2]) {
    await saveGame(db, { series_id: s.id, game_number: n, home_score: 60, away_score: 50, box: [line('home', 'InGame', 20), line('away', 'Rival', 18)] });
  }
  const user = await db.get("INSERT INTO users (discord_id, discord_name) VALUES ('500', 'discname') RETURNING id");
  return { db, s, user, disc: await id(db, 'DiscName'), game: await id(db, 'InGame'), rival: await id(db, 'Rival') };
}

test('a profile can be claimed under a name that does not match the Discord name', async () => {
  const { db, rival } = await split();
  const user = await db.get("INSERT INTO users (discord_id, discord_name) VALUES ('600', 'totally-different') RETURNING id");
  const me = (await api.bootstrap(db, { admin: false, userId: user.id })).me;
  assert.deepEqual([me.player_id, me.suggest_id], [null, null], 'nothing matches by name');

  // The finder lists every unclaimed record with its games, so they can pick theirs.
  const found = await roster.claimCandidates(db);
  assert.deepEqual(found.map(p => [p.tag, p.games]), [['InGame', 2], ['Rival', 2]]);
  await roster.requestClaim(db, { discordId: '600', discordName: 'totally-different', playerId: rival });
  const [claim] = await roster.pendingClaims(db);
  assert.deepEqual([claim.tag, claim.games, claim.merge_id], ['Rival', 2, null]);
  await roster.decideClaim(db, { claimId: claim.id, approve: true });
  assert.equal((await api.bootstrap(db, { admin: false, userId: user.id })).me.player_id, rival);
  assert.deepEqual((await roster.claimCandidates(db)).map(p => p.tag), ['InGame']);
});

test('an account with a profile claims its second record, and approving merges the two', async () => {
  const { db, s, user, disc, game } = await split();
  await db.run("INSERT INTO player_aliases (player_id, alias) VALUES (?, 'OldSteam')", disc);
  await db.run("UPDATE players SET steam_tag = 'steam-500' WHERE id = ?", disc);
  await api.vote(db, 'voter-1', { award: 'mvp', player_id: disc });

  await roster.requestClaim(db, { discordId: '500', discordName: 'discname', playerId: game });
  let me = (await api.bootstrap(db, { admin: false, userId: user.id })).me;
  assert.deepEqual([me.player_id, me.pending_id], [disc, game]);
  const [claim] = await roster.pendingClaims(db);
  assert.deepEqual([claim.tag, claim.games, claim.merge_tag, claim.merge_games], ['InGame', 2, 'DiscName', 0]);

  const before = (await db.get('SELECT COUNT(*)::int AS n FROM players')).n;
  await roster.decideClaim(db, { claimId: claim.id, approve: true });
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM players')).n, before - 1);
  assert.equal(await id(db, 'DiscName'), undefined, 'the Discord-named record is gone');

  // One record now holds the account, the games, the roster spot, the names and the vote.
  const merged = await db.get('SELECT * FROM players WHERE id = ?', game);
  assert.deepEqual([merged.discord_id, merged.steam_tag, merged.free_agent], ['500', 'steam-500', false]);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM box_scores WHERE player_id = ?', game)).n, 2);
  // Both records sat on this team's roster (saving a box score adds its players): one spot is left.
  assert.deepEqual((await db.all('SELECT team_id FROM roster_slots WHERE player_id = ?', game)).map(r => r.team_id), [s.home_team_id]);
  assert.deepEqual((await db.all('SELECT alias FROM player_aliases WHERE player_id = ? ORDER BY lower(alias)', game)).map(a => a.alias), ['DiscName', 'OldSteam']);
  assert.equal((await db.get("SELECT player_id FROM award_votes WHERE voter_id = 'voter-1'")).player_id, game);
  me = (await api.bootstrap(db, { admin: false, userId: user.id })).me;
  assert.deepEqual([me.player_id, me.pending_id], [game, null]);

  // A later screenshot that shows the old name lands on the merged profile, not on a new record.
  const s2 = await db.get("SELECT * FROM series WHERE stage = 'regular' AND league_id = 'premier' AND id <> ? ORDER BY id LIMIT 1", s.id);
  await saveGame(db, { series_id: s2.id, game_number: 1, home_score: 40, away_score: 30, box: [line('home', 'DiscName', 12)] });
  assert.equal(await id(db, 'DiscName'), undefined);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM box_scores WHERE player_id = ?', game)).n, 3);
});

test('two records that played in the same game are two people and cannot be merged', async () => {
  const { db, rival } = await split();
  await db.run("UPDATE players SET discord_id = '700' WHERE discord_tag = 'InGame'");
  await assert.rejects(roster.requestClaim(db, { discordId: '700', discordName: 'x', playerId: rival }), /both played in the same game/);
  // A record someone else holds stays theirs.
  await assert.rejects(roster.requestClaim(db, { discordId: '500', discordName: 'discname', playerId: await id(db, 'InGame') }), /already claimed by another Discord account/);
});

// Player aliases: other names on a profile, matched by the screenshot reader and the box score form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as api from '../src/api.js';
import { playerIdForTag } from '../src/league.js';
import { matchPlayer, buildDraft } from '../src/ingest.js';

test('a profile owner adds aliases, and a box score name that is an alias finds their profile', async () => {
  const db = await connectLocal();
  const ace = await db.get("INSERT INTO players (discord_tag, discord_id, steam_tag) VALUES ('Ace', '111', 'AceOnSteam') RETURNING id");
  const bob = await db.get("INSERT INTO players (discord_tag, discord_id) VALUES ('Bob', '222') RETURNING id");
  const owner = { commissioner: false, discordId: '111' };

  // Only the profile's owner or a commissioner.
  await assert.rejects(api.addAlias(db, bob.id, owner, { alias: 'Sneaky' }), /only change your own profile/);
  await api.addAlias(db, ace.id, owner, { alias: 'xX_Ace_Xx' });
  await api.addAlias(db, bob.id, { commissioner: true }, { alias: 'Bobby' });

  // A name points at one player.
  await assert.rejects(api.addAlias(db, ace.id, owner, { alias: 'XX_ACE_XX' }), /already one of this profile's names/);
  await assert.rejects(api.addAlias(db, ace.id, owner, { alias: 'bobby' }), /already a name of Bob/);
  await assert.rejects(api.addAlias(db, ace.id, owner, { alias: 'bob' }), /already a name of Bob/);
  await assert.rejects(api.addAlias(db, ace.id, owner, { alias: '  ' }), /Alias is required/);

  const { aliases } = await api.playerLog(db, ace.id);
  assert.deepEqual(aliases.map(a => a.alias), ['xX_Ace_Xx']);

  // The box score form: the alias saves to the existing profile instead of making a new player.
  assert.equal(await playerIdForTag(db, 'xx_ace_xx', { steam: true }), ace.id);
  const before = (await db.get('SELECT COUNT(*)::int AS n FROM players')).n;
  assert.equal(await playerIdForTag(db, 'Bobby', { steam: true }), bob.id);
  assert.equal((await db.get('SELECT COUNT(*)::int AS n FROM players')).n, before);

  // The screenshot reader: exact on the alias, and close misreads of it on a roster.
  const players = [{ id: ace.id, discord_tag: 'Ace', steam_tag: 'AceOnSteam', aliases: ['xX_Ace_Xx'] }, { id: bob.id, discord_tag: 'Bob', steam_tag: '' }];
  assert.deepEqual(matchPlayer(players, 'XX_ACE_XX'), { player_id: ace.id, tag: 'Ace', how: 'exact', score: 100 });
  assert.equal(matchPlayer(players, 'xX_Ace_X', { roster: new Set([ace.id]) }).player_id, ace.id);
  const stats = { pts: 10, reb: 1, ast: 1, stl: 0, blk: 0, tov: 0, fouls: 0, fgm: 5, fga: 8, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
  const draft = await buildDraft(db, { game: { home_score: 10, away_score: 0 }, players: [{ side: 'HOME', row_index: 0, gamertag: 'xX_Ace_Xx', stats }] }, null);
  assert.equal(draft.lines[0].tag, 'Ace');

  // Removed aliases stop matching.
  await api.removeAlias(db, ace.id, owner, aliases[0].id);
  assert.notEqual(await playerIdForTag(db, 'xX_Ace_Xx', { steam: true }), ace.id);
});

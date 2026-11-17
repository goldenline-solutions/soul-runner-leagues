// Roster changes made in the site's roster editor reach Discord: roles and the transactions channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import * as api from '../src/api.js';
import { postMoves } from '../bot/roster.js';

test('a signing and a release saved on the site get roles and a message in Discord', async () => {
  const db = await connectLocal();
  const team = await db.get("SELECT id, name FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 1");
  await roster.setTeamRole(db, team.id, 'team-role');

  const roles = [], posts = [];
  const guild = { members: {
    addRole: async ({ user, role }) => { roles.push(`+${role} ${user}`); },
    removeRole: async ({ user, role }) => { roles.push(`-${role} ${user}`); },
  } };
  const client = {
    guilds: { cache: new Map([['g1', guild]]) },
    channels: { fetch: async id => ({ send: async p => { posts.push(`${id}: ${p.content}`); } }) },
  };
  const ctx = { db, guildId: 'g1', rosterChannelId: 'moves', freeAgentRoleId: 'fa-role' };

  // ann has a Discord account on record (she was a free agent); Typed is only a name typed on the site.
  await roster.addFreeAgent(db, { member: { id: '111', name: 'ann' } });
  await postMoves(client, ctx);
  assert.deepEqual(posts, []); // joining the free agent pool is not announced

  await api.updateTeam(db, team.id, { roster: { PG: 'ann', SG: 'Typed' } });
  assert.equal((await roster.freeAgents(db)).length, 0); // signed on the site: out of the pool
  await postMoves(client, ctx);
  assert.deepEqual(posts, [
    `moves: ✅ <@111> signed with **${team.name}** (on the website).`,
    `moves: ✅ **Typed** signed with **${team.name}** (on the website).`,
  ]);
  assert.deepEqual(roles, ['+team-role 111', '-fa-role 111']);

  // Saving again with ann in another slot is not a move. Nothing is posted twice.
  await api.updateTeam(db, team.id, { roster: { C: 'ann', SG: 'Typed' } });
  await postMoves(client, ctx);
  assert.equal(posts.length, 2);

  // Taken off the roster on the site: released, a free agent again, team role off.
  roles.length = 0;
  await api.updateTeam(db, team.id, { roster: { SG: 'Typed' } });
  await postMoves(client, ctx);
  assert.equal(posts.at(-1), `moves: <@111> was released by **${team.name}** and is now a free agent (on the website).`);
  assert.deepEqual(roles, ['-team-role 111', '+fa-role 111']);
  assert.deepEqual((await roster.freeAgents(db)).map(p => p.tag), ['ann']);

  // A /roster command is posted there too, without the website note.
  await roster.sign(db, { teamId: team.id, member: { id: '222', name: 'bob' }, by: '900' });
  await postMoves(client, ctx);
  assert.equal(posts.at(-1), `moves: ✅ <@222> signed with **${team.name}**.`);

  // The "Send to free agency" button: off the team at once, same result as a release.
  roles.length = 0;
  const bob = await db.get("SELECT id FROM players WHERE discord_id = '222'");
  await api.sendToFreeAgency(db, team.id, bob.id);
  await assert.rejects(api.sendToFreeAgency(db, team.id, bob.id), /not on this team/);
  await postMoves(client, ctx);
  assert.equal(posts.at(-1), `moves: <@222> was released by **${team.name}** and is now a free agent (on the website).`);
  assert.deepEqual(roles, ['-team-role 222', '+fa-role 222']);
});

test('an owner or captain set on the site gets the team role and the Owner / Captain role', async () => {
  const db = await connectLocal();
  const team = await db.get("SELECT id, name FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 1");
  await roster.setTeamRole(db, team.id, 'team-role');
  const roles = [], posts = [];
  const guild = { members: {
    addRole: async ({ user, role }) => { roles.push(`+${role} ${user}`); },
    removeRole: async ({ user, role }) => { roles.push(`-${role} ${user}`); },
  } };
  const client = { guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => ({ send: async p => { posts.push(p.content); } }) } };
  const ctx = { db, guildId: 'g1', rosterChannelId: 'moves', ownerRoleId: 'owner-role', captainRoleId: 'captain-role' };

  await api.updateTeam(db, team.id, { roster: { PG: 'Typed' } });
  const typed = await db.get("SELECT id FROM players WHERE discord_tag = 'Typed'");
  await assert.rejects(api.addTeamStaff(db, team.id, { player_id: typed.id, role: 'owner' }), /not linked to a Discord account/);
  await roster.addFreeAgent(db, { member: { id: '111', name: 'ann' } });
  const ann = await db.get("SELECT id, linked FROM (SELECT id, discord_id IS NOT NULL AS linked, discord_tag FROM players) p WHERE discord_tag = 'ann'");
  await assert.rejects(api.addTeamStaff(db, team.id, { player_id: ann.id, role: 'boss' }), /owner or captain/);
  await postMoves(client, ctx);
  posts.length = 0;

  assert.deepEqual(await api.addTeamStaff(db, team.id, { player_id: ann.id, role: 'captain' }), [{ discord_id: '111', discord_name: 'ann', role: 'captain' }]);
  await postMoves(client, ctx);
  assert.deepEqual(roles, ['+team-role 111', '-owner-role 111', '+captain-role 111']);

  roles.length = 0;
  assert.deepEqual(await api.removeTeamStaff(db, team.id, '111'), []);
  await postMoves(client, ctx);
  assert.deepEqual(roles, ['-team-role 111', '-owner-role 111', '-captain-role 111']);
  assert.deepEqual(posts, []); // staff changes are not transactions
});

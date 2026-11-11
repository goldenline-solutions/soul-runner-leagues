// Roster management: one team per league, free agents, the move log, Discord roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import * as api from '../src/api.js';
import rosterBot from '../bot/roster.js';

// Two teams in one league and one team in the other.
async function setup() {
  const db = await connectLocal();
  const [a, b] = await db.all("SELECT id, name, league_id FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 2");
  const other = await db.get("SELECT id, name, league_id FROM teams WHERE league_id = 'affiliate' ORDER BY id LIMIT 1");
  return { db, a, b, other };
}
const ann = { id: '111', name: 'ann' };
const bob = { id: '222', name: 'bob' };
const slotsOf = async (db, teamId) => Object.fromEntries((await roster.teamRoster(db, teamId)).slots.map(s => [s.slot, s.tag ?? null]));

test('a player signs with one team per league, never two in the same league', async () => {
  const { db, a, b, other } = await setup();
  const signed = await roster.sign(db, { teamId: a.id, member: ann, by: '999' });
  assert.equal(signed.slot, 'PG'); // first empty slot
  assert.equal((await slotsOf(db, a.id)).PG, 'ann');

  await assert.rejects(roster.sign(db, { teamId: a.id, member: ann }), /already on/);
  await assert.rejects(roster.sign(db, { teamId: b.id, member: ann }), new RegExp(`already signed to ${a.name} .*Use /roster move`));
  assert.equal((await roster.sign(db, { teamId: other.id, member: ann, slot: 'C' })).slot, 'C'); // the other league is fine

  // A taken slot and a full roster are refused.
  await assert.rejects(roster.sign(db, { teamId: a.id, member: bob, slot: 'PG' }), /PG slot is taken/);
  for (let n = 0; n < 6; n++) await roster.sign(db, { teamId: a.id, member: { id: `30${n}`, name: `filler${n}` } });
  await assert.rejects(roster.sign(db, { teamId: a.id, member: bob }), /roster is full \(7 players\)/);

  const moves = await db.all('SELECT action, to_team_id, by_discord_id FROM roster_moves ORDER BY id LIMIT 1');
  assert.deepEqual(moves, [{ action: 'sign', to_team_id: a.id, by_discord_id: '999' }]);
});

test('signing links an existing player record by name instead of making a second one', async () => {
  const { db, a } = await setup();
  await db.run("INSERT INTO players (discord_tag) VALUES ('Ann')");
  const { player } = await roster.sign(db, { teamId: a.id, member: ann });
  assert.equal(player.discord_tag, 'Ann');
  assert.equal(player.discord_id, '111');
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM players WHERE lower(discord_tag) = 'ann'")).n, 1);
  // Someone else with the same name can't take over that record.
  await assert.rejects(roster.sign(db, { teamId: a.id, member: { id: '555', name: 'ANN' } }), /belongs to a different Discord account/);
});

test('release frees the slot and makes a free agent; signing takes them out of the pool', async () => {
  const { db, a, b, other } = await setup();
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-a', a.id);
  await roster.sign(db, { teamId: a.id, member: ann });
  await roster.sign(db, { teamId: other.id, member: ann });

  await assert.rejects(roster.release(db, { member: ann }), /Say which team/);
  const first = await roster.release(db, { member: ann, teamId: a.id });
  assert.deepEqual([first.freeAgent, first.roles.remove], [false, ['role-a']]); // still on the other league's team
  const second = await roster.release(db, { member: ann });
  assert.equal(second.freeAgent, true);
  assert.deepEqual((await roster.freeAgents(db)).map(p => p.tag), ['ann']);
  await assert.rejects(roster.release(db, { member: ann }), /not on any roster/);

  await assert.rejects(roster.addFreeAgent(db, { member: ann }), /already a free agent/);
  await roster.addFreeAgent(db, { member: bob });
  assert.equal((await roster.freeAgents(db)).length, 2);
  const back = await roster.sign(db, { teamId: b.id, member: ann });
  assert.equal(back.roles.freeAgent, false);
  assert.deepEqual((await roster.freeAgents(db)).map(p => p.tag), ['bob']);
  await assert.rejects(roster.addFreeAgent(db, { member: ann }), /Release them first/);
});

test('move changes teams inside a league in one step, or changes the slot', async () => {
  const { db, a, b } = await setup();
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-a', a.id);
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-b', b.id);
  await assert.rejects(roster.move(db, { member: ann, teamId: b.id }), /no .* team to move from/);
  await roster.sign(db, { teamId: a.id, member: ann });

  const moved = await roster.move(db, { member: ann, teamId: b.id, slot: 'SG' });
  assert.deepEqual([moved.from.name, moved.team.name, moved.slot], [a.name, b.name, 'SG']);
  assert.deepEqual(moved.roles, { add: ['role-b'], remove: ['role-a'], freeAgent: false });
  assert.equal((await slotsOf(db, a.id)).PG, null);
  assert.equal((await slotsOf(db, b.id)).SG, 'ann');

  const reslot = await roster.move(db, { member: ann, teamId: b.id, slot: 'C' });
  assert.deepEqual([reslot.roles.add, reslot.roles.remove], [[], []]);
  assert.deepEqual([(await slotsOf(db, b.id)).SG, (await slotsOf(db, b.id)).C], [null, 'ann']);
  await assert.rejects(roster.move(db, { member: ann, teamId: b.id }), /already on/);
});

test('the site roster editor follows the same rule', async () => {
  const { db, a, b, other } = await setup();
  await roster.sign(db, { teamId: a.id, member: ann });
  await assert.rejects(api.updateTeam(db, b.id, { roster: { PG: 'ANN' } }), new RegExp(`already on ${a.name}`));
  await assert.rejects(api.updateTeam(db, b.id, { roster: { PG: 'zed', SG: 'Zed' } }), /two slots/);
  await api.updateTeam(db, other.id, { roster: { PG: 'ann' } }); // other league: allowed
  await api.updateTeam(db, a.id, { roster: { SG: 'ann' } });     // same team, new slot: allowed
  assert.equal((await slotsOf(db, a.id)).SG, 'ann');
});

test('link connects a member to an existing record, and audit lists what needs fixing', async () => {
  const { db, a, b } = await setup();
  await api.updateTeam(db, a.id, { roster: { PG: 'OldTag' } }); // typed on the site: no Discord account
  // A double signing from before the rule existed.
  await db.run("UPDATE roster_slots SET player_id = (SELECT id FROM players WHERE discord_tag = 'OldTag') WHERE team_id = ? AND slot = 'PG'", b.id);

  let report = await roster.audit(db);
  assert.equal(report.problems.length, 3);
  assert.match(report.problems[2], /no Discord role/);
  assert.match(report.problems[0], /OldTag is on two teams in one league/);
  assert.match(report.problems[1], /not linked to a Discord account.*OldTag/);

  const record = await db.get("SELECT id FROM players WHERE discord_tag = 'OldTag'");
  await db.run("UPDATE roster_slots SET player_id = NULL WHERE team_id = ? AND slot = 'PG'", b.id);
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-a', a.id);
  const linked = await roster.link(db, { member: ann, playerId: record.id });
  assert.deepEqual(linked.roles.add, ['role-a']);
  await assert.rejects(roster.link(db, { member: bob, playerId: record.id }), /already linked to another/);

  report = await roster.audit(db);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.members, [{ tag: 'OldTag', discord_id: '111', freeAgent: false, roleIds: ['role-a'], owner: false, captain: false }]);
});

// ---------- Discord ----------

test('/roster in Discord: commissioners only, roles follow the roster, sync repairs drift', async () => {
  const { db, a, b } = await setup();
  const calls = [];
  const held = { 111: new Set(['stale-role']) }; // roles each member holds, by Discord id
  const guild = {
    members: {
      addRole: async ({ user, role }) => { if (role === 'broken') throw new Error('Missing Permissions'); calls.push(`+${role}`); (held[user] ??= new Set()).add(role); },
      removeRole: async ({ user, role }) => { calls.push(`-${role}`); held[user]?.delete(role); },
      list: async () => new Map(), // nobody else in the server holds the free agent role
      fetch: async id => (held[id] ? { roles: { cache: { has: r => held[id].has(r) } } } : Promise.reject(new Error('Unknown Member'))),
    },
  };
  const ctx = { db, freeAgentRoleId: 'fa-role' };
  const run = async (sub, options = {}, admin = true) => {
    const said = [];
    await rosterBot.handle({
      guild, user: { id: '999', username: 'commish' }, memberPermissions: { has: () => admin },
      isAutocomplete: () => false,
      options: {
        getSubcommand: () => sub, getString: k => options[k] ?? null, getUser: () => options.user, getMember: () => null,
        getRole: () => ({ id: options.role }),
      },
      deferReply: async function defer() { this.deferred = true; },
      editReply: async p => { said.push(p.content); },
      reply: async p => { said.push(p.content); },
    }, ctx);
    return said.join('\n');
  };
  const user = { id: '111', username: 'ann' };

  assert.match(await run('sign', { team: String(a.id), user }, false), /only do that for a team you own or captain/);
  assert.match(await run('setrole', { team: String(a.id), role: 'role-a' }, false), /Only a commissioner/);
  assert.match(await run('setrole', { team: String(a.id), role: 'role-a' }), /players now get <@&role-a>/);
  await run('setrole', { team: String(b.id), role: 'role-b' });

  assert.match(await run('sign', { team: String(a.id), user }), new RegExp(`<@111> signed with \\*\\*${a.name}\\*\\* \\(PG\\)`));
  assert.deepEqual(calls.splice(0), ['+role-a', '-fa-role']);
  assert.match(await run('sign', { team: String(b.id), user }), /already signed to/);
  assert.deepEqual(calls, []); // a refused signing touches no roles

  assert.match(await run('move', { team: String(b.id), user }), /moved from/);
  assert.deepEqual(calls.splice(0), ['+role-b', '-role-a', '-fa-role']);
  assert.match(await run('view', { team: String(b.id) }, false), /`PG ` ann <@111>/);

  assert.match(await run('release', { user }), /released by .* and is now a free agent/);
  assert.deepEqual(calls.splice(0), ['-role-b', '+fa-role']);
  assert.match(await run('freeagents', {}, false), /Free agents \(1\)\*\*\n• <@111>/);

  // A role the bot can't give: the signing stands, with a warning.
  await run('setrole', { team: String(a.id), role: 'broken' });
  assert.match(await run('sign', { team: String(a.id), user }), /signed with[\s\S]*Could not add <@&broken>: Missing Permissions[\s\S]*\/roster sync/);
  calls.splice(0);

  // Sync: ann should hold only team A's role. The stale role is not a managed role, so it is left alone.
  await run('setrole', { team: String(a.id), role: 'role-a' });
  held[111].add('role-b');
  assert.match(await run('sync'), /Checked 1 members\. Roles fixed for 1\.\nNo problems found\./);
  assert.deepEqual(calls.splice(0), ['+role-a', '-role-b']);
  assert.deepEqual([...held[111]].sort(), ['role-a', 'stale-role']);
  assert.match(await run('sync'), /Roles fixed for 0/);

  // The free agent role given by hand: taken off a rostered player, but a player with no team
  // who holds it joins the pool and keeps it.
  held[111].add('fa-role');
  await run('sync');
  assert.deepEqual(calls.splice(0), ['-fa-role']);
  await run('release', { user });
  await db.run('UPDATE players SET free_agent = false');
  calls.splice(0);
  assert.match(await run('sync'), /Roles fixed for 0\. Added 1 to the free agent pool/);
  assert.deepEqual(calls, []);
  assert.deepEqual((await roster.freeAgents(db)).map(p => p.tag), ['ann']);
});

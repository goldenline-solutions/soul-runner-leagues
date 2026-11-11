// Roster permissions: commissioners do everything; a team's owners and captains can sign free
// agents to, release from, and re-slot players on their own team only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import rosterBot from '../bot/roster.js';

async function setup() {
  const db = await connectLocal();
  const [a, b] = await db.all("SELECT id, name FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 2");
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-a', a.id);
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'role-b', b.id);
  return { db, a, b };
}
const cap = { id: '700', name: 'cap' };
const ann = { id: '111', name: 'ann' };
const bob = { id: '222', name: 'bob' };
const asCap = { commissioner: false, discordId: cap.id };

test('a captain signs free agents to their own team only', async () => {
  const { db, a, b } = await setup();
  await roster.setStaff(db, { teamId: a.id, member: cap, role: 'captain' });

  // Not in the pool: commissioner only. Nothing is left behind by the refusal.
  await assert.rejects(roster.sign(db, { teamId: a.id, member: ann, actor: asCap }), /not in the free agent pool/);
  assert.equal((await db.get("SELECT COUNT(*)::int AS n FROM players WHERE discord_id = '111'")).n, 0);

  await roster.addFreeAgent(db, { member: ann });
  await assert.rejects(roster.sign(db, { teamId: b.id, member: ann, actor: asCap }), new RegExp(`${b.name} is not one`));
  assert.equal((await roster.sign(db, { teamId: a.id, member: ann, actor: asCap })).slot, 'PG');
  // The one-team-per-league rule still applies to everyone.
  await roster.sign(db, { teamId: b.id, member: bob });
  await assert.rejects(roster.sign(db, { teamId: a.id, member: bob, actor: asCap }), /already signed to/);
});

test('a captain releases and re-slots their own players, but cannot trade or touch other teams', async () => {
  const { db, a, b } = await setup();
  await roster.setStaff(db, { teamId: a.id, member: cap, role: 'owner' });
  await roster.sign(db, { teamId: a.id, member: ann });
  await roster.sign(db, { teamId: b.id, member: bob });

  assert.equal((await roster.move(db, { member: ann, teamId: a.id, slot: 'C', actor: asCap })).slot, 'C');
  await assert.rejects(roster.move(db, { member: ann, teamId: b.id, actor: asCap }), /trade: only a commissioner/);
  await assert.rejects(roster.move(db, { member: bob, teamId: b.id, slot: 'C', actor: asCap }), /is not one/);
  await assert.rejects(roster.release(db, { member: bob, actor: asCap }), /is not one/);
  assert.equal((await roster.release(db, { member: ann, actor: asCap })).freeAgent, true);
});

test('staff keep the team role when they leave the roster; Owner and Captain roles follow positions', async () => {
  const { db, a, b } = await setup();
  const made = await roster.setStaff(db, { teamId: a.id, member: cap, role: 'captain' });
  assert.deepEqual(made.roles, { add: ['role-a'], remove: [], owner: false, captain: true });
  await roster.sign(db, { teamId: a.id, member: cap });
  assert.deepEqual((await roster.release(db, { member: cap })).roles.remove, []); // still captain: keeps role-a

  // Captain of two teams, then removed from one: still a captain overall.
  await roster.setStaff(db, { teamId: b.id, member: cap, role: 'captain' });
  const off = await roster.setStaff(db, { teamId: a.id, member: cap, role: null });
  assert.deepEqual(off.roles, { add: [], remove: ['role-a'], owner: false, captain: true });
  const promoted = await roster.setStaff(db, { teamId: b.id, member: cap, role: 'owner' });
  assert.deepEqual([promoted.roles.owner, promoted.roles.captain], [true, false]);
  await assert.rejects(roster.setStaff(db, { teamId: a.id, member: cap, role: null }), /not an owner or captain/);

  // An owner who is not a player still shows up for /roster sync.
  const { members } = await roster.audit(db);
  assert.deepEqual(members.find(m => m.discord_id === '700'), { tag: 'cap', discord_id: '700', freeAgent: true, roleIds: ['role-b'], owner: true, captain: false });
  assert.deepEqual((await roster.teamRoster(db, b.id)).staff.map(s => [s.discord_name, s.role]), [['cap', 'owner']]);
});

test('/roster in Discord: commissioner role, captain limits, staff roles', async () => {
  const { db, a, b } = await setup();
  const calls = [];
  const guild = { members: {
    addRole: async ({ user, role }) => { calls.push(`${user}+${role}`); },
    removeRole: async ({ user, role }) => { calls.push(`${user}-${role}`); },
  } };
  const ctx = { db, commissionerRoleId: 'commish-role', ownerRoleId: 'owner-role', captainRoleId: 'captain-role', freeAgentRoleId: 'fa-role' };
  // `as` is who runs the command: their Discord id and the roles they hold. Nobody has Manage Server.
  const run = async (as, sub, options = {}) => {
    const said = [];
    await rosterBot.handle({
      guild, user: { id: as.id, username: as.name }, memberPermissions: { has: () => false },
      member: { roles: { cache: new Set(as.roles ?? []) } },
      isAutocomplete: () => false,
      options: { getSubcommand: () => sub, getString: k => options[k] ?? null, getUser: () => options.user },
      reply: async p => { said.push(p.content); },
    }, ctx);
    return said.join('\n');
  };
  const commish = { id: '900', name: 'commish', roles: ['commish-role'] };
  const captain = { id: cap.id, name: cap.name };
  const user = m => ({ id: m.id, username: m.name });

  // The commissioner role is enough: no Manage Server needed.
  assert.match(await run(captain, 'staff', { team: String(a.id), user: user(cap), position: 'captain' }), /Only a commissioner/);
  assert.match(await run(commish, 'staff', { team: String(a.id), user: user(cap), position: 'captain' }), /<@700> is now a captain of/);
  assert.deepEqual(calls.splice(0), ['700+role-a', '700-owner-role', '700+captain-role']);
  assert.match(await run({ id: '1', name: 'nobody' }, 'view', { team: String(a.id) }), /Owner: - · Captain: <@700>/);

  // The captain: free agents only, own team only, no commissioner commands.
  assert.match(await run(captain, 'sign', { team: String(a.id), user: user(ann) }), /not in the free agent pool/);
  assert.match(await run(captain, 'freeagent', { user: user(ann) }), /Only a commissioner/);
  assert.match(await run(commish, 'freeagent', { user: user(ann) }), /is now a free agent/);
  calls.splice(0);
  assert.match(await run(captain, 'sign', { team: String(b.id), user: user(ann) }), /is not one/);
  assert.match(await run(captain, 'sign', { team: String(a.id), user: user(ann) }), /<@111> signed with/);
  assert.deepEqual(calls.splice(0), ['111+role-a', '111-fa-role']);
  assert.match(await run(captain, 'release', { user: user(ann) }), /released by .* now a free agent/);

  assert.match(await run(commish, 'staff', { team: String(a.id), user: user(cap), position: 'remove' }), /no longer an owner or captain/);
  assert.deepEqual(calls.splice(0).slice(-3), ['700-role-a', '700-owner-role', '700-captain-role']);
  assert.match(await run(captain, 'sign', { team: String(a.id), user: user(ann) }), /is not one/);
});

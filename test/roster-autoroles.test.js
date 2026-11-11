// /roster autoroles: matching Discord roles to teams and to the server-wide roles by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import rosterBot from '../bot/roster.js';

const team = (id, name) => ({ id, name });
const role = (id, name) => ({ id, name });

test('matchTeamRoles pairs by name and refuses to guess', () => {
  const teams = [team(1, 'Bangladesh'), team(2, 'Night Owls'), team(3, 'Wolves'), team(4, 'Wolves II'), team(5, 'Kings'), team(6, 'Aces')];
  const roles = [
    role('r1', 'bangladesh'),            // exact, ignoring case
    role('r2', 'Team Night-Owls 🦉'),     // contains the team name
    role('r3', 'Wolves'),                // exact for Wolves; also inside "Wolves II"
    role('r4', 'Kings PG'), role('r5', 'Kings Fan'), // two candidates for Kings
    role('r6', 'Moderator'),
  ];
  const { matched, unsure, none } = roster.matchTeamRoles(teams, roles);
  assert.deepEqual(matched.map(m => [m.team.name, m.role.id]), [['Bangladesh', 'r1'], ['Night Owls', 'r2']]);
  // "Wolves" could belong to either Wolves team, and Kings has two roles: left for a person.
  assert.deepEqual(unsure.map(u => [u.team.name, u.roles.map(r => r.id)]), [['Wolves', ['r3']], ['Wolves II', ['r3']], ['Kings', ['r4', 'r5']]]);
  assert.deepEqual(none.map(t => t.name), ['Aces']);
});

test('/roster autoroles sets team and server-wide roles, keeps what was set, and the saved roles take effect', async () => {
  const db = await connectLocal();
  const [a, b, c] = await db.all("SELECT id, name FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 3");
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', 'kept', c.id); // set by hand earlier

  const guildRoles = new Map([
    ['guild', { id: 'guild', name: '@everyone', managed: false }],
    ['ra', { id: 'ra', name: a.name.toUpperCase(), managed: false }],
    ['rb', { id: 'rb', name: `Team ${b.name}`, managed: false }],
    ['rc', { id: 'rc', name: c.name, managed: false }],          // team c already has a role: untouched
    ['bot', { id: 'bot', name: a.name, managed: true }],          // another bot's role: ignored
    ['com', { id: 'com', name: 'Commissioner', managed: false }],
    ['fa', { id: 'fa', name: 'Free Agents', managed: false }],
    ['own1', { id: 'own1', name: 'Team Owner', managed: false }],
    ['own2', { id: 'own2', name: 'Co-Owner', managed: false }],   // two owner roles: not guessed
  ]);
  const calls = [];
  const guild = {
    id: 'guild', roles: { fetch: async () => guildRoles },
    members: { addRole: async ({ user, role: r }) => { calls.push(`${user}+${r}`); }, removeRole: async ({ user, role: r }) => { calls.push(`${user}-${r}`); } },
  };
  const run = async (as, sub, options = {}) => {
    const said = [];
    await rosterBot.handle({
      guild, user: { id: as.id, username: as.name }, memberPermissions: { has: () => Boolean(as.admin) },
      member: { roles: { cache: new Set(as.roles ?? []) } },
      isAutocomplete: () => false,
      options: { getSubcommand: () => sub, getString: k => options[k] ?? null, getUser: () => options.user, getMember: () => ({ roles: { cache: new Set() } }) },
      deferReply: async function defer() { this.deferred = true; },
      editReply: async p => { said.push(p.content); },
      reply: async p => { said.push(p.content); },
    }, { db }); // nothing set in .env
    return said.join('\n');
  };
  const admin = { id: '900', name: 'admin', admin: true };
  const viaRole = { id: '901', name: 'viarole', roles: ['com'] };

  // Before the scan, the Commissioner role means nothing to the bot.
  assert.match(await run(viaRole, 'freeagent', { user: { id: '111', username: 'ann' } }), /Only a commissioner/);

  const reply = await run(admin, 'autoroles');
  assert.match(reply, /Scanned 7 roles\. 2 team roles set now, 1 were already set\./);
  assert.match(reply, new RegExp(`\\*\\*${a.name}\\*\\* → <@&ra>`));
  assert.match(reply, new RegExp(`\\*\\*${b.name}\\*\\* → <@&rb>`));
  assert.match(reply, /Commissioner role → <@&com>/);
  assert.match(reply, /Free agent role → <@&fa>/);
  assert.match(reply, /Owner role: <@&own1>, <@&own2> \(set it in \.env\)/);
  assert.match(reply, /No role found for:\*\* captain/);

  const set = await db.all('SELECT id, discord_role_id FROM teams WHERE id IN (?, ?, ?) ORDER BY id', a.id, b.id, c.id);
  assert.deepEqual(set.map(t => t.discord_role_id), ['ra', 'rb', 'kept']);
  assert.deepEqual(await roster.savedRoles(db), { commissioner: 'com', freeAgent: 'fa' });

  // The saved roles now work with nothing in .env: the Commissioner role grants access,
  // and the free agent role is handed out.
  assert.match(await run(viaRole, 'freeagent', { user: { id: '111', username: 'ann' } }), /is now a free agent/);
  assert.deepEqual(calls.splice(0), ['111+fa']);
  assert.match(await run(viaRole, 'sign', { team: String(a.id), user: { id: '111', username: 'ann' } }), /signed with/);
  assert.deepEqual(calls.splice(0), ['111+ra', '111-fa']);

  // A second scan changes nothing.
  assert.match(await run(admin, 'autoroles'), /0 team roles set now, 3 were already set/);
});

// /roster freeagents: members holding the free agent role in Discord show up in the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import rosterBot from '../bot/roster.js';

// `name` is the account username; the server profile name is "<Name> | SR".
const nick = name => `${name[0].toUpperCase()}${name.slice(1)} | SR`;
// Roles are given by name; a role's id is its name, as far as this fake server goes.
const guildMember = (id, name, roles, bot = false) => ({
  user: { id, username: name, bot }, displayName: nick(name), roles: { cache: new Map(roles.map(r => [r, { name: r }])) },
});

async function setup(list) {
  const db = await connectLocal();
  const guild = { members: { list, addRole: async () => {}, removeRole: async () => {} } };
  const run = async sub => {
    const said = [];
    await rosterBot.handle({
      guild, user: { id: '900', username: 'viewer' }, memberPermissions: { has: () => false }, member: { roles: { cache: new Set() } },
      isAutocomplete: () => false, options: { getSubcommand: () => sub, getString: () => null },
      deferReply: async function defer() { this.deferred = true; },
      editReply: async p => { said.push([p.embeds?.[0]?.title, p.embeds?.[0]?.description, p.content].filter(Boolean).join('\n')); },
      reply: async p => { said.push(p.content); },
    }, { db, freeAgentRoleId: 'fa-role' });
    return said.join('\n');
  };
  return { db, run };
}

test('members holding the free agent role are listed, even though nobody ran /roster freeagent', async () => {
  const members = [
    guildMember('111', 'ann', ['fa-role', 'PG', 'sg']),   // two positions: listed under both
    guildMember('222', 'bob', ['fa-role', 'C', 'other']),
    guildMember('666', 'eve', ['fa-role']),               // no position role
    guildMember('333', 'cy', ['other']),            // no free agent role
    guildMember('444', 'helper-bot', ['fa-role'], true), // a bot
    guildMember('555', 'dee', ['fa-role']),         // holds the role but is on a roster
  ];
  const { db, run } = await setup(async () => new Map(members.map(m => [m.user.id, m])));
  const team = await db.get('SELECT id FROM teams ORDER BY id LIMIT 1');
  await roster.sign(db, { teamId: team.id, member: { id: '555', name: 'dee' } });

  const reply = await run('freeagents'); // anyone can run it
  // Grouped by position role, with server profile names (not usernames, not mentions).
  assert.equal(reply, [
    'Free agents (3)',
    '**PG:**\nAnn | SR', '',
    '**SG:**\nAnn | SR', '',
    '**LOCK:**\n-', '',
    '**BACKEND:**\n-', '',
    '**C:**\nBob | SR', '',
    '**No position role:**\nEve | SR',
  ].join('\n'));
  assert.ok(!reply.includes('Cy | SR') && !reply.includes('Helper-bot') && !reply.includes('Dee | SR'));
  assert.match(await run('freeagents'), /^Free agents \(3\)/); // running it again adds nobody twice

  // bob leaves the server: he drops out of the pool instead of showing as an unknown user.
  members.splice(1, 1);
  const after = await run('freeagents');
  assert.match(after, /^Free agents \(2\)/);
  assert.ok(!after.includes('Bob'));

  // A commissioner can also take someone out by hand.
  await roster.removeFreeAgent(db, { discordId: '111', by: '900' });
  await assert.rejects(roster.removeFreeAgent(db, { discordId: '111' }), /not in the free agent pool/);
  assert.deepEqual((await db.all("SELECT action FROM roster_moves WHERE action = 'free_agent_removed'")).length, 2);
});

test('when Discord will not hand over the member list, the pool is shown with how to fix it', async () => {
  const { db, run } = await setup(async () => { throw new Error('Missing Access'); });
  await roster.addFreeAgent(db, { member: { id: '111', name: 'ann' } });
  const reply = await run('freeagents');
  assert.match(reply, /Free agents \(1\)/);
  assert.match(reply, /Could not read who holds <@&fa-role> \(Missing Access\)[\s\S]*Server Members Intent/);
});

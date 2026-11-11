// /roster freeagents: members holding the free agent role in Discord show up in the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import * as roster from '../src/roster.js';
import rosterBot from '../bot/roster.js';

const guildMember = (id, name, roles, bot = false) => ({ user: { id, username: name, bot }, roles: { cache: new Set(roles) } });

async function setup(list) {
  const db = await connectLocal();
  const guild = { members: { list, addRole: async () => {}, removeRole: async () => {} } };
  const run = async sub => {
    const said = [];
    await rosterBot.handle({
      guild, user: { id: '900', username: 'viewer' }, memberPermissions: { has: () => false }, member: { roles: { cache: new Set() } },
      isAutocomplete: () => false, options: { getSubcommand: () => sub, getString: () => null },
      deferReply: async function defer() { this.deferred = true; },
      editReply: async p => { said.push(p.content); },
      reply: async p => { said.push(p.content); },
    }, { db, freeAgentRoleId: 'fa-role' });
    return said.join('\n');
  };
  return { db, run };
}

test('members holding the free agent role are listed, even though nobody ran /roster freeagent', async () => {
  const members = [
    guildMember('111', 'ann', ['fa-role']),
    guildMember('222', 'bob', ['fa-role', 'other']),
    guildMember('333', 'cy', ['other']),            // no free agent role
    guildMember('444', 'helper-bot', ['fa-role'], true), // a bot
    guildMember('555', 'dee', ['fa-role']),         // holds the role but is on a roster
  ];
  const { db, run } = await setup(async () => new Map(members.map(m => [m.user.id, m])));
  const team = await db.get('SELECT id FROM teams ORDER BY id LIMIT 1');
  await roster.sign(db, { teamId: team.id, member: { id: '555', name: 'dee' } });

  const reply = await run('freeagents'); // anyone can run it
  assert.match(reply, /^\*\*Free agents \(2\)\*\*/);
  assert.ok(reply.includes('<@111>') && reply.includes('<@222>'));
  assert.ok(!reply.includes('<@333>') && !reply.includes('<@444>') && !reply.includes('<@555>'));
  assert.match(await run('freeagents'), /^\*\*Free agents \(2\)\*\*/); // running it again adds nobody twice
});

test('when Discord will not hand over the member list, the pool is shown with how to fix it', async () => {
  const { db, run } = await setup(async () => { throw new Error('Missing Access'); });
  await roster.addFreeAgent(db, { member: { id: '111', name: 'ann' } });
  const reply = await run('freeagents');
  assert.match(reply, /Free agents \(1\)/);
  assert.match(reply, /Could not read who holds <@&fa-role> \(Missing Access\)[\s\S]*Server Members Intent/);
});

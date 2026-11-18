import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import { createApp } from '../src/app.js';

// A site whose Discord server "g" has these roles. `members` maps a Discord id to the role ids
// that person holds right now; the login code doubles as the Discord id of whoever logs in.
async function site({ botToken = false } = {}) {
  const db = await connectLocal();
  const [teamA, teamB] = await db.all("SELECT id, name FROM teams WHERE league_id = 'premier' ORDER BY id LIMIT 2");
  await db.run("UPDATE teams SET discord_role_id = 'r-team-a' WHERE id = ?", teamA.id);
  await db.run("UPDATE teams SET discord_role_id = 'r-team-b' WHERE id = ?", teamB.id);
  const members = new Map([['boss', ['r-comm']], ['owner', ['r-own', 'r-team-a']], ['player', ['r-team-a']], ['fan', []]]);
  const json = (ok, data) => ({ ok, status: ok ? 200 : 404, json: async () => data });
  const fetchImpl = async (url, init) => {
    const u = String(url), who = init.headers?.Authorization?.slice(7);
    if (u.endsWith('/oauth2/token')) return json(true, { access_token: init.body.get('code') });
    if (u.endsWith('/users/@me')) return json(true, { id: who, username: `name-${who}` });
    if (u.endsWith('/users/@me/guilds/g/member')) return members.has(who) ? json(true, { roles: members.get(who) }) : json(false, {});
    const bot = /\/guilds\/g\/members\/(.+)$/.exec(u); // the bot-token lookup
    if (bot) return members.has(bot[1]) ? json(true, { roles: members.get(bot[1]) }) : json(false, {});
    throw new Error(`unexpected request to ${u}`);
  };
  const env = {
    SESSION_SECRET: 's', ADMIN_PASSWORD: 'pw', DISCORD_CLIENT_ID: 'client', DISCORD_CLIENT_SECRET: 'secret', SITE_URL: 'https://league.test/',
    DISCORD_GUILD_ID: 'g', COMMISSIONER_ROLE_ID: 'r-comm', OWNER_ROLE_ID: 'r-own', ...(botToken ? { DISCORD_TOKEN: 'bot' } : {}),
  };
  const server = createServer(createApp({ db, env, fetchImpl }).handle);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { cookie = '', body } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const cookies = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { status: res.status, location: res.headers.get('location'), cookies, json: res.status === 302 ? null : await res.json() };
  };
  const login = async discordId => {
    const start = await call('GET', '/api/auth/discord');
    const state = new URL(start.location).searchParams.get('state');
    return (await call('GET', `/api/auth/discord/callback?code=${discordId}&state=${state}`, { cookie: start.cookies })).cookies;
  };
  const me = async cookie => (await call('GET', '/api/bootstrap', { cookie })).json.me;
  const age = (discordId, interval) => db.run(`UPDATE users SET roles_checked_at = now() - interval '${interval}' WHERE discord_id = ?`, discordId);
  return { db, teamA, teamB, members, call, login, me, age, close: () => server.close() };
}

test('the Commissioner role in Discord gives commissioner access on the site', async () => {
  const { call, login, me, close } = await site();
  const start = await call('GET', '/api/auth/discord');
  assert.equal(new URL(start.location).searchParams.get('scope'), 'identify guilds.members.read');

  const boss = await login('boss');
  assert.deepEqual([(await me(boss)).admin, (await me(boss)).admin_via, (await me(boss)).role_login], [true, 'discord', true]);
  assert.equal((await call('GET', '/api/admin/registrations', { cookie: boss })).status, 200);
  assert.equal((await call('PUT', '/api/admin/rules', { cookie: boss, body: { text: 'Play fair.' } })).status, 200);

  // Everyone else: no access, whatever other roles they hold.
  for (const who of ['owner', 'player', 'fan', 'stranger']) {
    const cookie = await login(who);
    assert.equal((await me(cookie)).admin, false, who);
    assert.equal((await call('GET', '/api/admin/registrations', { cookie })).status, 401, who);
  }
  assert.equal((await call('GET', '/api/admin/registrations')).status, 401);

  // The password still works on its own, as a way in when Discord is down.
  const pw = (await call('POST', '/api/login', { body: { password: 'pw' } })).cookies;
  assert.equal((await me(pw)).admin_via, 'password');
  close();
});

test('the Owner role plus a team role lets that person manage that team only', async () => {
  const { db, teamA, teamB, call, login, me, close } = await site();
  const { id: fa } = await db.get("INSERT INTO players (discord_tag, free_agent) VALUES ('free one', true) RETURNING id");
  const owner = await login('owner');
  assert.deepEqual((await me(owner)).manages, [teamA.id]);
  assert.deepEqual((await me(await login('player'))).manages, [], 'a team role without the Owner role manages nothing');

  assert.equal((await call('POST', `/api/teams/${teamB.id}/roster/sign`, { cookie: owner, body: { player_id: fa, slot: 'PG' } })).status, 403);
  assert.equal((await call('POST', `/api/teams/${teamA.id}/roster/sign`, { cookie: owner, body: { player_id: fa, slot: 'PG' } })).status, 200);
  assert.equal((await db.get("SELECT player_id FROM roster_slots WHERE team_id = ? AND slot = 'PG'", teamA.id)).player_id, fa);
  assert.equal((await call('POST', `/api/teams/${teamA.id}/roster/sign`, { cookie: await login('player'), body: { player_id: fa, slot: 'SG' } })).status, 403);

  // Captains do not manage rosters, whether made one with /roster staff or holding a Captain role.
  await db.run("INSERT INTO team_staff (team_id, discord_id, discord_name, role) VALUES (?, 'fan', 'fan', 'captain')", teamA.id);
  const captain = await login('fan');
  assert.deepEqual((await me(captain)).manages, []);
  assert.equal((await call('POST', `/api/teams/${teamA.id}/roster/release`, { cookie: captain, body: { player_id: fa } })).status, 403);
  // An owner made with /roster staff still does, with no Discord role at all.
  await db.run("UPDATE team_staff SET role = 'owner' WHERE discord_id = 'fan'");
  assert.deepEqual((await me(captain)).manages, [teamA.id]);
  assert.equal((await call('POST', `/api/teams/${teamA.id}/roster/release`, { cookie: captain, body: { player_id: fa } })).status, 200);
  close();
});

test('taking a role away in Discord takes the access away', async () => {
  // With the bot token the site re-reads roles once they are 10 minutes old.
  const live = await site({ botToken: true });
  const boss = await live.login('boss');
  live.members.set('boss', []);
  assert.equal((await live.me(boss)).admin, true, 'still inside the 10 minutes');
  await live.age('boss', '11 minutes');
  assert.equal((await live.me(boss)).admin, false);
  assert.equal((await live.call('GET', '/api/admin/registrations', { cookie: boss })).status, 401);
  live.members.set('boss', ['r-comm']);
  await live.age('boss', '11 minutes');
  assert.equal((await live.me(boss)).admin, true, 'and a role given back comes back');
  live.close();

  // Without it, roles from the login count for 12 hours, then the person logs in again.
  const plain = await site();
  const cookie = await plain.login('boss');
  await plain.age('boss', '11 hours');
  assert.equal((await plain.me(cookie)).admin, true);
  await plain.age('boss', '13 hours');
  const stale = await plain.me(cookie);
  assert.deepEqual([stale.admin, stale.roles_expired], [false, true]);
  assert.equal((await plain.me(await plain.login('boss'))).admin, true);
  plain.close();
});

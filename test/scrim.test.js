import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectLocal } from '../src/db-local.js';
import { createApp } from '../src/app.js';
import * as scrim from '../src/scrim.js';
import scrimBot, { commands, queuePayload } from '../bot/scrim.js';

const IMAGE = `data:image/png;base64,${Buffer.from('final score').toString('base64')}`;
const NO_READER = { apiKey: '' };

// A fresh in-memory database with a captain on each of the first `n` teams.
async function league(n = 3) {
  const db = await connectLocal();
  const teams = await db.all('SELECT id, name FROM teams ORDER BY id LIMIT ?', n);
  const captains = [];
  for (const [i, team] of teams.entries()) {
    const user = await scrim.upsertUser(db, { discordId: `cap${i}`, name: `Captain ${i}` });
    await scrim.setMember(db, team.id, user.id, 'captain');
    captains.push(user);
  }
  return { db, teams, captains };
}
const entryStatus = async (db, id) => (await db.get('SELECT status FROM queue_entries WHERE id = ?', id)).status;
const age = (db, table, id, column, minutes) => db.run(`UPDATE ${table} SET ${column} = now() - make_interval(mins => ?) WHERE id = ?`, minutes, id);

// ---------- service layer ----------

test('only a captain can queue, and a team queues once', async () => {
  const { db, teams, captains: [cap] } = await league(1);
  const stranger = await scrim.upsertUser(db, { discordId: 'nobody' });
  await assert.rejects(scrim.joinQueue(db, stranger.id), /not on a team/);
  const player = await scrim.upsertUser(db, { discordId: 'player' });
  await scrim.setMember(db, teams[0].id, player.id, 'player');
  await assert.rejects(scrim.joinQueue(db, player.id), /Only a captain/);

  const { entry, match } = await scrim.joinQueue(db, cap.id, { mode: 'ranked', team_size: 3, minutes: 30 });
  assert.equal(entry.status, 'waiting');
  assert.equal(match, null);
  await assert.rejects(scrim.joinQueue(db, cap.id), /already in the queue/);
  await assert.rejects(scrim.joinQueue(db, cap.id, { mode: 'casual' }), /scrim or ranked/);

  const [row] = await scrim.listQueue(db);
  assert.deepEqual(Object.keys(row).sort(), ['available_until', 'created_at', 'id', 'mode', 'team', 'team_id', 'team_size']); // no ratings
  await scrim.leaveQueue(db, cap.id);
  assert.equal((await scrim.listQueue(db)).length, 0);
  await assert.rejects(scrim.leaveQueue(db, cap.id), /isn't in the queue/);
});

test('the matcher pairs the oldest compatible entries and skips other formats', async () => {
  const { db, teams, captains: [a, b, c] } = await league(3);
  await scrim.joinQueue(db, a.id, { team_size: 5 });
  assert.equal((await scrim.joinQueue(db, b.id, { team_size: 3 })).match, null); // 3v3 can't meet 5v5
  const { match } = await scrim.joinQueue(db, c.id, { team_size: 5 });
  assert.equal(match.status, 'pending_accept');
  assert.deepEqual([match.team_a_id, match.team_b_id], [teams[0].id, teams[2].id]); // first come is team A
  assert.deepEqual((await scrim.listQueue(db)).map(e => e.team_id), [teams[1].id]);
  await assert.rejects(scrim.joinQueue(db, a.id), /already has a match/);
  assert.deepEqual(await scrim.runMatcher(db), []); // nothing new to pair
});

test('skill windows keep teams apart unless they overlap', async () => {
  const { db, teams, captains: [a, b, c] } = await league(3);
  await db.run('UPDATE teams SET skill_rating = 1200 WHERE id = ?', teams[2].id);
  await scrim.joinQueue(db, a.id, { skill_min: 1100, skill_max: 1300 });
  assert.equal((await scrim.joinQueue(db, b.id)).match, null); // rated 1000, outside 1100-1300
  const { match } = await scrim.joinQueue(db, c.id);
  assert.equal(match.team_b_id, teams[2].id);
});

test('both captains accept; a decline sends only the other team back to the queue', async () => {
  const { db, captains: [a, b] } = await league(2);
  await scrim.joinQueue(db, a.id);
  const first = (await scrim.joinQueue(db, b.id)).match;
  assert.equal((await scrim.respondToMatch(db, a.id, true)).match.status, 'pending_accept');
  assert.equal((await scrim.respondToMatch(db, b.id, true)).match.status, 'accepted');
  await assert.rejects(scrim.respondToMatch(db, a.id, true), /No match is waiting/);
  await db.run("UPDATE matches SET status = 'cancelled' WHERE id = ?", first.id);

  const { entry: entryA } = await scrim.joinQueue(db, a.id);
  const { entry: entryB } = await scrim.joinQueue(db, b.id);
  const { match } = await scrim.respondToMatch(db, b.id, false);
  assert.equal(match.status, 'cancelled');
  assert.match(match.cancel_reason, /declined/);
  assert.equal(await entryStatus(db, entryA.id), 'waiting');
  assert.equal(await entryStatus(db, entryB.id), 'cancelled');
  assert.deepEqual(await scrim.runMatcher(db), []); // the pair is not put back together
});

test('accept timeout: the team that accepted waits again, the silent team is out', async () => {
  const { db, captains: [a, b] } = await league(2);
  const { entry: entryA } = await scrim.joinQueue(db, a.id);
  const { entry: entryB, match } = await scrim.joinQueue(db, b.id);
  await scrim.respondToMatch(db, a.id, true);
  await age(db, 'matches', match.id, 'created_at', 4);
  await scrim.runMatcher(db);
  assert.equal((await scrim.matchDetail(db, match.id)).status, 'pending_accept'); // not yet 5 minutes

  await age(db, 'matches', match.id, 'created_at', 6);
  await scrim.runMatcher(db);
  assert.equal((await scrim.matchDetail(db, match.id)).status, 'cancelled');
  assert.equal(await entryStatus(db, entryA.id), 'waiting');
  assert.equal(await entryStatus(db, entryB.id), 'cancelled');
});

test('entries expire at the end of their window', async () => {
  const { db, captains: [a, b] } = await league(2);
  const { entry } = await scrim.joinQueue(db, a.id, { minutes: 5 });
  await db.run("UPDATE queue_entries SET available_until = now() - interval '1 minute' WHERE id = ?", entry.id);
  assert.equal((await scrim.joinQueue(db, b.id)).match, null);
  assert.equal(await entryStatus(db, entry.id), 'expired');
  assert.equal((await scrim.joinQueue(db, a.id)).match.status, 'pending_accept'); // can queue again right away
});

test('host, report, confirm: a match runs to completed and frees both teams', async () => {
  const { db, teams, captains: [a, b] } = await league(2);
  await scrim.joinQueue(db, a.id, { mode: 'ranked' });
  const { match } = await scrim.joinQueue(db, b.id, { mode: 'ranked' });
  await assert.rejects(scrim.setHost(db, a.id, 'mine'), /once both teams have accepted/);
  await scrim.respondToMatch(db, a.id, true);
  await scrim.respondToMatch(db, b.id, true);
  const hosted = (await scrim.setHost(db, a.id, 'theirs')).match;
  assert.equal(hosted.status, 'in_progress');
  assert.equal(hosted.host_team_id, teams[1].id);

  await assert.rejects(scrim.reportResult(db, NO_READER, a.id, { score_a: 60, score_b: 60, image: IMAGE }), /tie/);
  await assert.rejects(scrim.reportResult(db, NO_READER, a.id, { score_a: 60, score_b: 55, image: 'nope' }), /PNG, JPG/);
  const reported = (await scrim.reportResult(db, NO_READER, a.id, { score_a: 60, score_b: 55, image: IMAGE })).match;
  assert.equal(reported.status, 'awaiting_result');
  assert.equal(reported.winner_team_id, teams[0].id);
  assert.equal(reported.verified, false);
  await assert.rejects(scrim.reportResult(db, NO_READER, b.id, { score_a: 1, score_b: 2, image: IMAGE }), /already reported/);
  await assert.rejects(scrim.confirmResult(db, a.id), /other team confirms/);

  const done = (await scrim.confirmResult(db, b.id)).match;
  assert.equal(done.status, 'completed');
  assert.equal(done.verified, true);
  assert.ok(done.completed_at);
  assert.equal((await db.get('SELECT verified_by_user_id AS by FROM match_results WHERE match_id = ?', match.id)).by, b.id);
  // Ratings are untouched until the rating hook in confirmResult is filled in.
  assert.deepEqual((await db.all('SELECT DISTINCT skill_rating FROM teams')).map(r => r.skill_rating), [1000]);
  assert.equal((await scrim.joinQueue(db, a.id)).entry.status, 'waiting');
});

test('a dispute ends the match as disputed; a commissioner can confirm a reported result', async () => {
  const { db, captains: [a, b] } = await league(2);
  await scrim.joinQueue(db, a.id);
  await scrim.joinQueue(db, b.id);
  await assert.rejects(scrim.disputeMatch(db, a.id), /no match to dispute/);
  await scrim.respondToMatch(db, a.id, true);
  await scrim.respondToMatch(db, b.id, true);
  assert.equal((await scrim.disputeMatch(db, b.id)).match.status, 'disputed');

  await scrim.joinQueue(db, a.id);
  const { match } = await scrim.joinQueue(db, b.id);
  await scrim.respondToMatch(db, a.id, true);
  await scrim.respondToMatch(db, b.id, true);
  await scrim.reportResult(db, NO_READER, b.id, { score_a: 40, score_b: 52, image: IMAGE });
  assert.equal((await scrim.confirmResult(db, null, { admin: true, matchId: match.id })).match.status, 'completed');
});

test('a team that disbands leaves the queue, and its opponent goes back to waiting', async () => {
  const { db, teams, captains: [a, b, c] } = await league(3);
  const { entry } = await scrim.joinQueue(db, c.id, { team_size: 2 });
  await scrim.disbandTeam(db, teams[2].id);
  assert.equal(await entryStatus(db, entry.id), 'cancelled');
  await assert.rejects(scrim.joinQueue(db, c.id), /not on a team/);

  const { entry: entryA } = await scrim.joinQueue(db, a.id);
  const { match } = await scrim.joinQueue(db, b.id);
  await scrim.removeMember(db, b.id); // the only captain leaves: same as disbanding
  const after = await scrim.matchDetail(db, match.id);
  assert.equal(after.status, 'cancelled');
  assert.match(after.cancel_reason, /disbanded/);
  assert.equal(await entryStatus(db, entryA.id), 'waiting');
});

// ---------- Discord bot ----------

function fakeDiscord() {
  let n = 0;
  const messages = [];
  const threads = new Map();
  const channel = {
    send: async payload => {
      const message = { id: `msg${++n}`, payload, pinned: false, edits: 0, pin: async () => { message.pinned = true; } };
      messages.push(message);
      return message;
    },
    messages: {
      edit: async (id, payload) => {
        const message = messages.find(m => m.id === id);
        if (!message) throw new Error('Unknown message');
        message.payload = payload;
        message.edits++;
        return message;
      },
    },
    threads: {
      create: async options => {
        const thread = {
          id: `thread${++n}`, options, added: [], posts: [], archived: false,
          members: { add: async id => { thread.added.push(id); } },
          send: async payload => { thread.posts.push(payload); },
          setArchived: async v => { thread.archived = v; },
        };
        threads.set(thread.id, thread);
        return thread;
      },
    },
  };
  const client = { channels: { fetch: async id => (id === 'queue-channel' ? channel : threads.get(id) ?? Promise.reject(new Error('Unknown channel'))) } };
  return { client, messages, threads: () => [...threads.values()] };
}

function interaction(client, discordId, { command, customId, options = {}, fields = {}, admin = false }) {
  const it = {
    client, replies: [], modal: null, deferred: false,
    user: { id: discordId, username: `name-${discordId}` },
    commandName: command?.split(' ')[0], customId,
    isAutocomplete: () => false,
    isChatInputCommand: () => Boolean(command),
    options: {
      getSubcommand: () => command.split(' ')[1],
      getString: k => options[k] ?? null, getInteger: k => options[k] ?? null,
      getAttachment: k => options[k], getUser: k => options[k],
    },
    fields: { getTextInputValue: k => fields[k] },
    memberPermissions: { has: () => admin },
    reply: async p => { it.replies.push(p); },
    deferReply: async () => { it.deferred = true; },
    editReply: async p => { it.replies.push(p); },
    showModal: async m => { it.modal = m; },
  };
  return it;
}

async function botLeague() {
  const db = await connectLocal();
  const discord = fakeDiscord();
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('final score') });
  const ctx = { db, ingest: NO_READER, siteUrl: 'https://league.test', queueChannelId: 'queue-channel', adminRoleId: 'admins', fetchImpl };
  const run = async (discordId, what) => {
    const it = interaction(discord.client, discordId, what);
    await scrimBot.handle(it, ctx);
    return it;
  };
  const teams = await db.all('SELECT id, name FROM teams ORDER BY id LIMIT 2');
  for (const [i, team] of teams.entries()) {
    await run('commish', { command: 'team captain', options: { team: String(team.id), user: { id: `cap${i}`, username: `cap${i}` } }, admin: true });
    await run('commish', { command: 'team add', options: { team: String(team.id), user: { id: `sub${i}`, username: `sub${i}` }, role: 'sub' }, admin: true });
  }
  return { db, ctx, run, teams, ...discord };
}
const text = it => it.replies.map(r => r.content).join('\n');
const buttonIds = payload => payload.components.flatMap(r => r.components.map(c => c.custom_id));

test('commands: /queue and /match for everyone, /team for commissioners', () => {
  assert.deepEqual(commands.map(c => c.name), ['queue', 'match', 'team']);
  assert.deepEqual(commands[0].options.map(o => o.name), ['join', 'leave', 'status', 'list']);
  assert.deepEqual(commands[1].options.map(o => o.name), ['accept', 'decline', 'host', 'report', 'confirm', 'dispute']);
  assert.equal(commands[0].default_member_permissions, undefined);
  assert.equal(commands[2].default_member_permissions, '32');
  for (const c of commands) assert.deepEqual(c.contexts, [0]); // server only
  assert.deepEqual(scrimBot.names, ['queue', 'match', 'team']);
});

test('a match in Discord: live message, private thread, accept, report, confirm, archive', async () => {
  const { db, run, teams, messages, threads } = await botLeague();
  assert.equal(messages.length, 1); // the live queue message, posted once and pinned
  assert.equal(messages[0].pinned, true);
  assert.deepEqual(buttonIds(messages[0].payload), ['scrim:join', 'scrim:leave']);
  assert.match(messages[0].payload.embeds[0].description, /Nobody is waiting/);

  assert.match(text(await run('sub0', { command: 'queue join' })), /Only a captain/);
  const joined = await run('cap0', { command: 'queue join', options: { mode: 'scrim', size: 5 } });
  assert.match(text(joined), /is in the queue for scrim 5v5/);
  assert.equal(joined.replies[0].flags, 64);
  assert.match(messages[0].payload.embeds[0].description, new RegExp(`1\\. \\*\\*${teams[0].name}\\*\\* · scrim 5v5 · waiting since <t:\\d+:R>`));
  assert.doesNotMatch(JSON.stringify(messages[0].payload), /1000/); // no ratings in the live queue
  assert.match(text(await run('sub0', { command: 'queue status' })), /is in the queue/);

  assert.match(text(await run('cap1', { command: 'queue join' })), /is matched/);
  assert.equal(messages.length, 1);
  assert.match(messages[0].payload.embeds[0].description, /Nobody is waiting/);
  const [thread] = threads();
  assert.equal(thread.options.type, 12); // private thread
  assert.equal(thread.options.name, `${teams[0].name} vs ${teams[1].name}`);
  assert.deepEqual([...thread.added].sort(), ['cap0', 'cap1', 'sub0', 'sub1']);
  assert.deepEqual(buttonIds(thread.posts[0]), ['scrim:accept', 'scrim:decline']);
  assert.deepEqual([...thread.posts[0].allowedMentions.users].sort(), ['cap0', 'cap1']);

  assert.match(text(await run('sub1', { customId: 'scrim:accept' })), /Only a captain/);
  assert.match(text(await run('cap0', { customId: 'scrim:accept' })), /accepted\. Waiting on the other captain/);
  await run('cap1', { command: 'match accept' });
  assert.match(thread.posts[1].content, /Both teams accepted/);
  await run('cap1', { command: 'match host', options: { team: 'mine' } });
  assert.match(thread.posts[2].content, new RegExp(`\\*\\*${teams[1].name}\\*\\* hosts`));

  const report = await run('cap0', { command: 'match report', options: { score_a: 71, score_b: 64, screenshot: { url: 'https://cdn.test/a.png', contentType: 'image/png', size: 100 } } });
  assert.equal(report.deferred, true);
  assert.match(text(report), /reported the result/);
  const card = thread.posts[3];
  assert.match(card.content, new RegExp(`\\*\\*${teams[0].name}\\*\\* 71 – 64 \\*\\*${teams[1].name}\\*\\*`));
  assert.match(card.embeds[0].image.url, /^https:\/\/league\.test\/api\/screenshots\/\d+$/);
  const match = (await scrim.listMatches(db))[0];
  assert.deepEqual(buttonIds(card), [`scrim:confirm:${match.id}`, 'scrim:dispute']);

  assert.match(text(await run('cap0', { customId: `scrim:confirm:${match.id}` })), /other team confirms/);
  await run('cap1', { customId: `scrim:confirm:${match.id}` });
  assert.match(thread.posts[4].content, /Final: .* Confirmed/);
  assert.equal(thread.archived, false);

  await age(db, 'matches', match.id, 'completed_at', 25 * 60);
  await run('cap0', { command: 'queue list' });
  assert.equal(thread.archived, true);
  assert.equal(thread.posts.length, 5); // each status is posted once
});

test('the Join Queue button opens a form; declines and disputes reach the thread', async () => {
  const { run, threads } = await botLeague();
  const pressed = await run('cap0', { customId: 'scrim:join' });
  assert.equal(pressed.modal.custom_id, 'scrim:joinform');
  assert.deepEqual(pressed.modal.components.map(r => r.components[0].custom_id), ['mode', 'size', 'minutes']);
  assert.match(text(await run('cap0', { customId: 'scrim:joinform', fields: { mode: 'Ranked ', size: '3', minutes: '45' } })), /ranked 3v3/);
  assert.match(text(await run('cap1', { customId: 'scrim:joinform', fields: { mode: 'ranked', size: 'five', minutes: '45' } })), /Team size must be/);
  await run('cap1', { customId: 'scrim:joinform', fields: { mode: 'ranked', size: '3', minutes: '45' } });

  await run('cap1', { customId: 'scrim:decline' });
  const [first] = threads();
  assert.match(first.posts.at(-1).content, /Match cancelled: .* declined/);
  assert.equal(first.archived, true);
  assert.match(text(await run('cap0', { command: 'queue status' })), /is in the queue/); // the team that didn't decline

  await run('cap1', { command: 'queue join', options: { mode: 'ranked', size: 3 } });
  await run('cap0', { customId: 'scrim:accept' });
  await run('cap1', { customId: 'scrim:accept' });
  await run('cap0', { command: 'match dispute' });
  const second = threads()[1];
  assert.match(second.posts.at(-1).content, /^<@&admins> This match is disputed/);
  assert.deepEqual(second.posts.at(-1).allowedMentions, { roles: ['admins'] });
});

test('a queue joined on the site shows up in Discord on the next tick', async () => {
  const { db, ctx, client, messages, threads } = await botLeague();
  const [a, b] = await db.all("SELECT u.id FROM users u JOIN team_members tm ON tm.user_id = u.id WHERE tm.role = 'captain' ORDER BY u.id");
  await scrim.joinQueue(db, a.id);
  await scrimBot.handle(interaction(client, 'anyone', { command: 'queue list' }), ctx); // stands in for the 30 second timer
  assert.equal(messages[0].edits, 1);
  await scrim.joinQueue(db, b.id);
  assert.equal(threads().length, 0);
  await scrimBot.handle(interaction(client, 'anyone', { command: 'queue list' }), ctx);
  assert.equal(threads().length, 1);
  assert.equal(queuePayload([]).embeds[0].title, 'Scrim queue');
});

// ---------- site API ----------

async function site() {
  const { db, teams, captains } = await league(2);
  // Discord's two OAuth endpoints: the code is the Discord id of whoever is "logging in".
  const fetchImpl = async (url, init) => (String(url).endsWith('/oauth2/token')
    ? { ok: init.body.get('code') !== 'bad', json: async () => ({ access_token: init.body.get('code') }) }
    : { ok: true, json: async () => ({ id: init.headers.Authorization.slice(7), username: 'web' }) });
  const env = { SESSION_SECRET: 's', DISCORD_CLIENT_ID: 'client', DISCORD_CLIENT_SECRET: 'secret', SITE_URL: 'https://league.test/' };
  const app = createApp({ db, env, fetchImpl });
  const server = createServer(app.handle);
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
  return { db, teams, captains, call, login, base, close: () => server.close() };
}

test('site: Discord login links the browser to a captain, who can join and leave the queue', async () => {
  const { teams, call, login, close } = await site();
  const start = await call('GET', '/api/auth/discord');
  assert.equal(start.status, 302);
  const url = new URL(start.location);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://league.test/api/auth/discord/callback');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal((await call('GET', '/api/auth/discord/callback?code=cap0&state=forged', { cookie: start.cookies })).status, 400);

  assert.equal((await call('POST', '/api/queue')).status, 401);
  assert.equal((await call('POST', '/api/queue', { cookie: 'sr_user=1.9999999999999.forged' })).status, 401);
  assert.deepEqual((await call('GET', '/api/me')).json, { user: null, discord_login: true });

  const cap0 = await login('cap0');
  const me = (await call('GET', '/api/me', { cookie: cap0 })).json;
  assert.equal(me.user.discord_id, 'cap0');
  assert.equal(me.team.name, teams[0].name);
  assert.equal(me.team.role, 'captain');

  const joined = await call('POST', '/api/queue', { cookie: cap0, body: { mode: 'ranked', team_size: 3 } });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.entry.mode, 'ranked');
  assert.equal((await call('POST', '/api/queue', { cookie: cap0 })).status, 409);
  const queue = (await call('GET', '/api/queue')).json.entries;
  assert.deepEqual(queue.map(e => [e.team, e.mode, e.team_size]), [[teams[0].name, 'ranked', 3]]);
  assert.equal((await call('DELETE', '/api/queue', { cookie: cap0 })).status, 200);
  assert.equal((await call('GET', '/api/queue')).json.entries.length, 0);

  const outsider = await login('someone-new'); // logged in, but on no team
  assert.equal((await call('POST', '/api/queue', { cookie: outsider })).status, 403);
  close();
});

test('site: a match from pairing to a confirmed result, with the screenshot public', async () => {
  const { teams, call, login, base, close } = await site();
  const [cap0, cap1] = [await login('cap0'), await login('cap1')];
  await call('POST', '/api/queue', { cookie: cap0 });
  const { match } = (await call('POST', '/api/queue', { cookie: cap1 })).json;
  assert.equal(match.status, 'pending_accept');
  await call('POST', '/api/matches/accept', { cookie: cap0 });
  assert.equal((await call('POST', '/api/matches/accept', { cookie: cap1 })).json.match.status, 'accepted');
  assert.equal((await call('POST', '/api/matches/host', { cookie: cap0, body: { team_id: teams[0].id } })).json.match.status, 'in_progress');
  assert.equal((await call('POST', '/api/matches/host', { cookie: cap0, body: { team_id: 999 } })).status, 400);

  const reported = (await call('POST', '/api/matches/report', { cookie: cap1, body: { score_a: 50, score_b: 58, image: IMAGE } })).json;
  assert.equal(reported.match.status, 'awaiting_result');
  assert.equal(reported.warning, null);
  assert.equal((await call('POST', '/api/matches/confirm', { cookie: cap1 })).status, 403);
  assert.equal((await call('POST', `/api/admin/matches/${match.id}/confirm`)).status, 401);
  assert.equal((await call('POST', '/api/matches/confirm', { cookie: cap0 })).json.match.status, 'completed');

  const detail = (await call('GET', `/api/matches/${match.id}`)).json;
  assert.equal(detail.winner_team_id, teams[1].id);
  assert.deepEqual([detail.team_a_score, detail.team_b_score, detail.verified], [50, 58, true]);
  assert.equal((await call('GET', '/api/matches')).json.matches.length, 1);
  const shot = await fetch(`${base}/api/screenshots/${detail.screenshot_id}`); // proof of the score, no login needed
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get('content-type'), 'image/png');
  close();
});

// Solo queue: position seating, the match lifecycle, and the Discord flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLocal } from '../src/db-local.js';
import { upsertUser } from '../src/scrim.js';
import * as solo from '../src/solo.js';
import soloBot, { sync } from '../bot/solo.js';

const { POSITIONS } = solo;
const entries = lists => lists.map((positions, i) => ({ id: i + 1, positions }));
const seatsOf = seats => Object.fromEntries(seats.map(s => [`${s.position}-${s.side}`, s.entry.id]));

// Queues `lists.length` players, one per positions list, and returns their users.
async function queue(db, lists, offset = 0) {
  const users = [];
  for (const [i, positions] of lists.entries()) {
    const user = await upsertUser(db, { discordId: `p${offset + i}`, name: `p${offset + i}` });
    users.push({ ...user, joined: await solo.joinQueue(db, user.id, { positions }) });
  }
  return users;
}
const TWO_OF_EACH = [...POSITIONS, ...POSITIONS].map(p => [p]);

test('seatGame gives each side one of every position', () => {
  const seats = solo.seatGame(entries(TWO_OF_EACH));
  assert.equal(seats.length, 10);
  for (const side of ['A', 'B']) {
    assert.deepEqual(seats.filter(s => s.side === side).map(s => s.position), POSITIONS);
  }
  assert.equal(new Set(seats.map(s => s.entry.id)).size, 10);
});

test('seatGame moves a flexible player to another position to make room', () => {
  // Players 1 and 2 can play PG or C and take PG first. Players 9 and 10 can only play PG,
  // so 1 and 2 are moved to C instead of 9 and 10 being left out.
  const seats = seatsOf(solo.seatGame(entries([
    ['PG', 'C'], ['PG', 'C'], ['SG'], ['SG'], ['LOCK'], ['LOCK'], ['BACKEND'], ['BACKEND'], ['PG'], ['PG'],
  ])));
  assert.deepEqual([seats['C-A'], seats['C-B']].sort(), [1, 2]);
  assert.deepEqual([seats['PG-A'], seats['PG-B']].sort((a, b) => a - b), [9, 10]);
});

test('seatGame waits when a position is short, and seats the longest waiting first', () => {
  const noCenter = [...Array(12)].map(() => ['PG', 'SG', 'LOCK', 'BACKEND']);
  assert.equal(solo.seatGame(entries(noCenter)), null);

  // Three centers are waiting: the first two get the seats, the third keeps waiting.
  const line = entries([['C'], ['C'], ['C'], ...TWO_OF_EACH.filter(([p]) => p !== 'C')]);
  const seated = solo.seatGame(line).map(s => s.entry.id);
  assert.ok(seated.includes(1) && seated.includes(2));
  assert.ok(!seated.includes(3));
});

test('ten players are matched, all accept, and can queue again once the game is over', async () => {
  const db = await connectLocal();
  const users = await queue(db, TWO_OF_EACH);
  assert.equal(users.slice(0, 9).every(u => u.joined.match === null), true);
  const { match } = users[9].joined;
  assert.equal(match.status, 'pending_accept');
  assert.deepEqual(await solo.listQueue(db), []);

  const players = await solo.matchPlayers(db, match.id);
  assert.deepEqual(players.map(p => `${p.side}:${p.position}`), ['A', 'B'].flatMap(s => POSITIONS.map(p => `${s}:${p}`)));

  await assert.rejects(solo.joinQueue(db, users[0].id, { positions: ['PG'] }), /already have a solo match/);
  await assert.rejects(solo.reportResult(db, null, users[0].id, { winner: 'A' }), /in progress/);
  for (const [i, u] of users.entries()) {
    const { match: m, accepted } = await solo.respondToMatch(db, u.id, true);
    assert.equal(accepted, i + 1);
    assert.equal(m.status, i === 9 ? 'in_progress' : 'pending_accept');
  }
  // Reporting reads the score from a screenshot (covered in solo-stats.test.js).
  await assert.rejects(solo.reportResult(db, null, users[3].id, { winner: 'C' }), /A or B/);
  await assert.rejects(solo.reportResult(db, { apiKey: '' }, users[3].id, { winner: 'A' }), /not set up/);
  await db.run("UPDATE solo_matches SET status = 'completed', completed_at = now() WHERE id = ?", match.id);

  const again = await solo.joinQueue(db, users[0].id, { positions: ['PG', 'SG'] });
  assert.equal(again.entry.positions, 'PG,SG');
  await assert.rejects(solo.joinQueue(db, users[0].id, { positions: ['PG'] }), /already in the solo queue/);
});

test('joining needs a position role', async () => {
  const db = await connectLocal();
  const user = await upsertUser(db, { discordId: 'norole' });
  await assert.rejects(solo.joinQueue(db, user.id, { positions: [] }), /position role first: PG, SG, LOCK, BACKEND, C/);
  assert.deepEqual(solo.positionsFromRoles(['Member', 'lock', ' C ', 'Captain']), ['LOCK', 'C']);
});

test('a timeout puts the players who accepted back in line; a decline puts everyone else back', async () => {
  const db = await connectLocal();
  const users = await queue(db, TWO_OF_EACH);
  const { match } = users[9].joined;
  await solo.respondToMatch(db, users[0].id, true);
  await solo.respondToMatch(db, users[1].id, true);
  await db.run("UPDATE solo_matches SET created_at = now() - interval '6 minutes' WHERE id = ?", match.id);
  await solo.runMatcher(db);
  assert.equal((await db.get('SELECT status, cancel_reason FROM solo_matches WHERE id = ?', match.id)).cancel_reason, 'not everyone accepted in time');
  assert.deepEqual((await solo.listQueue(db)).map(e => e.discord_id), ['p0', 'p1']); // still first in line

  // Eight new players fill the game again; this time one declines.
  const more = await queue(db, TWO_OF_EACH.slice(2), 10);
  const second = more[7].joined.match;
  assert.ok(second);
  const { match: cancelled } = await solo.respondToMatch(db, more[0].id, false);
  assert.equal(cancelled.cancel_reason, 'a player declined');
  assert.equal((await solo.listQueue(db)).length, 9);
  assert.equal((await solo.queueStatus(db, more[0].id)).entry, undefined);
});

test('a game nobody reports is closed after 3 hours, and a commissioner can call one off', async () => {
  const db = await connectLocal();
  const users = await queue(db, TWO_OF_EACH);
  const { match } = users[9].joined;
  for (const u of users) await solo.respondToMatch(db, u.id, true);
  await db.run("UPDATE solo_matches SET started_at = now() - interval '4 hours' WHERE id = ?", match.id);
  await solo.runMatcher(db);
  assert.equal((await db.get('SELECT status FROM solo_matches WHERE id = ?', match.id)).status, 'cancelled');

  const next = (await queue(db, TWO_OF_EACH, 20))[9].joined.match;
  await solo.setThread(db, next.id, 'thread-9');
  assert.equal((await solo.cancelByThread(db, 'thread-9')).cancel_reason, 'cancelled by a commissioner');
  await assert.rejects(solo.cancelByThread(db, 'thread-9'), /still going/);
});

// ---------- Discord ----------

test('/solo in Discord: positions come from roles, testfill completes a game for one real player', async () => {
  const db = await connectLocal();
  const posts = [], added = [], live = [];
  const thread = { id: 'thread1', members: { add: async id => { added.push(id); } }, send: async p => { posts.push(p); }, setArchived: async () => {} };
  const channel = {
    send: async p => { live.push(p); return { id: 'live', pin: async () => {} }; },
    messages: { edit: async (id, p) => { live.push(p); return {}; } },
    threads: { create: async () => thread },
  };
  const client = { channels: { fetch: async id => (id === 'solo-channel' ? channel : thread) } };
  const ctx = { db, soloChannelId: 'solo-channel' };
  const run = async (discordId, action, { roles = [], admin = false, button = false } = {}) => {
    const said = [];
    await soloBot.handle({
      client, user: { id: discordId, username: discordId }, channelId: 'thread1',
      member: { roles: { cache: new Map(roles.map(name => [name, { name }])) } },
      memberPermissions: { has: () => admin },
      isChatInputCommand: () => !button, customId: `solo:${action}`,
      options: button ? undefined : { getSubcommand: () => action, getInteger: () => null },
      reply: async p => { said.push(p.content); },
    }, ctx);
    return said.join('\n');
  };

  assert.match(await run('me', 'join', { roles: ['Member'] }), /position role first/);
  assert.match(await run('me', 'testfill'), /Only a commissioner/);
  assert.match(await run('commish', 'testfill', { admin: true }), /^9 fake players/);
  assert.match(live.at(-1).embeds[0].description, /Test player 1 · PG \/ SG \/ LOCK \/ BACKEND \/ C/);
  assert.equal(live.at(-1).embeds[0].fields[0].value, 'PG 9 · SG 9 · LOCK 9 · BACKEND 9 · C 9');

  // The Join button, with a C and an SG role. Nine fakes took PG..BACKEND twice and one C, so the real player is C.
  assert.match(await run('me', 'join', { roles: ['c', 'SG'], button: true }), /Game found/);
  assert.deepEqual(added, ['me']); // fake players are not real accounts
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].allowedMentions.users, ['me']);
  assert.match(posts[0].embeds[0].fields.map(f => f.value).join('\n'), /\*\*(C|SG)\*\* <@me>/);
  assert.match(await run('me', 'status'), /You are \*\*(C|SG)\*\* on Team [AB] in solo match #1/);
  assert.match(await run('me', 'accept', { button: true }), /<@me> accepted \(1 of 10\)/);

  // Nobody else answers: the match cancels, the real player waits again, the fakes are gone.
  await db.run("UPDATE solo_matches SET created_at = now() - interval '6 minutes'");
  await sync(client, ctx);
  assert.match(posts.at(-1).content, /not everyone accepted in time/);
  assert.deepEqual((await solo.listQueue(db)).map(e => e.discord_id), ['me']);
});

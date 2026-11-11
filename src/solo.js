// Solo queue: single players queue with the positions they play, and the matcher seats ten of
// them into two teams with one of each position. Separate from the team scrim queue (scrim.js).
// The bot (bot/solo.js) reads positions from Discord roles and passes them in; nothing here
// talks to Discord.
//
// Match lifecycle:
//   pending_accept -> in_progress -> completed
//   pending_accept -> cancelled   (a decline or a 5 minute timeout)
//   in_progress    -> cancelled   (a commissioner, or nobody reporting for 3 hours)
import { STAT_KEYS, UserError } from './league.js';
import { ingestScreenshot, storeScreenshot } from './ingest.js';

export const POSITIONS = ['PG', 'SG', 'LOCK', 'BACKEND', 'C'];
export const ACCEPT_MINUTES = 5;
export const STALE_HOURS = 3;
// Made-up players for testing alone (fillWithFakes). They never accept.
export const FAKE_IDS = Array.from({ length: 9 }, (_, n) => `1000000000000000${String(n + 1).padStart(2, '0')}`);

// Serializes solo queue changes, so two matchers never seat the same player.
const LOCK = 'SELECT pg_advisory_xact_lock(727276)';
const ENTRY = `SELECT e.*, u.discord_id, u.discord_name FROM solo_queue_entries e JOIN users u ON u.id = e.user_id`;

// Discord role names -> positions. A role named "pg" or " Lock " counts.
export const positionsFromRoles = names => POSITIONS.filter(p => names.some(n => String(n).trim().toUpperCase() === p));

const getMatch = (db, id) => db.get('SELECT * FROM solo_matches WHERE id = ?', id);
// The player's seat in a match that is still going, joined with that match's status.
const activeSeat = (db, userId) => db.get(`SELECT e.*, m.status AS match_status FROM solo_queue_entries e
  JOIN solo_matches m ON m.id = e.match_id
  WHERE e.user_id = ? AND e.status = 'matched' AND m.status IN ('pending_accept', 'in_progress')`, userId);
const expireEntries = t => t.run("UPDATE solo_queue_entries SET status = 'expired', updated_at = now() WHERE status = 'waiting' AND available_until <= now()");

// ---------- queue ----------

export async function joinQueue(db, userId, { positions = [], minutes } = {}) {
  const can = POSITIONS.filter(p => positions.includes(p));
  if (!can.length) throw new UserError(`You need a position role first: ${POSITIONS.join(', ')}.`, 403);
  const mins = minutes === null || minutes === undefined || minutes === '' ? 60 : Number(minutes);
  if (!Number.isInteger(mins) || mins < 5 || mins > 720) throw new UserError('Minutes available must be a whole number from 5 to 720.');

  const entry = await db.tx(async t => {
    await t.get(LOCK);
    await expireEntries(t);
    if (await t.get("SELECT 1 AS x FROM solo_queue_entries WHERE user_id = ? AND status = 'waiting'", userId)) {
      throw new UserError("You're already in the solo queue.", 409);
    }
    if (await activeSeat(t, userId)) throw new UserError('You already have a solo match. Finish it first.', 409);
    return t.get(`INSERT INTO solo_queue_entries (user_id, positions, available_until)
      VALUES (?, ?, now() + make_interval(mins => ?)) RETURNING *`, userId, can.join(','), mins);
  });
  const made = await runMatcher(db);
  return { entry, match: made.find(m => m.entry_ids.includes(entry.id)) ?? null };
}

export async function leaveQueue(db, userId) {
  const row = await db.get(`UPDATE solo_queue_entries SET status = 'cancelled', updated_at = now()
    WHERE user_id = ? AND status = 'waiting' RETURNING id`, userId);
  if (!row) throw new UserError("You're not in the solo queue.", 404);
}

export async function queueStatus(db, userId) {
  const seat = await activeSeat(db, userId);
  if (seat) return { seat, match: await getMatch(db, seat.match_id), entry: null };
  return { seat: null, match: null, entry: await db.get("SELECT * FROM solo_queue_entries WHERE user_id = ? AND status = 'waiting'", userId) };
}

// Who is waiting, longest wait first.
export const listQueue = db => db.all(`SELECT e.id, e.positions, e.created_at, u.discord_id, u.discord_name
  FROM solo_queue_entries e JOIN users u ON u.id = e.user_id
  WHERE e.status = 'waiting' AND e.available_until > now() ORDER BY e.created_at, e.id`);

// ---------- the matcher ----------

// Tries to seat one full game from the waiting line: two players per position, one on each side.
// Players are taken in queue order. To make room, a seated player may be moved to another
// position they play, but is never pushed out, so whoever waited longest plays first.
// Returns the ten filled seats, or null when the line can't fill a game yet.
export function seatGame(waiting) {
  const seats = POSITIONS.flatMap(position => [{ position, side: 'A', entry: null }, { position, side: 'B', entry: null }]);
  const place = (entry, tried) => {
    for (const seat of seats) {
      if (tried.has(seat) || !entry.positions.includes(seat.position)) continue;
      tried.add(seat);
      if (!seat.entry || place(seat.entry, tried)) {
        seat.entry = entry;
        return true;
      }
    }
    return false;
  };
  for (const entry of waiting) {
    place(entry, new Set());
    if (seats.every(s => s.entry)) return seats;
  }
  return null;
}

// Cancels a match. Entries listed in `requeue` go back to waiting and keep their place in line;
// the others leave the queue.
async function cancelMatch(t, matchId, reason, requeue) {
  await t.run("UPDATE solo_matches SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, matchId);
  for (const e of await t.all('SELECT id, available_until > now() AS has_time FROM solo_queue_entries WHERE match_id = ?', matchId)) {
    if (requeue.includes(e.id) && e.has_time) {
      await t.run(`UPDATE solo_queue_entries SET status = 'waiting', match_id = NULL, side = NULL, position = NULL,
        accepted = false, updated_at = now() WHERE id = ?`, e.id);
    } else {
      await t.run("UPDATE solo_queue_entries SET status = 'cancelled', updated_at = now() WHERE id = ?", e.id);
    }
  }
}

// Runs on every join and every 30 seconds (bot/solo.js). Returns the matches it created,
// each with `entry_ids`.
export async function runMatcher(db) {
  return db.tx(async t => {
    await t.get(LOCK);

    // 1. Matches nobody finished accepting: whoever accepted goes back in line, the rest are out.
    const timedOut = await t.all(`SELECT id FROM solo_matches WHERE status = 'pending_accept'
      AND created_at <= now() - make_interval(mins => ?)`, ACCEPT_MINUTES);
    for (const m of timedOut) {
      const accepted = await t.all('SELECT id FROM solo_queue_entries WHERE match_id = ? AND accepted', m.id);
      await cancelMatch(t, m.id, 'not everyone accepted in time', accepted.map(e => e.id));
    }
    // 2. Games nobody reported: close them, so ten players aren't locked out of the queue for good.
    await t.run(`UPDATE solo_matches SET status = 'cancelled', cancel_reason = 'no result reported'
      WHERE status = 'in_progress' AND started_at <= now() - make_interval(hours => ?)`, STALE_HOURS);
    await expireEntries(t);

    // 3. Seat games for as long as the line can fill one.
    // BALANCE HOOK: sides are filled in queue order. With player ratings, swap the two players of a
    // position here to even out the teams.
    let waiting = (await t.all("SELECT id, positions FROM solo_queue_entries WHERE status = 'waiting' ORDER BY created_at, id"))
      .map(e => ({ id: e.id, positions: e.positions.split(',') }));
    const created = [];
    for (let seats; (seats = seatGame(waiting));) {
      const { id } = await t.get('INSERT INTO solo_matches DEFAULT VALUES RETURNING id');
      for (const s of seats) {
        await t.run(`UPDATE solo_queue_entries SET status = 'matched', match_id = ?, side = ?, position = ?, updated_at = now()
          WHERE id = ?`, id, s.side, s.position, s.entry.id);
      }
      const seated = seats.map(s => s.entry.id);
      waiting = waiting.filter(e => !seated.includes(e.id));
      created.push({ ...(await getMatch(t, id)), entry_ids: seated });
    }
    return created;
  });
}

// ---------- playing the match ----------

export async function respondToMatch(db, userId, accept) {
  return db.tx(async t => {
    await t.get(LOCK);
    const seat = await activeSeat(t, userId);
    if (seat?.match_status !== 'pending_accept') throw new UserError("You don't have a solo match waiting for an answer.", 404);
    if (!accept) {
      // Everyone else did nothing wrong: they go straight back in line.
      const others = await t.all('SELECT id FROM solo_queue_entries WHERE match_id = ? AND id <> ?', seat.match_id, seat.id);
      await cancelMatch(t, seat.match_id, 'a player declined', others.map(e => e.id));
      return { match: await getMatch(t, seat.match_id), accepted: 0 };
    }
    await t.run('UPDATE solo_queue_entries SET accepted = true, updated_at = now() WHERE id = ?', seat.id);
    const { n } = await t.get('SELECT COUNT(*)::int AS n FROM solo_queue_entries WHERE match_id = ? AND accepted', seat.match_id);
    if (n === POSITIONS.length * 2) await t.run("UPDATE solo_matches SET status = 'in_progress', started_at = now() WHERE id = ?", seat.match_id);
    return { match: await getMatch(t, seat.match_id), accepted: n };
  });
}

// Any of the ten players reports the result: which team won, and the final box score screenshot.
// The score and the player lines both come from the screenshot (the same reader as league games),
// so nobody types a score. A screenshot names no teams, so the winner says which side is which:
// the higher score is the winning team. There is no second confirmation: nothing is rated yet,
// and the thread shows who reported it.
export async function reportResult(db, cfg, userId, { winner, image }) {
  if (!['A', 'B'].includes(winner)) throw new UserError('Say which team won: A or B.');
  const seat = await activeSeat(db, userId);
  if (seat?.match_status !== 'in_progress') throw new UserError("You don't have a solo game in progress.", 404);
  if (!cfg?.apiKey) throw new UserError('Screenshot reading is not set up (OPENAI_API_KEY), so results cannot be reported yet.', 503);

  // An unreadable screenshot is refused here and the game stays open, so they can upload a better one.
  const read = await ingestScreenshot(db, cfg, { image });
  if (!read.lines) throw new UserError('That screenshot is already saved as a league game. Upload the one from this game.', 409);
  if (read.away_score === read.home_score) throw new UserError(`The screenshot reads ${read.away_score}-${read.home_score}, a tie. Upload the final box score.`);
  const awaySide = (read.away_score > read.home_score) === (winner === 'A') ? 'A' : 'B';
  const [scoreA, scoreB] = awaySide === 'A' ? [read.away_score, read.home_score] : [read.home_score, read.away_score];

  const screenshotId = await storeScreenshot(db, image);
  const done = await db.get(`UPDATE solo_matches SET status = 'completed', team_a_score = ?, team_b_score = ?, screenshot_id = ?,
    reported_by_user_id = ?, completed_at = now() WHERE id = ? AND status = 'in_progress' RETURNING *`, scoreA, scoreB, screenshotId, userId, seat.match_id);
  if (!done) throw new UserError('This game was already reported.', 409);
  await saveBox(db, done.id, read.lines, awaySide);
  return done;
}

// One solo_box_scores row per human player in the reading. Nothing is added to `players` or to
// the league's box_scores; a name that matched a league player keeps that link.
async function saveBox(db, matchId, lines, awaySide) {
  const homeSide = awaySide === 'A' ? 'B' : 'A';
  await db.tx(async t => {
    for (const l of lines.filter(line => !line.ai)) {
      await t.run(`INSERT INTO solo_box_scores (match_id, side, player_id, name, ${STAT_KEYS.join(', ')})
        VALUES (?, ?, ?, ?, ${STAT_KEYS.map(() => '?').join(', ')})`,
      matchId, l.side === 'away' ? awaySide : homeSide, l.match?.player_id ?? null, String(l.read_as).slice(0, 64),
      ...STAT_KEYS.map(k => l.stats[k] ?? 0));
    }
  });
}

// A commissioner calls off the match whose thread they are in (a no-show, a lobby that never started).
export async function cancelByThread(db, threadId) {
  const m = await db.get("SELECT id FROM solo_matches WHERE discord_thread_id = ? AND status IN ('pending_accept', 'in_progress')", String(threadId));
  if (!m) throw new UserError('Run this inside the thread of a solo match that is still going.', 404);
  await db.tx(async t => {
    await t.get(LOCK);
    await cancelMatch(t, m.id, 'cancelled by a commissioner', []);
  });
  return getMatch(db, m.id);
}

// Testing alone: queues the nine made-up players, each able to play every position, so one real
// player completes a game. Returns how many were added (the ones already queued or seated are skipped).
export async function fillWithFakes(db) {
  let added = 0;
  for (const [n, discordId] of FAKE_IDS.entries()) {
    const user = await db.get(`INSERT INTO users (discord_id, discord_name) VALUES (?, ?)
      ON CONFLICT (discord_id) DO UPDATE SET discord_name = excluded.discord_name RETURNING id`, discordId, `Test player ${n + 1}`);
    try {
      await joinQueue(db, user.id, { positions: POSITIONS });
      added++;
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
    }
  }
  return added;
}

// ---------- what the bot needs to keep Discord in line ----------

export const matchesToAnnounce = db => db.all('SELECT * FROM solo_matches WHERE announced_status IS DISTINCT FROM status ORDER BY id');
export const setThread = (db, id, threadId) => db.run('UPDATE solo_matches SET discord_thread_id = ? WHERE id = ?', threadId, id);
export const markAnnounced = (db, id, status) => db.run('UPDATE solo_matches SET announced_status = ? WHERE id = ?', status, id);
export const threadsToArchive = db => db.all(`SELECT id, discord_thread_id FROM solo_matches
  WHERE status = 'completed' AND NOT thread_archived AND discord_thread_id IS NOT NULL
    AND completed_at <= now() - interval '24 hours'`);
export const markArchived = (db, id) => db.run('UPDATE solo_matches SET thread_archived = true WHERE id = ?', id);

// The ten seats of a match, in position order, side A first. `fake` marks the made-up test players.
// After a cancellation the players who went back in line are no longer attached, so this can be short.
export async function matchPlayers(db, matchId) {
  const rows = await db.all(`${ENTRY} WHERE e.match_id = ?`, matchId);
  return rows
    .map(r => ({ discord_id: r.discord_id, name: r.discord_name, side: r.side, position: r.position, accepted: r.accepted, fake: FAKE_IDS.includes(r.discord_id) }))
    .sort((x, y) => x.side.localeCompare(y.side) || POSITIONS.indexOf(x.position) - POSITIONS.indexOf(y.position));
}

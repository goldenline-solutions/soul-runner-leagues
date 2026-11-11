// Team scrim queue. One source of truth for the Discord bot (bot/scrim.js) and the site
// (/api/queue, /api/matches): both call these functions, and all state lives in the database.
// Nothing here talks to Discord or to NBA 2K.
//
// Match lifecycle:
//   pending_accept -> accepted -> in_progress -> awaiting_result -> completed
//   pending_accept -> cancelled   (a decline, a 5 minute timeout, or a team disbanding)
//   accepted | in_progress | awaiting_result -> disputed
import { STAT_KEYS, UserError } from './league.js';
import { ingestScreenshot, storeScreenshot } from './ingest.js';

export const MODES = ['scrim', 'ranked'];
export const ROLES = ['captain', 'player', 'sub'];
export const ACCEPT_MINUTES = 5;

const ACTIVE = "('pending_accept', 'accepted', 'in_progress', 'awaiting_result')";
// Serializes queue changes between the bot and the site, so two matchers never pair the same entry.
const LOCK = 'SELECT pg_advisory_xact_lock(727275)';
const MATCH = `SELECT m.*, a.name AS team_a, b.name AS team_b,
    r.winner_team_id, r.team_a_score, r.team_b_score, r.screenshot_id, r.submitted_by_user_id, r.verified
  FROM matches m
  JOIN teams a ON a.id = m.team_a_id
  JOIN teams b ON b.id = m.team_b_id
  LEFT JOIN match_results r ON r.match_id = m.id`;

const whole = (v, fallback, min, max, label) => {
  const n = v === null || v === undefined || v === '' ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};
const optional = (v, label) => (v === null || v === undefined || v === '' ? null : whole(v, null, 0, 5000, label));

// ---------- users and teams ----------

export function upsertUser(db, { discordId, name = '' }) {
  return db.get(`INSERT INTO users (discord_id, discord_name) VALUES (?, ?)
    ON CONFLICT (discord_id) DO UPDATE SET discord_name = excluded.discord_name RETURNING *`,
  String(discordId), String(name).slice(0, 64));
}

export const memberTeam = (db, userId) => db.get(`SELECT t.id, t.name, tm.role
  FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ?`, userId);

// Only a captain can queue, accept, host, report, confirm or dispute for a team.
async function captainTeam(db, userId) {
  const team = await memberTeam(db, userId);
  if (!team) throw new UserError("You're not on a team yet. Ask a commissioner to add you.", 403);
  if (team.role !== 'captain') throw new UserError(`Only a captain of ${team.name} can do that.`, 403);
  return team;
}

const getMatch = (db, id) => db.get(`${MATCH} WHERE m.id = ?`, id);
const activeMatch = (db, teamId) => db.get(`${MATCH} WHERE (m.team_a_id = ? OR m.team_b_id = ?) AND m.status IN ${ACTIVE}`, teamId, teamId);
const otherTeamId = (m, teamId) => (m.team_a_id === teamId ? m.team_b_id : m.team_a_id);

// Puts someone on a team (moving them off their old one). Commissioner only.
export async function setMember(db, teamId, userId, role = 'player') {
  if (!ROLES.includes(role)) throw new UserError('Role must be captain, player or sub.');
  if (!(await db.get('SELECT 1 AS x FROM teams WHERE id = ?', teamId))) throw new UserError('Team not found.', 404);
  await db.tx(async t => {
    await t.get(LOCK);
    const before = await t.get('SELECT team_id FROM team_members WHERE user_id = ?', userId);
    await t.run(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET team_id = excluded.team_id, role = excluded.role`, teamId, userId, role);
    for (const id of new Set([before?.team_id ?? teamId, teamId])) await releaseIfNoCaptain(t, id);
  });
}

export async function removeMember(db, userId) {
  await db.tx(async t => {
    await t.get(LOCK);
    const row = await t.get('DELETE FROM team_members WHERE user_id = ? RETURNING team_id', userId);
    if (!row) throw new UserError("That person isn't on a team.", 404);
    await releaseIfNoCaptain(t, row.team_id);
  });
}

// Disbanding: everyone comes off the team, and its queue entry or match goes with them.
export async function disbandTeam(db, teamId) {
  await db.tx(async t => {
    await t.get(LOCK);
    await t.run('DELETE FROM team_members WHERE team_id = ?', teamId);
    await releaseIfNoCaptain(t, teamId);
  });
}

// A team with no captain can't answer anything: take it out of the queue and cancel its match,
// so the other team isn't left waiting on it.
async function releaseIfNoCaptain(t, teamId) {
  if (await t.get("SELECT 1 AS x FROM team_members WHERE team_id = ? AND role = 'captain'", teamId)) return;
  await t.run("UPDATE queue_entries SET status = 'cancelled', updated_at = now() WHERE team_id = ? AND status = 'waiting'", teamId);
  const m = await activeMatch(t, teamId);
  if (m) await cancelMatch(t, m, `${m.team_a_id === teamId ? m.team_a : m.team_b} disbanded`, [otherTeamId(m, teamId)]);
}

// Cancels a match. Teams listed in `requeue` go back to waiting and keep their place in line;
// the others leave the queue.
async function cancelMatch(t, m, reason, requeue) {
  await t.run("UPDATE matches SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, m.id);
  for (const [teamId, entryId] of [[m.team_a_id, m.queue_entry_a_id], [m.team_b_id, m.queue_entry_b_id]]) {
    await t.run(`UPDATE queue_entries SET updated_at = now(),
      status = CASE WHEN available_until > now() THEN ? ELSE 'expired' END WHERE id = ?`,
    requeue.includes(teamId) ? 'waiting' : 'cancelled', entryId);
  }
}

const expireEntries = t => t.run("UPDATE queue_entries SET status = 'expired', updated_at = now() WHERE status = 'waiting' AND available_until <= now()");

// ---------- queue ----------

export async function joinQueue(db, userId, input = {}) {
  const team = await captainTeam(db, userId);
  const mode = input.mode || 'scrim';
  if (!MODES.includes(mode)) throw new UserError('Mode must be scrim or ranked.');
  const size = whole(input.team_size, 5, 1, 5, 'Team size');
  const minutes = whole(input.minutes, 60, 5, 720, 'Minutes available');
  const skillMin = optional(input.skill_min, 'Skill minimum'), skillMax = optional(input.skill_max, 'Skill maximum');
  if (skillMin !== null && skillMax !== null && skillMin > skillMax) throw new UserError("Skill minimum can't be above skill maximum.");

  const entry = await db.tx(async t => {
    await t.get(LOCK);
    await expireEntries(t);
    if (await t.get("SELECT 1 AS x FROM queue_entries WHERE team_id = ? AND status = 'waiting'", team.id)) {
      throw new UserError(`${team.name} is already in the queue.`, 409);
    }
    const m = await activeMatch(t, team.id);
    if (m) throw new UserError(`${team.name} already has a match: ${m.team_a} vs ${m.team_b}. Finish it first.`, 409);
    return t.get(`INSERT INTO queue_entries (team_id, queued_by_user_id, mode, team_size, available_until, skill_min, skill_max)
      VALUES (?, ?, ?, ?, now() + make_interval(mins => ?), ?, ?) RETURNING *`, team.id, userId, mode, size, minutes, skillMin, skillMax);
  });
  const made = await runMatcher(db); // the matcher runs on every new entry, and on the bot's timer
  return { team, entry, match: made.find(m => m.team_a_id === team.id || m.team_b_id === team.id) ?? null };
}

// For testing alone: queues an empty team under a made-up captain. Nobody can answer for it, so a
// match against it shows the thread and the match card, then cancels at the accept timeout.
export const FAKE_DISCORD_ID = '100000000000000000';
export async function queueFakeOpponent(db, input = {}) {
  const fake = await upsertUser(db, { discordId: FAKE_DISCORD_ID, name: 'Test opponent' });
  if (!(await memberTeam(db, fake.id))) {
    const empty = await db.get(`SELECT id FROM teams t
      WHERE NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id) ORDER BY id LIMIT 1`);
    if (!empty) throw new UserError('Every team has members, so no empty team can stand in as the opponent.');
    await setMember(db, empty.id, fake.id, 'captain');
  }
  return joinQueue(db, fake.id, input);
}

export async function leaveQueue(db, userId) {
  const team = await captainTeam(db, userId);
  const res = await db.run("UPDATE queue_entries SET status = 'cancelled', updated_at = now() WHERE team_id = ? AND status = 'waiting'", team.id);
  if (!res.changes) throw new UserError(`${team.name} isn't in the queue.`, 409);
  return { team };
}

// What the caller's team is doing right now. Any member may look.
export async function queueStatus(db, userId) {
  const team = await memberTeam(db, userId);
  if (!team) return { team: null, entry: null, match: null };
  const entry = await db.get("SELECT * FROM queue_entries WHERE team_id = ? AND status = 'waiting' AND available_until > now()", team.id);
  return { team, entry: entry ?? null, match: (await activeMatch(db, team.id)) ?? null };
}

// The public queue. Skill ratings and skill windows are left out on purpose.
export const listQueue = db => db.all(`SELECT q.id, q.team_id, t.name AS team, q.mode, q.team_size, q.created_at, q.available_until
  FROM queue_entries q JOIN teams t ON t.id = q.team_id
  WHERE q.status = 'waiting' AND q.available_from <= now() AND q.available_until > now()
  ORDER BY q.created_at, q.id`);

// ---------- matcher ----------

// An entry's skill window, or just its own rating when it set no window. Two entries can meet
// when these overlap; with no windows at all, anyone can meet anyone.
const skillRange = e => (e.skill_min === null && e.skill_max === null
  ? [e.skill_rating, e.skill_rating]
  : [e.skill_min ?? -Infinity, e.skill_max ?? Infinity]);
function skillsOverlap(a, b) {
  if (a.skill_min === null && a.skill_max === null && b.skill_min === null && b.skill_max === null) return true;
  const [aLow, aHigh] = skillRange(a), [bLow, bHigh] = skillRange(b);
  return aLow <= bHigh && bLow <= aHigh;
}

// Pairs waiting teams, first come first served. Returns the matches it created.
export async function runMatcher(db) {
  return db.tx(async t => {
    await t.get(LOCK);

    // Accept timeouts: a team that accepted goes back in line, a team that never answered is taken out.
    const timedOut = await t.all(`${MATCH} WHERE m.status = 'pending_accept'
      AND m.created_at <= now() - make_interval(mins => ?)`, ACCEPT_MINUTES);
    for (const m of timedOut) {
      const accepted = [m.team_a_accepted && m.team_a_id, m.team_b_accepted && m.team_b_id].filter(Boolean);
      await cancelMatch(t, m, 'not accepted in time', accepted);
    }

    await expireEntries(t);

    // Everyone available now, oldest first. Each takes the oldest compatible entry behind it.
    const waiting = await t.all(`SELECT q.*, team.skill_rating FROM queue_entries q JOIN teams team ON team.id = q.team_id
      WHERE q.status = 'waiting' AND q.available_from <= now() ORDER BY q.created_at, q.id`);
    const taken = new Set();
    const created = [];
    for (const a of waiting) {
      if (taken.has(a.id)) continue;
      const b = waiting.find(e => e.id !== a.id && !taken.has(e.id) && e.team_id !== a.team_id
        && e.mode === a.mode && e.team_size === a.team_size && skillsOverlap(a, e));
      if (!b) continue;
      taken.add(a.id).add(b.id);
      const { id } = await t.get(`INSERT INTO matches (mode, team_size, team_a_id, team_b_id, queue_entry_a_id, queue_entry_b_id)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, a.mode, a.team_size, a.team_id, b.team_id, a.id, b.id);
      await t.run("UPDATE queue_entries SET status = 'matched', updated_at = now() WHERE id IN (?, ?)", a.id, b.id);
      created.push(await getMatch(t, id)); // the bot's next tick opens the thread and pings both captains
    }
    return created;
  });
}

// ---------- matches ----------

export async function respondToMatch(db, userId, accept) {
  const team = await captainTeam(db, userId);
  return db.tx(async t => {
    await t.get(LOCK);
    const m = await activeMatch(t, team.id);
    if (m?.status !== 'pending_accept') throw new UserError('No match is waiting for your answer.', 409);
    if (!accept) {
      await cancelMatch(t, m, `${team.name} declined`, [otherTeamId(m, team.id)]);
    } else {
      const side = m.team_a_id === team.id ? 'a' : 'b';
      const both = side === 'a' ? m.team_b_accepted : m.team_a_accepted;
      await t.run(`UPDATE matches SET team_${side}_accepted = true${both ? ", status = 'accepted', accepted_at = now()" : ''} WHERE id = ?`, m.id);
    }
    return { team, match: await getMatch(t, m.id) };
  });
}

// host: 'mine', 'theirs', or a team id.
export async function setHost(db, userId, host) {
  const team = await captainTeam(db, userId);
  const m = await activeMatch(db, team.id);
  if (!m || !['accepted', 'in_progress'].includes(m.status)) throw new UserError('You can set the host once both teams have accepted.', 409);
  const hostId = host === 'mine' ? team.id : host === 'theirs' ? otherTeamId(m, team.id) : Number(host);
  if (hostId !== m.team_a_id && hostId !== m.team_b_id) throw new UserError('The host must be one of the two teams.');
  await db.run("UPDATE matches SET host_team_id = ?, status = 'in_progress' WHERE id = ?", hostId, m.id);
  return { team, match: await getMatch(db, m.id) };
}

// score_a belongs to team A on the match card, score_b to team B. image is a data: URL.
// cfg is ingestConfig(env). Returns { team, match, warning }.
export async function reportResult(db, cfg, userId, { score_a: a, score_b: b, image }) {
  const team = await captainTeam(db, userId);
  const scoreA = whole(a, NaN, 0, 400, 'Score'), scoreB = whole(b, NaN, 0, 400, 'Score');
  if (scoreA === scoreB) throw new UserError("A game can't end in a tie.");
  const screenshotId = await storeScreenshot(db, image);

  const match = await db.tx(async t => {
    await t.get(LOCK);
    const m = await activeMatch(t, team.id);
    if (m?.status === 'awaiting_result') throw new UserError('A result is already reported. The other captain can confirm or dispute it.', 409);
    if (!m || !['accepted', 'in_progress'].includes(m.status)) throw new UserError('You have no match to report.', 409);
    await t.run(`INSERT INTO match_results (match_id, winner_team_id, team_a_score, team_b_score, screenshot_id, submitted_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)`, m.id, scoreA > scoreB ? m.team_a_id : m.team_b_id, scoreA, scoreB, screenshotId, userId);
    await t.run("UPDATE matches SET status = 'awaiting_result' WHERE id = ?", m.id);
    return getMatch(t, m.id);
  });

  // The existing reader only knows 5v5 box scores. Its verdict is advice for the other captain; it
  // never blocks. When its score agrees with the report, the player lines are saved as scrim stats.
  let warning = null;
  if (match.team_size === 5 && cfg?.apiKey) {
    try {
      const read = await ingestScreenshot(db, cfg, { image });
      if (read.lines) { // absent when this exact image is already saved as a league game
        // A screenshot names no teams, so its sides are matched to team A and B by their scores.
        const awayTeamId = read.away_score === scoreA && read.home_score === scoreB ? match.team_a_id
          : read.away_score === scoreB && read.home_score === scoreA ? match.team_b_id : null;
        if (awayTeamId) await saveScrimBox(db, match, read.lines, awayTeamId);
        else warning = `The screenshot reads ${read.away_score}-${read.home_score}, but ${scoreA}-${scoreB} was reported. Player stats were not saved.`;
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      warning = `The screenshot could not be checked: ${err.message}`;
    }
  }
  return { team, match, warning };
}

// Scrim stats: one scrim_box_scores row per human player in the reading. Nothing is added to
// `players` or to the league's box_scores; a name that matched a league player keeps that link.
async function saveScrimBox(db, match, lines, awayTeamId) {
  const homeTeamId = otherTeamId(match, awayTeamId);
  await db.tx(async t => {
    await t.run('DELETE FROM scrim_box_scores WHERE match_id = ?', match.id);
    for (const l of lines.filter(line => !line.ai)) {
      await t.run(`INSERT INTO scrim_box_scores (match_id, team_id, player_id, name, ${STAT_KEYS.join(', ')})
        VALUES (?, ?, ?, ?, ${STAT_KEYS.map(() => '?').join(', ')})`,
      match.id, l.side === 'away' ? awayTeamId : homeTeamId, l.match?.player_id ?? null, String(l.read_as).slice(0, 64),
      ...STAT_KEYS.map(k => l.stats[k] ?? 0));
    }
  });
}

// The other team's captain confirms the reported result. A commissioner (admin) may confirm any match by id.
export async function confirmResult(db, userId, { admin = false, matchId = null } = {}) {
  const team = admin ? null : await captainTeam(db, userId);
  return db.tx(async t => {
    await t.get(LOCK);
    const m = admin ? await getMatch(t, matchId) : await activeMatch(t, team.id);
    if (m?.status !== 'awaiting_result') throw new UserError('There is no reported result to confirm.', 409);
    if (team) {
      const reporter = await memberTeam(t, m.submitted_by_user_id);
      if (reporter?.id === team.id) throw new UserError('The other team confirms the result you reported.', 403);
    }
    await t.run('UPDATE match_results SET verified = true, verified_by_user_id = ? WHERE match_id = ?', userId ?? null, m.id);
    await t.run("UPDATE matches SET status = 'completed', completed_at = now() WHERE id = ?", m.id);
    // RATING HOOK: when m.mode === 'ranked', adjust teams.skill_rating here (for example +25 for
    // m.winner_team_id and -25 for the other team). Nothing changes ratings yet.
    return { team, match: await getMatch(t, m.id) };
  });
}

export async function disputeMatch(db, userId) {
  const team = await captainTeam(db, userId);
  const m = await activeMatch(db, team.id);
  if (!m || m.status === 'pending_accept') throw new UserError('You have no match to dispute.', 409);
  await db.run("UPDATE matches SET status = 'disputed' WHERE id = ?", m.id);
  return { team, match: await getMatch(db, m.id) };
}

export const listMatches = (db, limit = 50) => db.all(`${MATCH} ORDER BY m.id DESC LIMIT ?`, limit);

export async function matchDetail(db, id) {
  const m = await getMatch(db, id);
  if (!m) throw new UserError('Match not found.', 404);
  return m;
}

// ---------- for the bot ----------

// Matches whose current status has not been posted in their thread yet (new ones have no thread).
export const matchesToAnnounce = db => db.all(`${MATCH} WHERE m.announced_status IS DISTINCT FROM m.status ORDER BY m.id`);
export const setThread = (db, id, threadId) => db.run('UPDATE matches SET discord_thread_id = ? WHERE id = ?', threadId, id);
export const markAnnounced = (db, id, status) => db.run('UPDATE matches SET announced_status = ? WHERE id = ?', status, id);

// Threads are archived 24 hours after the result is confirmed.
export const threadsToArchive = db => db.all(`SELECT id, discord_thread_id FROM matches
  WHERE status = 'completed' AND NOT thread_archived AND discord_thread_id IS NOT NULL
    AND completed_at <= now() - interval '24 hours'`);
export const markArchived = (db, id) => db.run('UPDATE matches SET thread_archived = true WHERE id = ?', id);

// Discord ids of both teams' members, with their team and role. The test opponent is not a real account.
export const matchMembers = (db, m) => db.all(`SELECT u.discord_id, tm.team_id, tm.role
  FROM team_members tm JOIN users u ON u.id = tm.user_id
  WHERE tm.team_id IN (?, ?) AND u.discord_id <> ?`, m.team_a_id, m.team_b_id, FAKE_DISCORD_ID);

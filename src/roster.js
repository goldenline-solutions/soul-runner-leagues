// Roster management. Rosters live in roster_slots (seven slots per team), the same rows the site
// shows. The rule this file enforces: a player is on at most ONE team per league (one Premier
// team and one Affiliate team is allowed; two teams in the same league never is).
//
// Who may change a roster: commissioners can do everything. A team's owners and captains
// (team_staff) can do three things for their own team only: sign a player from the free agent
// pool, release a player, and change a player's slot. Callers pass `actor`:
// { commissioner: true } or { commissioner: false, discordId }. No actor means a commissioner.
//
// Every change runs under one lock and is written to roster_moves. Functions that change who is
// on a team return `roles`: which Discord roles the bot should add and remove (bot/roster.js).
// Nothing here talks to Discord.
import { ROSTER_SLOTS } from './seed.js';
import { UserError } from './league.js';

// Serializes roster changes, so two commissioners can't sign the same player at the same moment.
const LOCK = 'SELECT pg_advisory_xact_lock(727277)';
const TEAM = 'SELECT t.id, t.name, t.league_id, t.discord_role_id, l.name AS league FROM teams t JOIN leagues l ON l.id = t.league_id';
const SPOTS = `SELECT rs.slot, t.id AS team_id, t.name AS team, t.league_id, t.discord_role_id, l.name AS league
  FROM roster_slots rs JOIN teams t ON t.id = rs.team_id JOIN leagues l ON l.id = t.league_id`;

async function getTeam(t, teamId) {
  const team = await t.get(`${TEAM} WHERE t.id = ?`, teamId);
  if (!team) throw new UserError('Team not found.', 404);
  return team;
}

// Every roster spot a player holds: at most one per league.
const spotsOf = (t, playerId) => t.all(`${SPOTS} WHERE rs.player_id = ? ORDER BY l.sort, t.name`, playerId);
const log = (t, playerId, action, fromTeamId, toTeamId, by) => t.run(`INSERT INTO roster_moves
  (player_id, action, from_team_id, to_team_id, by_discord_id) VALUES (?, ?, ?, ?, ?)`, playerId, action, fromTeamId, toTeamId, by ?? null);
const roleIds = (...ids) => ids.filter(Boolean);

const isStaff = (t, teamId, discordId) => t.get('SELECT role FROM team_staff WHERE team_id = ? AND discord_id = ?', teamId, String(discordId));
const limited = actor => Boolean(actor) && !actor.commissioner;
// Owners and captains act only for their own team.
async function mustManage(t, actor, team) {
  if (limited(actor) && !(await isStaff(t, team.id, actor.discordId))) {
    throw new UserError(`You can only do that for a team you own or captain, and ${team.name} is not one. Ask a commissioner.`, 403);
  }
}

// The player record for a Discord member { id, name }. A record already linked to the account
// wins; otherwise an unlinked record with the same name is linked; otherwise one is created.
async function playerFor(t, member, { create = true } = {}) {
  const linked = await t.get('SELECT * FROM players WHERE discord_id = ?', String(member.id));
  if (linked) return linked;
  const named = await t.get('SELECT * FROM players WHERE lower(discord_tag) = lower(?)', member.name);
  if (named?.discord_id) {
    throw new UserError(`The player record "${named.discord_tag}" belongs to a different Discord account. Link this member to their own record with /roster link.`, 409);
  }
  if (named) return t.get('UPDATE players SET discord_id = ? WHERE id = ? RETURNING *', String(member.id), named.id);
  if (!create) return null;
  return t.get('INSERT INTO players (discord_tag, discord_id) VALUES (?, ?) RETURNING *', String(member.name).slice(0, 64), String(member.id));
}

// The slot a signing lands in: the one asked for (it must be empty), else the first empty one.
async function emptySlot(t, team, wanted) {
  const empty = (await t.all('SELECT slot FROM roster_slots WHERE team_id = ? AND player_id IS NULL', team.id)).map(r => r.slot);
  if (wanted) {
    if (!ROSTER_SLOTS.includes(wanted)) throw new UserError(`Slot must be one of ${ROSTER_SLOTS.join(', ')}.`);
    if (!empty.includes(wanted)) throw new UserError(`${team.name}'s ${wanted} slot is taken. Release or move that player first.`, 409);
    return wanted;
  }
  const slot = ROSTER_SLOTS.find(s => empty.includes(s));
  if (!slot) throw new UserError(`${team.name}'s roster is full (${ROSTER_SLOTS.length} players). Release someone first.`, 409);
  return slot;
}

// ---------- signing, releasing, moving ----------

// Signs a member to a team. Refused when they already have a team in that league.
export async function sign(db, { teamId, member, slot, by, actor }) {
  return db.tx(async t => {
    await t.get(LOCK);
    const team = await getTeam(t, teamId);
    await mustManage(t, actor, team);
    const player = await playerFor(t, member);
    const current = (await spotsOf(t, player.id)).find(s => s.league_id === team.league_id);
    // A free agent is someone in the pool, or someone holding the free agent role in Discord
    // (member.freeAgentRole, read by the bot), for members given the role by hand.
    if (limited(actor) && !current && !player.free_agent && !member.freeAgentRole) {
      throw new UserError(`${member.name} is not a free agent, so only a commissioner can sign them. A commissioner adds them with /roster freeagent, or gives them the free agent role.`, 403);
    }
    if (current) {
      throw new UserError(current.team_id === team.id
        ? `${player.discord_tag} is already on ${team.name} (${current.slot}).`
        : `${player.discord_tag} is already signed to ${current.team} in ${team.league}. Use /roster move to change teams, or release them first.`, 409);
    }
    const into = await emptySlot(t, team, slot);
    await t.run('UPDATE roster_slots SET player_id = ? WHERE team_id = ? AND slot = ?', player.id, team.id, into);
    await t.run('UPDATE players SET free_agent = false WHERE id = ?', player.id);
    await log(t, player.id, 'sign', null, team.id, by);
    return { player, team, slot: into, roles: { add: roleIds(team.discord_role_id), remove: [], freeAgent: false } };
  });
}

// Releases a member from a team. `teamId` is only needed when they are on a team in each league.
// Left with no team at all, they go into the free agent pool.
export async function release(db, { member, teamId = null, by, actor }) {
  return db.tx(async t => {
    await t.get(LOCK);
    const player = await playerFor(t, member, { create: false });
    const spots = player ? await spotsOf(t, player.id) : [];
    if (!spots.length) throw new UserError(`${member.name} is not on any roster.`, 404);
    if (!teamId && spots.length > 1) throw new UserError(`${player.discord_tag} is on ${spots.map(s => s.team).join(' and ')}. Say which team to release them from.`);
    const spot = teamId ? spots.find(s => s.team_id === teamId) : spots[0];
    if (!spot) throw new UserError(`${player.discord_tag} is not on that team. They are on ${spots.map(s => s.team).join(' and ')}.`, 404);
    await mustManage(t, actor, { id: spot.team_id, name: spot.team });

    await t.run('UPDATE roster_slots SET player_id = NULL WHERE team_id = ? AND slot = ?', spot.team_id, spot.slot);
    const freeAgent = spots.length === 1;
    if (freeAgent) await t.run('UPDATE players SET free_agent = true WHERE id = ?', player.id);
    await log(t, player.id, 'release', spot.team_id, null, by);
    // An owner or captain of the team keeps its role even when they come off the roster.
    const keepsRole = await isStaff(t, spot.team_id, member.id);
    return { player, team: { id: spot.team_id, name: spot.team }, freeAgent, roles: { add: [], remove: keepsRole ? [] : roleIds(spot.discord_role_id), freeAgent } };
  });
}

// Moves a member to another team in the same league (a trade or transfer) in one step, so there
// is no moment where they are on both or on neither. On their own team it changes their slot.
export async function move(db, { member, teamId, slot, by, actor }) {
  return db.tx(async t => {
    await t.get(LOCK);
    const team = await getTeam(t, teamId);
    const player = await playerFor(t, member, { create: false });
    const from = player && (await spotsOf(t, player.id)).find(s => s.league_id === team.league_id);
    if (!from) throw new UserError(`${member.name} has no ${team.league} team to move from. Use /roster sign.`, 404);
    if (from.team_id === team.id && (!slot || slot === from.slot)) throw new UserError(`${player.discord_tag} is already on ${team.name} (${from.slot}).`, 409);
    if (limited(actor)) {
      if (from.team_id !== team.id) throw new UserError('Moving a player between teams is a trade: only a commissioner can do that. You can change the slot of a player on your own team.', 403);
      await mustManage(t, actor, team);
    }

    const into = await emptySlot(t, team, slot);
    await t.run('UPDATE roster_slots SET player_id = NULL WHERE team_id = ? AND slot = ?', from.team_id, from.slot);
    await t.run('UPDATE roster_slots SET player_id = ? WHERE team_id = ? AND slot = ?', player.id, team.id, into);
    await log(t, player.id, 'move', from.team_id, team.id, by);
    const changedTeam = from.team_id !== team.id;
    const leaves = changedTeam && !(await isStaff(t, from.team_id, member.id));
    return {
      player, team, slot: into, from: { id: from.team_id, name: from.team, slot: from.slot },
      roles: { add: changedTeam ? roleIds(team.discord_role_id) : [], remove: leaves ? roleIds(from.discord_role_id) : [], freeAgent: false },
    };
  });
}

// ---------- free agents ----------

// Puts a member with no team into the free agent pool.
export async function addFreeAgent(db, { member, by }) {
  return db.tx(async t => {
    await t.get(LOCK);
    const player = await playerFor(t, member);
    const spots = await spotsOf(t, player.id);
    if (spots.length) throw new UserError(`${player.discord_tag} is on ${spots.map(s => s.team).join(' and ')}. Release them first.`, 409);
    if (player.free_agent) throw new UserError(`${player.discord_tag} is already a free agent.`, 409);
    await t.run('UPDATE players SET free_agent = true WHERE id = ?', player.id);
    await log(t, player.id, 'free_agent', null, null, by);
    return { player, roles: { add: [], remove: [], freeAgent: true } };
  });
}

export const freeAgents = db => db.all(`SELECT p.id, p.discord_tag AS tag, p.discord_id,
    (SELECT MAX(m.created_at) FROM roster_moves m WHERE m.player_id = p.id) AS since
  FROM players p WHERE p.free_agent ORDER BY since NULLS LAST, lower(p.discord_tag)`);

// ---------- owners and captains ----------

export const STAFF_ROLES = ['owner', 'captain'];

// Makes a member an owner or captain of a team, or (role null) takes that away.
// `roles.owner` / `roles.captain` say whether they should hold the server-wide Owner and Captain
// roles afterwards: true while they hold that position on any team.
export async function setStaff(db, { teamId, member, role }) {
  if (role !== null && !STAFF_ROLES.includes(role)) throw new UserError('Position must be owner or captain.');
  return db.tx(async t => {
    await t.get(LOCK);
    const team = await getTeam(t, teamId);
    if (role) {
      await t.run(`INSERT INTO team_staff (team_id, discord_id, discord_name, role) VALUES (?, ?, ?, ?)
        ON CONFLICT (team_id, discord_id) DO UPDATE SET role = excluded.role, discord_name = excluded.discord_name`,
      team.id, String(member.id), String(member.name).slice(0, 64), role);
    } else {
      if (!(await isStaff(t, team.id, member.id))) throw new UserError(`${member.name} is not an owner or captain of ${team.name}.`, 404);
      await t.run('DELETE FROM team_staff WHERE team_id = ? AND discord_id = ?', team.id, String(member.id));
    }
    const now = (await t.all('SELECT role FROM team_staff WHERE discord_id = ?', String(member.id))).map(r => r.role);
    // Coming off the staff, they keep the team role only if they still play for the team.
    const plays = await t.get(`SELECT 1 AS x FROM roster_slots rs JOIN players p ON p.id = rs.player_id
      WHERE rs.team_id = ? AND p.discord_id = ?`, team.id, String(member.id));
    return {
      team, role,
      roles: {
        add: role ? roleIds(team.discord_role_id) : [], remove: role || plays ? [] : roleIds(team.discord_role_id),
        owner: now.includes('owner'), captain: now.includes('captain'),
      },
    };
  });
}

export const teamStaff = (db, teamId) => db.all(`SELECT discord_id, discord_name, role FROM team_staff
  WHERE team_id = ? ORDER BY role DESC, lower(discord_name)`, teamId);

// ---------- records, roles, reading ----------

// Connects a Discord member to a player record that already exists (typed on the site, or
// created from a box score), so their history and roster spot stay with them.
export async function link(db, { member, playerId }) {
  return db.tx(async t => {
    await t.get(LOCK);
    const target = await t.get('SELECT * FROM players WHERE id = ?', playerId);
    if (!target) throw new UserError('Player record not found.', 404);
    if (target.discord_id === String(member.id)) throw new UserError(`${member.name} is already linked to "${target.discord_tag}".`, 409);
    if (target.discord_id) throw new UserError(`"${target.discord_tag}" is already linked to another Discord account.`, 409);
    const own = await t.get('SELECT * FROM players WHERE discord_id = ?', String(member.id));
    if (own) throw new UserError(`${member.name} is already linked to the record "${own.discord_tag}". Two records for one person have to be merged by hand.`, 409);
    const player = await t.get('UPDATE players SET discord_id = ? WHERE id = ? RETURNING *', String(member.id), playerId);
    const spots = await spotsOf(t, playerId);
    return { player, spots, roles: { add: roleIds(...spots.map(s => s.discord_role_id)), remove: [], freeAgent: player.free_agent } };
  });
}

// The Discord role members of a team get. Pass null to clear it.
export async function setTeamRole(db, teamId, roleId) {
  const team = await getTeam(db, teamId);
  await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', roleId ? String(roleId) : null, teamId);
  return team;
}

// ---------- finding roles by name ----------

const plain = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Pairs teams with Discord roles by name. `roles` is [{ id, name }].
// A role named exactly like the team wins ("Bangladesh" or "bangladesh!"); otherwise the role
// name has to contain the team name, or the other way round ("Team Bangladesh"). A pairing is only
// made when it is the single candidate on both sides: one role for the team, one team for the role.
// Returns { matched: [{ team, role }], unsure: [{ team, roles }], none: [team] }.
export function matchTeamRoles(teams, roles) {
  const candidates = team => {
    const name = plain(team.name);
    const exact = roles.filter(r => plain(r.name) === name);
    if (exact.length) return exact;
    return name.length < 4 ? [] : roles.filter(r => {
      const role = plain(r.name);
      return role.length >= 4 && (role.includes(name) || name.includes(role));
    });
  };
  const found = teams.map(team => ({ team, roles: candidates(team) }));
  const claims = roleId => found.filter(f => f.roles.length === 1 && f.roles[0].id === roleId).length;
  const out = { matched: [], unsure: [], none: [] };
  for (const f of found) {
    if (!f.roles.length) out.none.push(f.team);
    else if (f.roles.length === 1 && claims(f.roles[0].id) === 1) out.matched.push({ team: f.team, role: f.roles[0] });
    else out.unsure.push(f);
  }
  return out;
}

// The server-wide roles, found by what they are usually called.
export const SPECIAL_ROLES = {
  commissioner: /commissioner|commish/i,
  freeAgent: /free\s*agents?|^fa$/i,
  owner: /owner/i,
  captain: /captain/i,
};
const SPECIAL_KEY = 'roster_roles';

// Role ids saved by /roster autoroles: { commissioner, freeAgent, owner, captain }, each optional.
export async function savedRoles(db) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', SPECIAL_KEY);
  return row ? JSON.parse(row.value) : {};
}

// Scans the server's roles and fills in what is not set yet: each team's role, and the four
// server-wide roles. Nothing already set is changed. `have` is the server-wide roles already
// known (from .env or an earlier run). Returns what it did, for the reply.
export async function autoAssignRoles(db, roles, have = {}) {
  const teams = await db.all(`${TEAM} ORDER BY l.sort, t.name`);
  const taken = new Set(teams.map(team => team.discord_role_id).filter(Boolean));
  const free = roles.filter(r => !taken.has(r.id));
  const result = matchTeamRoles(teams.filter(team => !team.discord_role_id), free);
  for (const { team, role } of result.matched) await db.run('UPDATE teams SET discord_role_id = ? WHERE id = ?', role.id, team.id);

  const special = { set: [], unsure: [], none: [] };
  const saved = await savedRoles(db);
  for (const [key, pattern] of Object.entries(SPECIAL_ROLES)) {
    if (have[key]) continue;
    const hits = roles.filter(r => pattern.test(r.name.trim()));
    if (hits.length === 1) { saved[key] = hits[0].id; special.set.push({ key, role: hits[0] }); }
    else if (hits.length) special.unsure.push({ key, roles: hits });
    else special.none.push(key);
  }
  await db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, SPECIAL_KEY, JSON.stringify(saved));
  return { ...result, alreadySet: teams.filter(team => team.discord_role_id).length, special };
}

export async function teamRoster(db, teamId) {
  const team = await getTeam(db, teamId);
  const rows = await db.all(`SELECT rs.slot, p.id AS player_id, p.discord_tag AS tag, p.discord_id
    FROM roster_slots rs LEFT JOIN players p ON p.id = rs.player_id WHERE rs.team_id = ?`, teamId);
  return { team, staff: await teamStaff(db, teamId), slots: ROSTER_SLOTS.map(slot => rows.find(r => r.slot === slot) ?? { slot, player_id: null }) };
}

// Used by the site's roster editor too: the team in this league that already has the player.
export const otherTeamInLeague = (db, playerId, team) => db.get(`${SPOTS}
  WHERE rs.player_id = ? AND t.league_id = ? AND t.id <> ?`, playerId, team.league_id, team.id);

// What Discord should look like, for /roster sync: every linked player, owner and captain with the
// roles they should hold, plus the things a commissioner has to fix by hand.
export async function audit(db) {
  const teams = await db.all(`${TEAM} ORDER BY l.sort, t.name`);
  const spots = await db.all(`${SPOTS} WHERE rs.player_id IS NOT NULL`);
  const held = await db.all(`SELECT rs.player_id, t.id AS team_id, t.name AS team, t.league_id, t.discord_role_id, p.discord_tag AS tag, p.discord_id
    FROM roster_slots rs JOIN teams t ON t.id = rs.team_id JOIN players p ON p.id = rs.player_id`);
  const problems = [];

  const seen = new Map(); // player + league -> first team
  for (const h of held) {
    const key = `${h.player_id}:${h.league_id}`;
    if (seen.has(key)) problems.push(`${h.tag} is on two teams in one league: ${seen.get(key)} and ${h.team}. Release them from one.`);
    else seen.set(key, h.team);
  }
  const unlinked = held.filter(h => !h.discord_id).map(h => h.tag);
  if (unlinked.length) problems.push(`On a roster but not linked to a Discord account (use /roster link): ${[...new Set(unlinked)].join(', ')}`);
  const noRole = teams.filter(team => !team.discord_role_id && spots.some(s => s.team_id === team.id)).map(team => team.name);
  if (noRole.length) problems.push(`Teams with no Discord role (use /roster setrole): ${noRole.join(', ')}`);

  // One entry per Discord account: linked players, plus owners and captains (who may not play).
  const members = new Map();
  const entry = (discordId, tag) => {
    if (!members.has(discordId)) members.set(discordId, { tag, discord_id: discordId, freeAgent: false, roleIds: [], owner: false, captain: false });
    return members.get(discordId);
  };
  for (const p of await db.all('SELECT id, discord_tag AS tag, discord_id, free_agent FROM players WHERE discord_id IS NOT NULL ORDER BY id')) {
    const e = entry(p.discord_id, p.tag);
    e.freeAgent = p.free_agent;
    e.roleIds.push(...roleIds(...held.filter(h => h.player_id === p.id).map(h => h.discord_role_id)));
  }
  for (const st of await db.all('SELECT team_id, discord_id, discord_name, role FROM team_staff ORDER BY team_id')) {
    const e = entry(st.discord_id, st.discord_name);
    e[st.role] = true;
    const role = teams.find(team => team.id === st.team_id)?.discord_role_id;
    if (role && !e.roleIds.includes(role)) e.roleIds.push(role);
  }
  return { teamRoleIds: roleIds(...teams.map(team => team.discord_role_id)), members: [...members.values()], problems };
}

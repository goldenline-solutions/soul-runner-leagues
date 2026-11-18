// What a person logged in with Discord may do on the site, from their roles in the league's server:
//   the Commissioner role                      -> commissioner (every commissioner page and action)
//   the Owner role + a team's role             -> manages that team's roster (captains do not)
// Role ids come from .env (COMMISSIONER_ROLE_ID, OWNER_ROLE_ID) or, when not set
// there, from what /roster autoroles saved. Team roles are teams.discord_role_id.
//
// Roles are read at login. They are read again every 10 minutes when the site has the bot's token
// (DISCORD_TOKEN); without it they count for 12 hours, then the person logs in again. So taking a
// role away in Discord takes the access away within 10 minutes, or within 12 hours without the token.
import { savedRoles } from './roster.js';

export const REFRESH_MS = 10 * 60e3;
export const ROLE_TTL_MS = 12 * 3600e3;
const NONE = { user: null, commissioner: false, teams: [], expired: false };

export async function roleIds(db, env) {
  const saved = await savedRoles(db);
  return {
    commissioner: env.COMMISSIONER_ROLE_ID || saved.commissioner || '',
    owner: env.OWNER_ROLE_ID || saved.owner || '',
  };
}

export const saveRoles = (db, userId, roles) => db.run('UPDATE users SET discord_roles = ?, roles_checked_at = now() WHERE id = ?',
  JSON.stringify(roles), userId);

// { user, commissioner, teams: [team ids], expired }. expired: the roles are too old to count and
// could not be re-read, so the person has to log in again to get their access back.
export async function accessFor(db, env, discord, userId, now = Date.now()) {
  if (!userId) return NONE;
  const user = await db.get('SELECT id, discord_id, discord_name, discord_roles, roles_checked_at FROM users WHERE id = ?', userId);
  if (!user) return NONE;
  let roles = user.discord_roles ? JSON.parse(user.discord_roles) : [];
  const age = user.roles_checked_at ? now - new Date(user.roles_checked_at).getTime() : Infinity;
  let expired = false;
  if (age > REFRESH_MS && discord.canRefresh) {
    const fresh = await discord.memberRoles(user.discord_id);
    if (fresh) {
      roles = fresh;
      await saveRoles(db, user.id, roles);
    } else if (age > ROLE_TTL_MS) expired = true;
  } else if (age > ROLE_TTL_MS) expired = true;
  if (expired) roles = [];

  const ids = await roleIds(db, env);
  const has = id => Boolean(id) && roles.includes(id);
  const teams = has(ids.owner)
    ? (await db.all('SELECT id, discord_role_id FROM teams WHERE discord_role_id IS NOT NULL')).filter(t => roles.includes(t.discord_role_id)).map(t => t.id)
    : [];
  return { user, commissioner: has(ids.commissioner), teams, expired: expired && Boolean(user.discord_roles) };
}

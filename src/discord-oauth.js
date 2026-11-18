// "Log in with Discord" for the site. The Discord user id links a browser session to a row in
// `users` (and so to a team). With DISCORD_GUILD_ID set, the login also asks for the member's
// roles in that server (scope guilds.members.read): src/access.js turns those into commissioner
// and team owner access. The redirect URL to register in the Discord developer portal is
// SITE_URL + /api/auth/discord/callback.
import { UserError } from './league.js';

const API = 'https://discord.com/api';

export function discordOAuth(env, fetchImpl = fetch) {
  const redirectUri = `${String(env.SITE_URL || '').replace(/\/$/, '')}/api/auth/discord/callback`;
  const enabled = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SITE_URL);
  const guild = String(env.DISCORD_GUILD_ID || '');
  const check = () => {
    if (!enabled) throw new UserError('Discord login is not set up on this server.', 503);
  };

  return {
    enabled,
    // Roles can be read at login: the server id is known.
    roles: enabled && Boolean(guild),
    // Roles can also be re-read between logins, with the bot's token.
    canRefresh: Boolean(guild && env.DISCORD_TOKEN),
    authorizeUrl(state) {
      check();
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: guild ? 'identify guilds.members.read' : 'identify',
        redirect_uri: redirectUri, state,
      })}`;
    },
    // Trades the ?code= Discord sent back for the member's { id, username, roles }.
    // roles: their role ids in the league's server; [] when they are not in it or it could not be read.
    async profile(code) {
      check();
      const token = await fetchImpl(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code: String(code || ''), redirect_uri: redirectUri,
        }),
      });
      if (!token.ok) throw new UserError('Discord did not accept that login. Try again.', 400);
      const headers = { Authorization: `Bearer ${(await token.json()).access_token}` };
      const me = await fetchImpl(`${API}/users/@me`, { headers });
      if (!me.ok) throw new UserError('Discord did not accept that login. Try again.', 400);
      const profile = await me.json();
      let roles = [];
      if (guild) {
        const member = await fetchImpl(`${API}/users/@me/guilds/${guild}/member`, { headers }).catch(() => null);
        if (member?.ok) roles = ((await member.json()).roles || []).map(String);
      }
      return { ...profile, roles };
    },
    // A member's current role ids, read with the bot token. [] when they left the server; null
    // when Discord could not be reached (the caller keeps what it had).
    async memberRoles(discordId) {
      if (!guild || !env.DISCORD_TOKEN) return null;
      try {
        const res = await fetchImpl(`${API}/guilds/${guild}/members/${encodeURIComponent(discordId)}`, {
          headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` }, signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) return [];
        return res.ok ? ((await res.json()).roles || []).map(String) : null;
      } catch {
        return null;
      }
    },
  };
}

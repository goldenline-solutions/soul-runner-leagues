// "Log in with Discord" for the site. Only the `identify` scope: all the site needs is the Discord
// user id, which is what links a browser session to a row in `users` (and so to a team).
// The redirect URL to register in the Discord developer portal is SITE_URL + /api/auth/discord/callback.
import { UserError } from './league.js';

const API = 'https://discord.com/api';

export function discordOAuth(env, fetchImpl = fetch) {
  const redirectUri = `${String(env.SITE_URL || '').replace(/\/$/, '')}/api/auth/discord/callback`;
  const enabled = Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SITE_URL);
  const check = () => {
    if (!enabled) throw new UserError('Discord login is not set up on this server.', 503);
  };

  return {
    enabled,
    authorizeUrl(state) {
      check();
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify', redirect_uri: redirectUri, state,
      })}`;
    },
    // Trades the ?code= Discord sent back for the member's { id, username }.
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
      const me = await fetchImpl(`${API}/users/@me`, { headers: { Authorization: `Bearer ${(await token.json()).access_token}` } });
      if (!me.ok) throw new UserError('Discord did not accept that login. Try again.', 400);
      return me.json();
    },
  };
}

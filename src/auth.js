import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 14;
const ADMIN_COOKIE = 'sr_admin';
const VOTER_COOKIE = 'sr_voter';
const USER_COOKIE = 'sr_user';
const STATE_COOKIE = 'sr_oauth';

export function createAuth({ adminPassword, sessionSecret, secureCookies, requireSecret = false }) {
  const secret = sessionSecret || randomBytes(32).toString('hex');
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const attrs = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`;

  function passwordMatches(candidate) {
    if (!adminPassword || typeof candidate !== 'string') return false;
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(adminPassword).digest();
    return timingSafeEqual(a, b);
  }

  function sessionCookie() {
    const expires = Date.now() + SESSION_DAYS * 864e5;
    const token = `${expires}.${sign(String(expires))}`;
    return `${ADMIN_COOKIE}=${token}; ${attrs}; Max-Age=${SESSION_DAYS * 86400}`;
  }

  function isAdmin(cookies) {
    const [expires, sig] = (cookies[ADMIN_COOKIE] || '').split('.');
    if (!expires || !sig || Number(expires) < Date.now()) return false;
    const expected = Buffer.from(sign(expires));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  // Anonymous, signed visitor id so award votes are one-per-browser.
  function voterId(cookies) {
    const [id, sig] = (cookies[VOTER_COOKIE] || '').split('.');
    if (id && sig === sign(id)) return { id, cookie: null };
    const fresh = randomBytes(16).toString('hex');
    return { id: fresh, cookie: `${VOTER_COOKIE}=${fresh}.${sign(fresh)}; ${attrs}; Max-Age=${400 * 86400}` };
  }

  // Discord login (src/discord-oauth.js): a signed cookie holding the users.id.
  function userCookie(userId) {
    const body = `${userId}.${Date.now() + SESSION_DAYS * 864e5}`;
    return `${USER_COOKIE}=${body}.${sign(`user.${body}`)}; ${attrs}; Max-Age=${SESSION_DAYS * 86400}`;
  }

  function userId(cookies) {
    const [id, expires, sig] = (cookies[USER_COOKIE] || '').split('.');
    if (!id || !sig || Number(expires) < Date.now() || sig !== sign(`user.${id}.${expires}`)) return null;
    return Number(id);
  }

  // The random `state` sent to Discord and checked when it sends the browser back.
  function oauthState() {
    const state = randomBytes(16).toString('hex');
    return { state, cookie: `${STATE_COOKIE}=${state}; ${attrs}; Max-Age=600` };
  }

  return {
    userCookie,
    userId,
    clearUserCookie: `${USER_COOKIE}=; ${attrs}; Max-Age=0`,
    oauthState,
    stateMatches: (cookies, state) => Boolean(state) && cookies[STATE_COOKIE] === state,
    enabled: Boolean(adminPassword) && (Boolean(sessionSecret) || !requireSecret),
    passwordMatches,
    sessionCookie,
    clearCookie: `${ADMIN_COOKIE}=; ${attrs}; Max-Age=0`,
    isAdmin,
    voterId,
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

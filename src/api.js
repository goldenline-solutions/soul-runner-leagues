import { ROSTER_SLOTS } from './seed.js';
import { STAT_KEYS, UserError, saveGame, deleteGame, playerIdForTag } from './league.js';

const sumCols = STAT_KEYS.map(k => `SUM(b.${k})::int AS ${k}`).join(', ');

const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const required = (v, label, max) => {
  const s = text(v, max);
  if (!s) throw new UserError(`${label} is required.`);
  return s;
};
const percent = (v, label) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new UserError(`${label} must be between 0 and 100.`);
  }
  return n;
};
function streamUrl(v) {
  const s = text(v, 300);
  if (!s) return '';
  try {
    const url = new URL(s);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch {
    throw new UserError('Enter a valid http or https stream link.');
  }
}

async function getSetting(db, key) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : null;
}

// ---------- public ----------

export async function bootstrap(db, { admin }) {
  const [leagues, teams, roster, weeks, series, games, players, news, allstar] = await Promise.all([
    db.all('SELECT * FROM leagues ORDER BY sort'),
    db.all('SELECT * FROM teams ORDER BY name'),
    db.all(`SELECT rs.team_id, rs.slot, p.id AS player_id, p.discord_tag AS tag
      FROM roster_slots rs LEFT JOIN players p ON p.id = rs.player_id`),
    db.all('SELECT * FROM weeks ORDER BY league_id, number'),
    db.all('SELECT * FROM series ORDER BY id'),
    db.all(`SELECT g.id, g.series_id, g.game_number, g.home_score, g.away_score, g.forfeit,
      EXISTS (SELECT 1 FROM box_scores b WHERE b.game_id = g.id) AS has_box FROM games g`),
    db.all('SELECT id, discord_tag AS tag FROM players ORDER BY lower(discord_tag)'),
    db.all('SELECT * FROM news ORDER BY published_at DESC, id DESC LIMIT 50'),
    getSetting(db, 'allstar'),
  ]);
  return { leagues, teams, roster, weeks, series, games, players, news, allstar, me: { admin } };
}

export async function gameDetail(db, id) {
  const game = await db.get('SELECT * FROM games WHERE id = ?', id);
  if (!game) throw new UserError('Game not found.', 404);
  const lines = await db.all(`SELECT b.*, p.discord_tag AS tag FROM box_scores b
    JOIN players p ON p.id = b.player_id WHERE b.game_id = ? ORDER BY b.pts DESC, p.discord_tag`, id);
  const shot = await db.get('SELECT id FROM screenshots WHERE game_id = ?', id);
  return { game, lines, screenshot_id: shot?.id ?? null };
}

export async function stats(db, { league, phase }) {
  const stage = phase === 'playoffs' ? "s.stage <> 'regular'" : phase === 'all' ? 'TRUE' : "s.stage = 'regular'";
  return db.all(`SELECT p.id AS player_id, p.discord_tag AS tag, t.id AS team_id, t.name AS team,
      COUNT(*)::int AS gp, ${sumCols}
    FROM box_scores b
    JOIN games g ON g.id = b.game_id
    JOIN series s ON s.id = g.series_id
    JOIN players p ON p.id = b.player_id
    JOIN teams t ON t.id = b.team_id
    WHERE s.league_id = ? AND ${stage}
    GROUP BY p.id, t.id`, league);
}

export async function playerLog(db, id) {
  const player = await db.get('SELECT id, discord_tag AS tag FROM players WHERE id = ?', id);
  if (!player) throw new UserError('Player not found.', 404);
  const games = await db.all(`SELECT b.*, g.game_number, g.home_score, g.away_score, g.forfeit, g.series_id,
      s.stage, s.label, w.number AS week, s.home_team_id, s.away_team_id
    FROM box_scores b
    JOIN games g ON g.id = b.game_id
    JOIN series s ON s.id = g.series_id
    LEFT JOIN weeks w ON w.id = s.week_id
    WHERE b.player_id = ? ORDER BY s.league_id, w.number, g.game_number`, id);
  return { player, games };
}

export async function awards(db, voter) {
  const tallies = await db.all(`SELECT v.award, v.player_id, p.discord_tag AS tag, COUNT(*)::int AS votes
    FROM award_votes v JOIN players p ON p.id = v.player_id
    GROUP BY v.award, v.player_id, p.discord_tag ORDER BY votes DESC, p.discord_tag`);
  const mine = Object.fromEntries((await db.all('SELECT award, player_id FROM award_votes WHERE voter_id = ?', voter))
    .map(r => [r.award, r.player_id]));
  return { tallies, mine };
}

export async function vote(db, voter, body) {
  if (!['mvp', 'dpoy'].includes(body.award)) throw new UserError('Unknown award.');
  const id = Number(body.player_id);
  const player = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await db.get('SELECT id FROM players WHERE id = ?', id) : null;
  if (!player) throw new UserError('Choose a league player.');
  await db.run(`INSERT INTO award_votes (award, voter_id, player_id) VALUES (?, ?, ?)
    ON CONFLICT (award, voter_id) DO UPDATE SET player_id = excluded.player_id,
      updated_at = to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`, body.award, voter, player.id);
}

export async function register(db, body) {
  let data;
  if (body.kind === 'player') {
    data = {
      discordTag: required(body.discordTag, 'Discord Tag'),
      steamTag: required(body.steamTag, 'Steam Tag'),
      recWinPercent: percent(body.recWinPercent, 'Rec Win %'),
      fgShootingPercent: percent(body.fgShootingPercent, 'FG Shooting %'),
      threePtShootingPercent: percent(body.threePtShootingPercent, '3-pt Shooting %'),
    };
  } else if (body.kind === 'owner') {
    data = {
      steamTag: required(body.steamTag, 'Steam Tag'),
      discordTag: required(body.discordTag, 'Discord Tag'),
      crewName: required(body.crewName, 'Crew Name'),
      roster: ROSTER_SLOTS.map((slot, i) => ({ slot, discordTag: text(body.roster?.[i]) })),
    };
  } else if (body.kind === 'sponsor') {
    const email = required(body.email, 'Contact E-mail');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError('Enter a valid contact e-mail.');
    data = {
      type: body.type === 'Individual' ? 'Individual' : 'Company',
      name: required(body.name, 'Name'),
      email,
      phone: text(body.phone, 40),
      description: required(body.description, 'Description', 2000),
    };
  } else {
    throw new UserError('Unknown registration type.');
  }
  await db.run('INSERT INTO registrations (kind, data) VALUES (?, ?)', body.kind, JSON.stringify(data));
}

// ---------- commissioner ----------

export async function listRegistrations(db) {
  return (await db.all('SELECT * FROM registrations ORDER BY created_at DESC, id DESC'))
    .map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export async function setRegistrationStatus(db, id, status) {
  if (!['new', 'approved', 'archived'].includes(status)) throw new UserError('Unknown status.');
  const reg = await db.get('SELECT * FROM registrations WHERE id = ?', id);
  if (!reg) throw new UserError('Registration not found.', 404);
  await db.tx(async t => {
    await t.run('UPDATE registrations SET status = ? WHERE id = ?', status, id);
    if (status === 'approved' && reg.kind === 'player') {
      const data = JSON.parse(reg.data);
      const playerId = await playerIdForTag(t, data.discordTag);
      await t.run("UPDATE players SET steam_tag = ? WHERE id = ? AND steam_tag = ''", data.steamTag, playerId);
    }
  });
}

export async function updateTeam(db, id, body) {
  const team = await db.get('SELECT * FROM teams WHERE id = ?', id);
  if (!team) throw new UserError('Team not found.', 404);
  const fields = {
    owner_coach: text(body.owner_coach),
    stream_url: streamUrl(body.stream_url),
    sponsors: text(body.sponsors, 500),
    affiliated_teams: text(body.affiliated_teams),
  };
  await db.tx(async t => {
    await t.run('UPDATE teams SET owner_coach = ?, stream_url = ?, sponsors = ?, affiliated_teams = ? WHERE id = ?',
      fields.owner_coach, fields.stream_url, fields.sponsors, fields.affiliated_teams, id);
    for (const slot of ROSTER_SLOTS) {
      const tag = text(body.roster?.[slot], 64);
      await t.run('UPDATE roster_slots SET player_id = ? WHERE team_id = ? AND slot = ?',
        tag ? await playerIdForTag(t, tag) : null, id, slot);
    }
  });
}

export async function assignSeries(db, id, body) {
  const series = await db.get('SELECT * FROM series WHERE id = ?', id);
  if (!series) throw new UserError('Matchup not found.', 404);
  if (series.stage === 'regular') throw new UserError('Regular season matchups come from the schedule.');
  if (await db.get('SELECT 1 AS x FROM games WHERE series_id = ?', id)) {
    throw new UserError('Delete this matchup\'s games before changing its teams.');
  }
  const pick = async v => {
    if (!v) return null;
    const n = Number(v);
    const team = Number.isInteger(n) && n < 2 ** 31
      ? await db.get('SELECT id FROM teams WHERE id = ? AND league_id = ?', n, series.league_id) : null;
    if (!team) throw new UserError('Choose a team from this league.');
    return team.id;
  };
  const home = await pick(body.home_team_id), away = await pick(body.away_team_id);
  if (home && home === away) throw new UserError('Choose different teams.');
  await db.run('UPDATE series SET home_team_id = ?, away_team_id = ? WHERE id = ?', home, away, id);
}

export async function postNews(db, body, id = null) {
  const title = required(body.title, 'Title');
  const content = required(body.body, 'Story', 10000);
  if (id) {
    const res = await db.run('UPDATE news SET title = ?, body = ? WHERE id = ?', title, content, id);
    if (!res.changes) throw new UserError('Post not found.', 404);
  } else {
    await db.run('INSERT INTO news (title, body) VALUES (?, ?)', title, content);
  }
}

export async function deleteNews(db, id) {
  await db.run('DELETE FROM news WHERE id = ?', id);
}

export async function saveAllstar(db, body) {
  const list = v => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(s => text(s, 64)).filter(Boolean).slice(0, 15);
  const score = v => (v === '' || v === null || v === undefined ? null : Math.max(0, Math.min(400, Math.trunc(Number(v)) || 0)));
  const value = {
    team1: list(body.team1), team2: list(body.team2), when: text(body.when),
    score1: score(body.score1), score2: score(body.score2),
  };
  await db.run(`INSERT INTO settings (key, value) VALUES ('allstar', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(value));
}

export const EXPORT_TABLES = ['leagues', 'teams', 'players', 'roster_slots', 'weeks', 'series', 'games', 'box_scores',
  'registrations', 'news', 'award_votes', 'settings'];

export async function exportAll(db) {
  const out = { exported_at: new Date().toISOString() };
  for (const t of EXPORT_TABLES) out[t] = await db.all(`SELECT * FROM ${t}`);
  return out;
}

// Fixed-window throttle kept in the database, so it holds across serverless instances.
export async function rateLimit(db, key, max, windowSeconds) {
  if (Math.random() < 0.02) await db.run("DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'");
  const row = await db.get(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, now() + make_interval(secs => ?))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < now() THEN excluded.reset_at ELSE rate_limits.reset_at END
    RETURNING count`, key, windowSeconds);
  return row.count <= max;
}

export { saveGame, deleteGame };

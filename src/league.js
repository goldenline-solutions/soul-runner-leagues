export const STAT_KEYS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'];

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// 'home' | 'away' — forfeits hand the game to the other side.
export function gameWinner(g) {
  if (g.forfeit === 'home') return 'away';
  if (g.forfeit === 'away') return 'home';
  return g.home_score > g.away_score ? 'home' : 'away';
}

// Games must be numbered 1..n with nothing recorded after a side reaches two wins.
export function checkSeries(games) {
  const sorted = [...games].sort((a, b) => a.game_number - b.game_number);
  const wins = { home: 0, away: 0 };
  sorted.forEach((g, i) => {
    if (g.game_number !== i + 1) throw new UserError('Record the earlier series games first.');
    if (wins.home >= 2 || wins.away >= 2) throw new UserError('This best-of-3 series is already decided.');
    wins[gameWinner(g)]++;
  });
  return wins;
}

const int = (v, max = 999) => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new UserError(`Stat values must be whole numbers between 0 and ${max}.`);
  return n;
};

export function normalizeBox(rows = []) {
  if (!Array.isArray(rows)) throw new UserError('Box score must be a list of player lines.');
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const tag = String(row.tag ?? '').trim().slice(0, 64);
    const stats = Object.fromEntries(STAT_KEYS.map(k => [k, int(row[k])]));
    const empty = STAT_KEYS.every(k => stats[k] === 0);
    if (!tag) {
      if (empty) continue;
      throw new UserError('Every stat line needs a player tag.');
    }
    if (row.side !== 'home' && row.side !== 'away') throw new UserError(`${tag}: choose a team side.`);
    const key = tag.toLowerCase();
    if (seen.has(key)) throw new UserError(`${tag} appears more than once in this box score.`);
    seen.add(key);
    if (stats.fgm > stats.fga || stats.tpm > stats.tpa || stats.ftm > stats.fta) {
      throw new UserError(`${tag}: made shots can't exceed attempts.`);
    }
    if (stats.tpm > stats.fgm || stats.tpa > stats.fga) {
      throw new UserError(`${tag}: 3-pointers are part of field goals, so they can't exceed FG totals.`);
    }
    out.push({ side: row.side, tag, ...stats });
  }
  return out;
}

// Discord tags are unique ignoring case (players_tag index on lower(discord_tag)).
// steam: a tag that isn't anyone's Discord tag may still be a player's Steam tag (box scores).
export async function playerIdForTag(db, tag, { steam = false } = {}) {
  if (steam) {
    const known = await db.get(`SELECT id FROM players WHERE lower(discord_tag) = lower(?)
      OR (steam_tag <> '' AND lower(steam_tag) = lower(?))
      ORDER BY (lower(discord_tag) = lower(?)) DESC, id LIMIT 1`, tag, tag, tag);
    if (known) return known.id;
  }
  await db.run('INSERT INTO players (discord_tag) VALUES (?) ON CONFLICT ((lower(discord_tag))) DO NOTHING', tag);
  return (await db.get('SELECT id FROM players WHERE lower(discord_tag) = lower(?)', tag)).id;
}

// Creates (gameId null) or replaces a game result plus its box score.
export async function saveGame(db, input, gameId = null) {
  const existing = gameId ? await db.get('SELECT * FROM games WHERE id = ?', gameId) : null;
  if (gameId && !existing) throw new UserError('Game not found.', 404);
  const seriesId = existing ? existing.series_id : Number(input.series_id);
  const series = Number.isInteger(seriesId) ? await db.get('SELECT * FROM series WHERE id = ?', seriesId) : null;
  if (!series) throw new UserError('Choose a matchup.');
  if (!series.home_team_id || !series.away_team_id) throw new UserError('Assign both teams to this matchup first.');

  const game = {
    game_number: existing ? existing.game_number : int(input.game_number, 3),
    home_score: int(input.home_score, 400),
    away_score: int(input.away_score, 400),
    forfeit: input.forfeit === 'home' || input.forfeit === 'away' ? input.forfeit : null,
  };
  if (game.game_number < 1) throw new UserError('Choose Game 1, 2 or 3.');
  if (!game.forfeit && game.home_score === game.away_score) throw new UserError('Played games must have a non-tied score.');

  const others = await db.all('SELECT * FROM games WHERE series_id = ? AND id <> ?', seriesId, gameId ?? 0);
  if (others.some(g => g.game_number === game.game_number)) {
    throw new UserError('A final score is already recorded for that series game.');
  }
  checkSeries([...others, game]);

  const box = game.forfeit ? [] : normalizeBox(input.box);
  const teamFor = { home: series.home_team_id, away: series.away_team_id };
  const screenshotId = Number(input.screenshot_id) || null;

  return db.tx(async t => {
    let id = gameId;
    if (existing) {
      await t.run(`UPDATE games SET home_score = ?, away_score = ?, forfeit = ?,
        updated_at = to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
      game.home_score, game.away_score, game.forfeit, id);
      await t.run('DELETE FROM box_scores WHERE game_id = ?', id);
    } else {
      id = (await t.get(`INSERT INTO games (series_id, game_number, home_score, away_score, forfeit)
        VALUES (?, ?, ?, ?, ?) RETURNING id`, seriesId, game.game_number, game.home_score, game.away_score, game.forfeit)).id;
    }
    const used = new Map(); // player id -> tag, since a Discord tag and a Steam tag can be one player
    for (const row of box) {
      const playerId = await playerIdForTag(t, row.tag, { steam: true });
      if (used.has(playerId)) throw new UserError(`${used.get(playerId)} and ${row.tag} are the same player (Discord and Steam tag).`);
      used.set(playerId, row.tag);
      await t.run(`INSERT INTO box_scores (game_id, player_id, team_id, ${STAT_KEYS.join(', ')})
        VALUES (?, ?, ?, ${STAT_KEYS.map(() => '?').join(', ')})`,
      id, playerId, teamFor[row.side], ...STAT_KEYS.map(k => row[k]));
    }
    if (screenshotId) {
      await t.run('UPDATE screenshots SET game_id = ? WHERE id = ? AND (game_id IS NULL OR game_id = ?)', id, screenshotId, id);
    }
    return id;
  });
}

export async function deleteGame(db, gameId) {
  const game = await db.get('SELECT * FROM games WHERE id = ?', gameId);
  if (!game) throw new UserError('Game not found.', 404);
  const later = await db.get('SELECT 1 AS x FROM games WHERE series_id = ? AND game_number > ?', game.series_id, game.game_number);
  if (later) throw new UserError('Delete the later series games first.');
  await db.run('DELETE FROM games WHERE id = ?', gameId);
}

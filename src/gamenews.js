// Game recaps for the Discord news channel. When a game is saved (on the site or with the bot's
// Save button), the bot posts a short summary: the result, where the series stands, the best
// individual lines with season context, and where both teams sit in the standings.
//
// gameFacts() gathers all of that from the database. An OpenAI model writes the headline and the
// recap from it; without OPENAI_API_KEY, or when the model fails, a plain recap is written here.
// Player names never go to the model: players are P1, P2, ... and the real tags are put back here.
import { UserError, gameWinner } from './league.js';
import { stats, rateLimit } from './api.js';
import { askModel, cleanText } from './archetype.js';
import { derive, mergeByPlayer, qualified } from '../public/js/profile.js';

const HOURLY_LIMIT = 60;   // model calls per hour
const PERFORMERS = 3;
const HEADLINE_MAX = 90, RECAP_MAX = 600;
const STAGES = { qf: 'Quarterfinal', sf: 'Semifinal', final: 'Final' };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'recap'],
  properties: {
    headline: { type: 'string', description: `One line, at most ${HEADLINE_MAX} characters, with both team names` },
    recap: { type: 'string', description: '2 to 3 sentences: the result, the series, the standout players, one piece of league context' },
  },
};

const one = n => Number(n.toFixed(1));
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
// A rough "who had the best game" figure, only used to pick the players worth naming.
const impact = l => l.pts + l.reb + 1.5 * l.ast + 2 * l.stl + 2 * l.blk - l.tov;
// Tags are shown inside Discord markdown.
export const escapeMd = s => String(s ?? '').replace(/([\\*_~`|>[\]])/g, '\\$1');

// The regular season table, ranked like the site's standings: matchup win %, game win %, point differential.
async function standings(db, leagueId) {
  const rows = new Map((await db.all('SELECT id, name FROM teams WHERE league_id = ?', leagueId))
    .map(t => [t.id, { id: t.id, name: t.name, gp: 0, w: 0, l: 0, diff: 0, sw: 0, sl: 0 }]));
  const series = await db.all("SELECT id, home_team_id, away_team_id FROM series WHERE league_id = ? AND stage = 'regular'", leagueId);
  const games = await db.all(`SELECT g.series_id, g.home_score, g.away_score, g.forfeit FROM games g
    JOIN series s ON s.id = g.series_id WHERE s.league_id = ? AND s.stage = 'regular'`, leagueId);
  for (const s of series) {
    const home = rows.get(s.home_team_id), away = rows.get(s.away_team_id);
    if (!home || !away) continue;
    const wins = { home: 0, away: 0 };
    for (const g of games.filter(x => x.series_id === s.id)) {
      home.gp++; away.gp++;
      home.diff += g.home_score - g.away_score;
      away.diff += g.away_score - g.home_score;
      const side = gameWinner(g);
      wins[side]++;
      (side === 'home' ? home : away).w++;
      (side === 'home' ? away : home).l++;
    }
    if (wins.home >= 2 || wins.away >= 2) {
      (wins.home >= 2 ? home : away).sw++;
      (wins.home >= 2 ? away : home).sl++;
    }
  }
  const sPct = r => (r.sw + r.sl ? r.sw / (r.sw + r.sl) : 0), gPct = r => (r.gp ? r.w / r.gp : 0);
  return [...rows.values()].sort((a, b) => sPct(b) - sPct(a) || gPct(b) - gPct(a) || b.diff - a.diff || a.name.localeCompare(b.name));
}

// Everything a recap can say about one game, as plain data. Team names are real; players carry
// both their tag and a token (P1, P2, ...) for the model.
export async function gameFacts(db, gameId) {
  const g = await db.get(`SELECT g.id, g.series_id, g.game_number, g.home_score, g.away_score, g.forfeit,
      s.stage, s.label, s.league_id, l.name AS league, w.number AS week,
      s.home_team_id, s.away_team_id, th.name AS home_team, ta.name AS away_team
    FROM games g JOIN series s ON s.id = g.series_id JOIN leagues l ON l.id = s.league_id
    LEFT JOIN weeks w ON w.id = s.week_id
    JOIN teams th ON th.id = s.home_team_id JOIN teams ta ON ta.id = s.away_team_id WHERE g.id = ?`, gameId);
  if (!g) throw new UserError('Game not found.', 404);

  const side = gameWinner(g), other = side === 'home' ? 'away' : 'home';
  const name = { home: g.home_team, away: g.away_team }, score = { home: g.home_score, away: g.away_score };
  const teamId = { home: g.home_team_id, away: g.away_team_id };

  // The series as it stood after this game.
  const wins = { home: 0, away: 0 };
  for (const x of await db.all('SELECT game_number, home_score, away_score, forfeit FROM games WHERE series_id = ? AND game_number <= ?', g.series_id, g.game_number)) {
    wins[gameWinner(x)]++;
  }
  const lead = wins.home === wins.away ? null : wins.home > wins.away ? 'home' : 'away';
  const decided = wins.home >= 2 || wins.away >= 2;
  const trail = lead === 'home' ? 'away' : 'home';
  const seriesText = !lead ? `Series tied ${wins.home}-${wins.away}`
    : decided ? `${name[lead]} win the series ${wins[lead]}-${wins[trail]}`
      : `${name[lead]} lead the series ${wins[lead]}-${wins[trail]}`;

  // The best lines of the game, each with what it means for that player's season.
  const lines = await db.all(`SELECT b.*, p.discord_tag AS tag FROM box_scores b JOIN players p ON p.id = b.player_id
    WHERE b.game_id = ?`, gameId);
  const season = mergeByPlayer(await stats(db, { league: g.league_id, phase: 'all' }));
  const field = qualified(season).map(p => ({ id: p.player_id, ppg: derive(p).ppg }));
  const leagueHigh = (await db.get(`SELECT MAX(b.pts) AS pts FROM box_scores b JOIN games x ON x.id = b.game_id
    JOIN series s ON s.id = x.series_id WHERE s.league_id = ? AND x.id <> ?`, g.league_id, gameId)).pts;
  const performers = [];
  for (const l of [...lines].sort((a, b) => impact(b) - impact(a) || a.player_id - b.player_id).slice(0, PERFORMERS)) {
    const before = await db.get(`SELECT COUNT(*)::int AS gp, MAX(b.pts) AS pts FROM box_scores b JOIN games x ON x.id = b.game_id
      JOIN series s ON s.id = x.series_id WHERE b.player_id = ? AND s.league_id = ? AND x.id <> ?`, l.player_id, g.league_id, gameId);
    const totals = season.find(p => p.player_id === l.player_id);
    const d = totals ? derive(totals) : null;
    const rank = field.some(p => p.id === l.player_id) && field.length >= 5 ? 1 + field.filter(p => p.ppg > d.ppg).length : null;
    const doubles = ['pts', 'reb', 'ast', 'stl', 'blk'].filter(k => l[k] >= 10).length;
    const notes = [
      doubles >= 3 ? 'triple-double' : doubles === 2 ? 'double-double' : null,
      leagueHigh !== null && l.pts > leagueHigh ? `most points in a ${g.league} game this season` : null,
      before.gp >= 2 && l.pts > before.pts ? 'season high in points' : null,
      before.gp === 0 ? `first ${g.league} game` : null,
      rank && rank <= 5 ? `${ordinal(rank)} in the league in scoring` : null,
    ].filter(Boolean);
    performers.push({
      token: `P${performers.length + 1}`, tag: l.tag, team: l.team_id === teamId.home ? name.home : name.away, won: l.team_id === teamId[side],
      line: { pts: l.pts, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk, tov: l.tov, fg: `${l.fgm}-${l.fga}`, three: `${l.tpm}-${l.tpa}` },
      season: d && { games: totals.gp, ppg: one(d.ppg), rpg: one(d.rpg), apg: one(d.apg) },
      notes,
    });
  }

  // Regular season: both teams' place in the table after this game.
  let table = null;
  if (g.stage === 'regular') {
    const ranked = await standings(db, g.league_id);
    table = [side, other].map(k => {
      const i = ranked.findIndex(r => r.id === teamId[k]);
      const r = ranked[i];
      return { team: r.name, place: i + 1, of: ranked.length, matchups: `${r.sw}-${r.sl}`, games: `${r.w}-${r.l}` };
    });
  }

  return {
    game_id: g.id, league: g.league,
    round: g.stage === 'regular' ? (g.week ? `Weekend ${String(g.week).padStart(2, '0')}` : g.label || 'Regular season') : g.label || STAGES[g.stage] || g.stage,
    playoffs: g.stage !== 'regular', game_number: g.game_number,
    winner: name[side], loser: name[other], winner_score: score[side], loser_score: score[other],
    margin: Math.abs(g.home_score - g.away_score), forfeit: Boolean(g.forfeit),
    series: { text: seriesText, decided, winner_wins: wins[side], loser_wins: wins[other] },
    performers, standings: table,
  };
}

const statLine = l => [`${l.pts} PTS`, l.reb && `${l.reb} REB`, l.ast && `${l.ast} AST`, l.stl >= 3 && `${l.stl} STL`, l.blk >= 3 && `${l.blk} BLK`].filter(Boolean).join(', ');
const said = l => {
  const parts = [`${l.pts} points`, l.reb >= 5 && `${l.reb} rebounds`, l.ast >= 5 && `${l.ast} assists`].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
};

// The recap without a model. Players are written as their tokens, like the model's text.
function plainRecap(f) {
  const where = `Game ${f.game_number} of their ${f.league} ${f.playoffs ? f.round.toLowerCase() : 'matchup'}`;
  if (f.forfeit) {
    return { headline: `${f.winner} take Game ${f.game_number} by forfeit`, recap: `${f.winner} were awarded ${where} against ${f.loser} by forfeit. ${f.series.text}.` };
  }
  const verb = f.margin >= 20 ? 'rolled past' : f.margin <= 5 ? 'edged' : 'beat';
  const out = [`${f.winner} ${verb} ${f.loser} ${f.winner_score}-${f.loser_score} in ${where}. ${f.series.text}.`];
  const star = f.performers.find(p => p.won) ?? f.performers[0];
  if (star) out.push(`${star.token} led ${star.team} with ${said(star.line)}${star.notes[0] ? ` (${star.notes[0]})` : ''}.`);
  const reply = f.performers.find(p => p !== star && !p.won);
  if (reply) out.push(`${reply.token} had ${said(reply.line)} for ${reply.team}.`);
  const top = f.standings?.[0];
  if (top) out.push(`${top.team} are ${ordinal(top.place)} of ${top.of} in the ${f.league} at ${top.matchups === '0-0' ? `${top.games} in games` : `${top.matchups} in matchups`}.`);
  return { headline: `${f.winner} ${f.winner_score}, ${f.loser} ${f.loser_score}`, recap: out.join(' ') };
}

function prompt(f) {
  const data = { ...f, game_id: undefined, performers: f.performers.map(({ tag, token, ...p }) => ({ name: token, ...p })) };
  return `You write short game recaps for the Discord news channel of a competitive NBA 2K league. Every matchup is a best-of-three series.

Write a headline and a recap of the game below.
- Headline: one line, at most ${HEADLINE_MAX} characters, naming both teams. No score needed.
- Recap: 2 to 3 sentences, at most ${RECAP_MAX - 100} characters. Cover the result, where the series stands, the standout players with their numbers, and one piece of context from the notes, season averages or standings.
- Players are named P1, P2, ...: use those names exactly as written. Use the team names as given.
- Use only the facts given. Do not invent plays, quarters, runs, injuries or quotes: you only have the box score.
- Sports-desk tone, plain and lively. No emoji, no hashtags, no markdown.

Game:
${JSON.stringify(data, null, 1)}`;
}

// { facts, headline, recap, ai } for one saved game. The text has real player tags, in bold.
export async function gameNews(db, cfg, gameId, fetchImpl = fetch) {
  const facts = await gameFacts(db, gameId);
  let text = plainRecap(facts), ai = false;
  if (cfg?.apiKey && !facts.forfeit && await rateLimit(db, 'gamenews', HOURLY_LIMIT, 3600)) {
    try {
      const out = await askModel(cfg, prompt(facts), fetchImpl, { name: 'GameRecap', schema: SCHEMA, temperature: 0.7 });
      const headline = cleanText(out.headline, HEADLINE_MAX), recap = cleanText(out.recap, RECAP_MAX);
      if (headline.length >= 5 && recap.length >= 40) { text = { headline, recap }; ai = true; }
    } catch (err) {
      console.error(`Game recap failed for game ${gameId}: ${err.message}`);
    }
  }
  // The text goes into Discord markdown: stray formatting characters are escaped, then the tags go in.
  const names = s => escapeMd(s).replace(/\bP(\d+)\b/g, (m, n) => {
    const p = facts.performers[Number(n) - 1];
    return p ? `**${escapeMd(p.tag)}**` : m;
  });
  return { facts, headline: names(text.headline).replace(/\*\*/g, ''), recap: names(text.recap), ai };
}

// The Discord message for a recap: one embed that links to the box score.
export function newsMessage(news, { siteUrl = '' } = {}) {
  const f = news.facts, site = siteUrl.replace(/\/$/, '');
  const fields = [{ name: 'Series', value: `${escapeMd(f.series.text)} · Game ${f.game_number}` }];
  if (f.performers.length) {
    fields.push({ name: 'Top performers', value: f.performers.map(p => {
      const extra = p.notes.length ? ` · ${p.notes.slice(0, 2).join(', ')}` : '';
      return `**${escapeMd(p.tag)}** (${escapeMd(p.team)}): ${statLine(p.line)}${extra}`;
    }).join('\n').slice(0, 1024) });
  }
  if (f.standings) {
    fields.push({ name: 'Standings', value: f.standings.map(t => `${escapeMd(t.team)}: ${ordinal(t.place)} of ${t.of}, ${t.matchups} in matchups (${t.games} in games)`).join('\n') });
  }
  const embed = {
    title: `FINAL: ${f.winner} ${f.winner_score}, ${f.loser} ${f.loser_score}`.slice(0, 256),
    description: `**${news.headline}**\n${news.recap}`.slice(0, 2000),
    fields, color: 0xe8b23a,
    footer: { text: `${f.league} · ${f.round} · Game ${f.game_number}` },
    ...(site ? { url: `${site}/#box/${f.game_id}` } : {}),
  };
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export const gamesToPost = db => db.all('SELECT id FROM games WHERE NOT news_posted ORDER BY id LIMIT 5');
export const markNewsPosted = (db, id) => db.run('UPDATE games SET news_posted = true WHERE id = ?', id);

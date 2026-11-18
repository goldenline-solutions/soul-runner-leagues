// AI scouting reports for player pages. The server gathers the context a scout would want: the
// player's numbers and ratings, their game log, how much of the team's offense runs through them,
// who they played with, and how their numbers and the team's results move with and without each
// teammate. An OpenAI model writes the report from that. Reports are kept in player_scouting and
// written again only after a new or corrected box score.
//
// Names never go to the model: the player is PLAYER and teammates are MATE_1, MATE_2, ... The real
// tags are put back into the text here.
import { UserError } from './league.js';
import { stats, playerLog, rateLimit } from './api.js';
import { askModel, cleanText } from './archetype.js';
import { totals, derive, mergeByPlayer, rate, archetype } from '../public/js/profile.js';

export const SCOUT_MIN_GAMES = 2;
const HOURLY_LIMIT = 120;  // model calls per hour for the whole site
const MAX_MATES = 6;       // teammates described to the model
const LOG_GAMES = 10;      // most recent games listed one by one

// No minItems/maxItems: strict JSON schemas do not take them on every model. The counts are in the text.
const list = (min, max, description) => ({ type: 'array', items: { type: 'string' }, description: `${min} to ${max} items. ${description}` });
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'summary', 'strengths', 'weaknesses', 'with_teammates', 'game_plan'],
  properties: {
    headline: { type: 'string', description: 'One line, at most 70 characters, that sums the player up' },
    summary: { type: 'string', description: '2 to 3 sentences: who this player is on the court' },
    strengths: list(2, 4, 'Each one sentence, with the number that backs it'),
    weaknesses: list(1, 3, 'Each one sentence, with the number that backs it'),
    with_teammates: { type: 'string', description: '2 to 4 sentences on role and fit next to the listed teammates. These are inferences: word them as such.' },
    game_plan: { type: 'string', description: '1 to 2 sentences: how an opponent should defend this player' },
  },
};

const one = n => Number(n.toFixed(1));
const pct = x => (x === null ? null : Number((x * 100).toFixed(1)));
const line = d => ({ pts: one(d.ppg), reb: one(d.rpg), ast: one(d.apg), stl: one(d.spg), blk: one(d.bpg), tov: one(d.topg), fg_pct: pct(d.fg), three_pct: pct(d.tp), threes_made: one(d.tpmPg) });
const record = games => { const w = games.filter(g => g.won).length; return `${w}-${games.length - w}`; };
const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
const part = (mine, team) => (team ? pct(mine / team) : null);

// Everything the model is told, as plain data. Exported for the tests.
// games: the player's lines (playerLog rows of one league). lines: every box score line of those games.
export function scoutingContext({ playerId, games, lines, rated, build, leagueName, teamName }) {
  const mine = games.map(g => {
    const side = g.team_id === g.home_team_id ? 'home' : 'away';
    const won = g.forfeit ? g.forfeit !== side : (side === 'home') === (g.home_score > g.away_score);
    return { ...g, won, opp: side === 'home' ? g.away_team_id : g.home_team_id,
      score: side === 'home' ? `${g.home_score}-${g.away_score}` : `${g.away_score}-${g.home_score}` };
  });
  const t = totals(mine), d = derive(t);
  const teamLines = g => lines.filter(l => l.game_id === g.game_id && l.team_id === g.team_id);
  const allTeam = mine.flatMap(teamLines);

  // Teammates, most games together first. Their numbers are from the shared games only.
  const mateIds = [...new Set(allTeam.filter(l => l.player_id !== playerId).map(l => l.player_id))];
  const mates = mateIds.map(id => {
    const shared = mine.filter(g => teamLines(g).some(l => l.player_id === id));
    const apart = mine.filter(g => !shared.includes(g));
    return { id, shared, apart, d: derive(totals(allTeam.filter(l => l.player_id === id))) };
  }).sort((a, b) => b.shared.length - a.shared.length || b.d.ppg - a.d.ppg).slice(0, MAX_MATES);
  const token = new Map(mates.map((m, i) => [m.id, `MATE_${i + 1}`]));

  return {
    tokens: token,
    facts: {
      league: leagueName, games: t.gp, team_record_in_those_games: record(mine),
      sample_size_note: t.gp < 5 ? 'Small sample: say so, and keep claims modest.' : undefined,
      PLAYER: {
        per_game: line(d), true_shooting_pct: pct(d.ts), assists_per_turnover: d.astTo === null ? null : one(d.astTo),
        percent_of_points_from_three: pct(d.threeShare), fouls_per_game: one(d.pfpg),
        ratings_40_to_99_against_the_league: Object.fromEntries(rated.skills.map(s => [s.label, s.rating])),
        overall_rating: rated.overall, best_skills: build ? [build.first.label, build.second.label] : [],
        in_wins: line(derive(totals(mine.filter(g => g.won)))), in_losses: line(derive(totals(mine.filter(g => !g.won)))),
        last_3_games: t.gp >= 5 ? line(derive(totals(mine.slice(-3)))) : undefined,
      },
      // How much of the team's box score is this player's, over the games they played.
      share_of_team_totals_pct: {
        points: part(t.pts, sum(allTeam, 'pts')), shot_attempts: part(t.fga, sum(allTeam, 'fga')),
        assists: part(t.ast, sum(allTeam, 'ast')), rebounds: part(t.reb, sum(allTeam, 'reb')),
        threes_made: part(t.tpm, sum(allTeam, 'tpm')), turnovers: part(t.tov, sum(allTeam, 'tov')),
      },
      teammates: mates.map(m => ({
        name: token.get(m.id), games_together: m.shared.length, their_per_game_in_those_games: line(m.d),
        team_record_together: record(m.shared),
        // Only when there are at least two games each way: otherwise there is nothing to compare.
        ...(m.shared.length >= 2 && m.apart.length >= 2 ? {
          PLAYER_with_them: line(derive(totals(m.shared))), PLAYER_without_them: line(derive(totals(m.apart))),
          team_record_without_them: record(m.apart),
        } : {}),
      })),
      recent_games_oldest_first: mine.slice(-LOG_GAMES).map(g => {
        const top = teamLines(g).filter(l => l.player_id !== playerId).sort((a, b) => b.pts - a.pts)[0];
        return {
          vs: teamName(g.opp), result: `${g.won ? 'W' : 'L'} ${g.score}`, stage: g.stage === 'regular' ? undefined : 'playoffs',
          line: `${g.pts} pts, ${g.reb} reb, ${g.ast} ast, ${g.stl} stl, ${g.blk} blk, ${g.tov} tov, ${g.fgm}/${g.fga} FG, ${g.tpm}/${g.tpa} 3PT`,
          top_scoring_teammate: top && token.has(top.player_id) ? `${token.get(top.player_id)} ${top.pts} pts` : undefined,
        };
      }),
    },
  };
}

const PROMPT = facts => `You are a basketball scout writing for a competitive NBA 2K league website. Write a scouting report on PLAYER from the box score data below.

Rules:
- Use only the data given. Every claim about PLAYER needs a number from it. Do not invent positions, play styles, badges, height or anything a box score cannot show.
- Read the context, not just the averages: wins against losses, recent games against the season, the share of the team's shots and assists, and how PLAYER's numbers change with and without each teammate.
- The teammate section is inference. Word it that way ("likely", "suggests", "probably"). Example of the reasoning wanted: if a teammate takes most of the shots and PLAYER's assists are high, PLAYER is likely the one setting that teammate up. Say so only when the numbers support it.
- If the sample is small, say so once and keep claims modest.
- Refer to the player only as PLAYER and to teammates only by their MATE_n names, exactly as written. Do not name anyone else.
- Plain, direct sentences. No hype, no emoji, no markdown.

Data:
${JSON.stringify(facts, null, 1)}`;

// { report, ai } for one player in one league. report: null when there is none to show (too few
// games, no API key and nothing saved, or the model failed with nothing saved).
export async function playerScouting(db, cfg, playerId, leagueId, fetchImpl = fetch) {
  const league = await db.get('SELECT id, name FROM leagues WHERE id = ?', leagueId);
  if (!league) throw new UserError('Unknown league.', 404);
  const { player, games: every } = await playerLog(db, playerId);
  const games = every.filter(g => g.league_id === league.id);
  const t = { ...totals(games), player_id: playerId };
  if (t.gp < SCOUT_MIN_GAMES) return { report: null, ai: false };

  const signature = [t.gp, t.pts, t.reb, t.ast, t.fga, t.tov].join(':');
  const saved = await db.get('SELECT signature, report FROM player_scouting WHERE player_id = ? AND league_id = ?', playerId, league.id);
  const parsed = saved && { ...JSON.parse(saved.report), ai: true };
  if (saved?.signature === signature) return { report: parsed, ai: true };
  // New games since the saved report (or no report yet). An older report beats none if the model can't be reached.
  const previous = { report: parsed ?? null, ai: Boolean(parsed) };
  if (!cfg.apiKey || !(await rateLimit(db, 'scouting', HOURLY_LIMIT, 3600))) return previous;

  const ids = [...new Set(games.map(g => g.game_id))];
  const lines = await db.all(`SELECT b.*, p.discord_tag AS tag FROM box_scores b JOIN players p ON p.id = b.player_id
    WHERE b.game_id IN (${ids.map(() => '?').join(', ')})`, ...ids);
  const teams = new Map((await db.all('SELECT id, name FROM teams')).map(r => [r.id, r.name]));
  const rated = rate(t, mergeByPlayer(await stats(db, { league: league.id, phase: 'all' })));
  const { tokens, facts } = scoutingContext({
    playerId, games, lines, rated, build: archetype(rated, t.gp), leagueName: league.name, teamName: id => teams.get(id) ?? 'TBD',
  });

  let out;
  try {
    out = await askModel(cfg, PROMPT(facts), fetchImpl, { name: 'ScoutingReport', schema: SCHEMA, timeoutMs: 75e3, temperature: 0.5 });
  } catch (err) {
    console.error(`Scouting report failed for player ${playerId}: ${err.message}`);
    return previous;
  }
  // Put the real names back, longest token first so MATE_10 is not read as MATE_1 + "0".
  const tags = new Map(lines.map(l => [l.player_id, l.tag]));
  const names = [...tokens].sort((a, b) => b[1].length - a[1].length);
  const text = (value, max) => {
    let s = cleanText(value, max + 200);
    for (const [id, tok] of names) s = s.replaceAll(tok, tags.get(id) ?? 'a teammate');
    return s.replaceAll('PLAYER', player.tag).slice(0, max);
  };
  const many = (value, max) => (Array.isArray(value) ? value : []).slice(0, max).map(v => text(v, 260)).filter(Boolean);
  const report = {
    headline: text(out.headline, 90), summary: text(out.summary, 600),
    strengths: many(out.strengths, 4), weaknesses: many(out.weaknesses, 3),
    with_teammates: text(out.with_teammates, 700), game_plan: text(out.game_plan, 400),
    games: t.gp, confidence: t.gp < 4 ? 'low' : t.gp < 8 ? 'medium' : 'high',
  };
  if (!report.summary || !report.strengths.length) return previous;
  await db.run(`INSERT INTO player_scouting (player_id, league_id, signature, report) VALUES (?, ?, ?, ?)
    ON CONFLICT (player_id, league_id) DO UPDATE SET signature = excluded.signature, report = excluded.report,
      updated_at = to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`, playerId, league.id, signature, JSON.stringify(report));
  return { report: { ...report, ai: true }, ai: true };
}

// AI archetype names for player pages. The stat profile (ratings, best skills) comes from the same
// maths the page uses (public/js/profile.js); an OpenAI model turns it into a build-style name.
// Names are kept in player_archetypes and written again only when the player's profile changes.
// Without OPENAI_API_KEY, or when the model fails, the rule-based name is returned instead.
import { UserError } from './league.js';
import { stats, playerLog, rateLimit } from './api.js';
import { totals, derive, mergeByPlayer, rate, archetype } from '../public/js/profile.js';

const NAME_MAX = 40, TAGLINE_MAX = 110;
const HOURLY_LIMIT = 120; // model calls per hour for the whole site

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'tagline'],
  properties: {
    name: { type: 'string', description: 'The archetype name: 2 to 4 words, Title Case' },
    tagline: { type: 'string', description: 'One short sentence on how this player plays, based only on the numbers given' },
  },
};

const one = n => Number(n.toFixed(1));
const pct = x => (x === null ? null : Number((x * 100).toFixed(1)));

function prompt({ leagueName, d, rated, rule }) {
  const facts = {
    league: leagueName, games: d.gp,
    per_game: { points: one(d.ppg), rebounds: one(d.rpg), assists: one(d.apg), steals: one(d.spg), blocks: one(d.bpg), turnovers: one(d.topg), threes_made: one(d.tpmPg) },
    shooting_percent: { field_goal: pct(d.fg), three_point: pct(d.tp), free_throw: pct(d.ft), true_shooting: pct(d.ts) },
    percent_of_points_from_three: pct(d.threeShare),
    ratings_40_to_99_against_the_league: Object.fromEntries(rated.skills.map(s => [s.label, s.rating])),
    best_skill: rule.first.label, second_skill: rule.second.label,
  };
  return `You name basketball player archetypes for a competitive NBA 2K league website, in the style of a 2K build name.

Write one archetype name for the player whose league stats are below.
- 2 to 4 words, Title Case, at most ${NAME_MAX} characters.
- It must reflect what the numbers show: lead with the player's strongest skills. Do not praise a skill the ratings show as weak.
- Make it fresh and specific, not a stock phrase. No real people, teams or brands, no profanity, no emoji, no quotes.
Then write a tagline: one sentence, at most ${TAGLINE_MAX} characters, saying how this player plays. Use only the numbers given; do not invent facts.

Player stats:
${JSON.stringify(facts, null, 1)}`;
}

// One text-only question to the model, answered as JSON in the given schema. Shared with src/scouting.js.
export async function askModel(cfg, text, fetchImpl, { name, schema, timeoutMs = 45e3, temperature = 0.9 }) {
  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: cfg.model,
      ...(/^(gpt-5|o\d)/.test(cfg.model) ? { reasoning_effort: 'low' } : { temperature }),
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      messages: [{ role: 'user', content: text }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Model API returned ${res.status}`);
  return JSON.parse(body.choices[0].message.content);
}

// Model output is shown on a public page: one line, plain text, bounded length.
export const cleanText = (value, max) => String(value ?? '').replace(/[\r\n\t"“”<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// { name, tagline, ai } for one player in one league. name: null before the player has enough games.
export async function playerArchetype(db, cfg, playerId, leagueId, fetchImpl = fetch) {
  const league = await db.get('SELECT id, name FROM leagues WHERE id = ?', leagueId);
  if (!league) throw new UserError('Unknown league.', 404);
  const { games } = await playerLog(db, playerId);
  const t = { ...totals(games.filter(g => g.league_id === league.id)), player_id: playerId };
  const rated = rate(t, mergeByPlayer(await stats(db, { league: league.id, phase: 'all' })));
  const rule = archetype(rated, t.gp);
  if (!rule) return { name: null, tagline: '', ai: false };
  const fallback = { name: rule.name, tagline: rule.basis, ai: false };
  if (!cfg.apiKey) return fallback;

  const signature = [rule.first.key, rule.second.key, rule.name.startsWith('Two-Way') ? 'two-way' : '', rule.name.startsWith('Do-It-All') ? 'all' : ''].join('|');
  const saved = await db.get('SELECT signature, name, tagline FROM player_archetypes WHERE player_id = ? AND league_id = ?', playerId, league.id);
  if (saved?.signature === signature) return { name: saved.name, tagline: saved.tagline, ai: true };
  // The profile changed (or there is no name yet). Keep showing the old AI name if the model can't be reached.
  const previous = saved ? { name: saved.name, tagline: saved.tagline, ai: true } : fallback;
  if (!(await rateLimit(db, 'archetype', HOURLY_LIMIT, 3600))) return previous;
  let out;
  try {
    out = await askModel(cfg, prompt({ leagueName: league.name, d: derive(t), rated, rule }), fetchImpl, { name: 'PlayerArchetype', schema: SCHEMA });
  } catch (err) {
    console.error(`Archetype name failed for player ${playerId}: ${err.message}`);
    return previous;
  }
  const name = cleanText(out.name, NAME_MAX), tagline = cleanText(out.tagline, TAGLINE_MAX);
  if (name.length < 3) return previous;
  await db.run(`INSERT INTO player_archetypes (player_id, league_id, signature, name, tagline) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (player_id, league_id) DO UPDATE SET signature = excluded.signature, name = excluded.name, tagline = excluded.tagline,
      updated_at = to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`, playerId, league.id, signature, name, tagline);
  return { name, tagline, ai: true };
}

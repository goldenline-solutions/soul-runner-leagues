// Player profile maths: totals and averages, ratings against the rest of the league, an archetype
// name built from those ratings, and short insights. No DOM and no imports, so tests load it in Node.

export const KEYS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'];

// Sums of every stat over a list of box score lines, plus the number of games.
export function totals(games) {
  const t = { gp: games.length };
  for (const k of KEYS) t[k] = games.reduce((sum, g) => sum + (g[k] || 0), 0);
  return t;
}

const per = (n, gp) => (gp ? n / gp : 0);
const share = (made, tried) => (tried ? made / tried : null);

// Everything the page shows that is worked out from the sums. Percentages are 0..1, or null when
// there were no attempts.
export function derive(t) {
  const gp = t.gp;
  return {
    gp,
    ppg: per(t.pts, gp), rpg: per(t.reb, gp), apg: per(t.ast, gp), spg: per(t.stl, gp), bpg: per(t.blk, gp),
    topg: per(t.tov, gp), pfpg: per(t.pf, gp), tpmPg: per(t.tpm, gp), ftmPg: per(t.ftm, gp),
    twoPg: per(t.fgm - t.tpm, gp), // two-point makes per game
    fg: share(t.fgm, t.fga), tp: share(t.tpm, t.tpa), ft: share(t.ftm, t.fta),
    efg: share(t.fgm + 0.5 * t.tpm, t.fga),          // effective field goal %: a three counts 1.5
    ts: share(t.pts, 2 * (t.fga + 0.44 * t.fta)),    // true shooting %: free throws included
    astTo: t.tov ? t.ast / t.tov : null,
    threeShare: share(3 * t.tpm, t.pts),             // part of the points that came from threes
  };
}

// /api/stats has one row per player per team. This merges them into one row per player.
export function mergeByPlayer(rows) {
  const out = new Map();
  for (const r of rows) {
    const t = out.get(r.player_id) || out.set(r.player_id, { player_id: r.player_id, tag: r.tag, gp: 0, ...Object.fromEntries(KEYS.map(k => [k, 0])) }).get(r.player_id);
    t.gp += r.gp;
    for (const k of KEYS) t[k] += r[k];
  }
  return [...out.values()];
}

// The players a profile is measured against: everyone in the league with enough games that one
// big night does not top the list (30% of the most games anyone has played).
export function qualified(players) {
  const most = Math.max(0, ...players.map(p => p.gp));
  const need = Math.max(1, Math.ceil(most * 0.3));
  return players.filter(p => p.gp >= need);
}

// The seven skills. `value` turns a player's derived numbers into one figure to compare; `typical`
// is a rough everyday figure, used only while the league has too few players to compare with.
// adj + noun make the archetype name: the adjective of the second-best skill, the noun of the best.
export const SKILLS = [
  { key: 'scoring', label: 'Scoring', adj: 'Bucket-Getting', noun: 'Scorer', offense: true, value: d => d.ppg, typical: 14 },
  { key: 'shooting', label: '3PT Shooting', adj: 'Sharpshooting', noun: 'Sniper', offense: true, value: d => d.tpmPg * (d.tp ?? 0), typical: 0.6 },
  { key: 'inside', label: 'Inside Scoring', adj: 'Paint-Attacking', noun: 'Finisher', offense: true, value: d => d.twoPg + 0.5 * d.ftmPg, typical: 4 },
  { key: 'playmaking', label: 'Playmaking', adj: 'Playmaking', noun: 'Floor General', offense: true, value: d => d.apg, typical: 4 },
  { key: 'rebounding', label: 'Rebounding', adj: 'Glass-Cleaning', noun: 'Board Crasher', offense: false, value: d => d.rpg, typical: 5 },
  { key: 'perimeter', label: 'Perimeter Defense', adj: 'Ball-Hawking', noun: 'Lockdown Defender', offense: false, value: d => d.spg, typical: 1.2 },
  { key: 'rim', label: 'Rim Protection', adj: 'Shot-Blocking', noun: 'Rim Protector', offense: false, value: d => d.bpg, typical: 0.6 },
];
const MIN_PEERS = 4;

// Where `v` falls among `all` (0..1): the part of the list below it, counting ties as half.
function percentile(v, all) {
  if (!all.length) return 0.5;
  const below = all.filter(x => x < v).length, same = all.filter(x => x === v).length;
  return (below + 0.5 * same) / all.length;
}

// Scores every skill 0..1 and as a 40-99 rating. `peers` are merged league rows (the player may be
// in there; they are compared with everyone else). compared: true when the league was big enough.
export function rate(playerTotals, peers) {
  const me = derive(playerTotals);
  const others = qualified(peers).filter(p => p.player_id !== playerTotals.player_id).map(derive);
  const compared = others.length >= MIN_PEERS - 1;
  const skills = SKILLS.map(s => {
    const v = s.value(me);
    // Too few players to rank against: measure against the everyday figure instead (twice it = full marks).
    const score = compared ? percentile(v, [...others.map(s.value), v]) : Math.min(1, v / (2 * s.typical));
    return { ...s, score, rating: Math.round(40 + 59 * score) };
  });
  const eff = compared && me.ts !== null ? percentile(me.ts, [...others.map(o => o.ts).filter(x => x !== null), me.ts]) : 0.5;
  // Overall: the three best skills carry it, shooting efficiency adjusts it.
  const best = [...skills].sort((a, b) => b.score - a.score).slice(0, 3);
  const overall = Math.round(40 + 59 * (0.8 * best.reduce((t, s) => t + s.score, 0) / 3 + 0.2 * eff));
  return { skills, overall, compared, efficiency: eff };
}

export const ARCHETYPE_MIN_GAMES = 2;

// Build name from the ratings, e.g. "Two-Way Sharpshooting Floor General". null before 2 games.
export function archetype(rated, gp) {
  if (gp < ARCHETYPE_MIN_GAMES) return null;
  const ranked = [...rated.skills].sort((a, b) => b.score - a.score); // ties keep the SKILLS order
  const [first, second] = ranked;
  const strong = rated.skills.filter(s => s.score >= 0.8).length;
  const defense = Math.max(...rated.skills.filter(s => s.key === 'perimeter' || s.key === 'rim').map(s => s.score));
  let name;
  if (strong >= 5) name = `Do-It-All ${first.noun}`;
  else if (first.score < 0.4) name = `${first.adj} Role Player`;
  else if (first.offense && second.offense && defense >= 0.7) name = `Two-Way ${second.adj} ${first.noun}`;
  else name = `${second.adj} ${first.noun}`;
  return { name, first, second, basis: `Best at ${first.label.toLowerCase()}, then ${second.label.toLowerCase()}.` };
}

const one = n => n.toFixed(1);
const pctText = x => `${(x * 100).toFixed(1)}%`;
const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;

const RANKED = [
  ['ppg', 'points per game'], ['rpg', 'rebounds per game'], ['apg', 'assists per game'],
  ['spg', 'steals per game'], ['bpg', 'blocks per game'], ['tpmPg', 'threes made per game'],
];

// Short facts about a player, most notable first. games: their box score lines in playing order,
// each with `won` (true/false). peers: merged league rows. Returns [{ title, text }], five at most.
export function insights({ games, peers, leagueName, playerId }) {
  const out = [];
  const t = totals(games), me = derive(t);
  if (!t.gp) return out;
  const field = qualified(peers);
  const others = field.filter(p => p.player_id !== playerId).map(derive);

  // League ranks: top five in a category, when the player has played enough to qualify.
  if (field.some(p => p.player_id === playerId) && others.length >= MIN_PEERS) {
    const ranks = RANKED.map(([key, label]) => ({ key, label, rank: 1 + others.filter(o => o[key] > me[key]).length }))
      .filter(r => r.rank <= 5 && me[r.key] > 0).sort((a, b) => a.rank - b.rank).slice(0, 2);
    for (const r of ranks) {
      out.push({ title: r.rank === 1 ? 'League leader' : `Top ${r.rank <= 3 ? 3 : 5}`,
        text: `${ordinal(r.rank)} in the ${leagueName} in ${r.label} (${one(me[r.key])}).` });
    }
  }

  // Double-doubles and triple-doubles.
  const tens = g => ['pts', 'reb', 'ast', 'stl', 'blk'].filter(k => g[k] >= 10).length;
  const td = games.filter(g => tens(g) >= 3).length, dd = games.filter(g => tens(g) >= 2).length;
  if (td) out.push({ title: 'Triple-double threat', text: `${td} triple-double${td > 1 ? 's' : ''} and ${dd} double-double${dd > 1 ? 's' : ''} in ${t.gp} games.` });
  else if (dd) out.push({ title: 'Double-double machine', text: `${dd} double-double${dd > 1 ? 's' : ''} in ${t.gp} games.` });

  // Form: the last three games against the whole season.
  if (t.gp >= 5 && me.ppg > 0) {
    const recent = per(games.slice(-3).reduce((sum, g) => sum + g.pts, 0), 3);
    if (recent >= me.ppg * 1.15) out.push({ title: 'Heating up', text: `${one(recent)} points per game over the last 3, up from ${one(me.ppg)} on the season.` });
    else if (recent <= me.ppg * 0.85) out.push({ title: 'Cooling off', text: `${one(recent)} points per game over the last 3, down from ${one(me.ppg)} on the season.` });
  }

  // Team results when this player has a big scoring night (their average, rounded down to a 5).
  const bar = Math.floor(me.ppg / 5) * 5;
  const big = games.filter(g => g.pts >= bar);
  if (bar >= 10 && big.length >= 2 && big.length < t.gp) {
    const w = big.filter(g => g.won).length;
    out.push({ title: `${bar}+ point nights`, text: `The team is ${w}–${big.length - w} when they score ${bar} or more.` });
  }

  // Shooting efficiency against the league.
  const leagueTs = derive(totals(field)).ts;
  if (me.ts !== null && leagueTs !== null && t.fga >= 20 && Math.abs(me.ts - leagueTs) >= 0.03 && others.length >= MIN_PEERS) {
    const diff = (me.ts - leagueTs) * 100;
    out.push({ title: diff > 0 ? 'Efficient scorer' : 'Volume over efficiency',
      text: `${pctText(me.ts)} true shooting, ${one(Math.abs(diff))} points ${diff > 0 ? 'above' : 'below'} the league average.` });
  }

  // Where the points come from.
  if (t.pts >= 20 && me.threeShare !== null) {
    if (me.threeShare >= 0.4) out.push({ title: 'Long-range diet', text: `${Math.round(me.threeShare * 100)}% of their points come from three.` });
    else if (me.threeShare <= 0.1) out.push({ title: 'Lives inside the arc', text: `Only ${Math.round(me.threeShare * 100)}% of their points come from three.` });
  }

  // Looks after the ball.
  if (me.apg >= 3 && me.astTo !== null && me.astTo >= 2.5) out.push({ title: 'Safe hands', text: `${one(me.astTo)} assists for every turnover.` });

  return out.slice(0, 5);
}

// Best single game for each stat: [{ key, label, value, game }], zeros left out.
export function highs(games) {
  return [['pts', 'Points'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['stl', 'Steals'], ['blk', 'Blocks'], ['tpm', 'Threes made']]
    .map(([key, label]) => {
      const game = games.reduce((best, g) => (!best || g[key] > best[key] ? g : best), null);
      return { key, label, value: game ? game[key] : 0, game };
    }).filter(h => h.value > 0);
}

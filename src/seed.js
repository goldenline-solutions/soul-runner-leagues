import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ROSTER_SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', '6TH', '7TH'];

const LEAGUES = [
  {
    id: 'premier', name: 'Premier League', season_name: 'Premier: Season 1', sort: 1,
    blurb: '22 weekends · 132 best-of-3 matchups · First meetings and return meetings.',
    teams: ['Bangladesh', 'Brazil', 'Canada', 'Egypt', 'Haiti', 'India', 'Ireland', 'Mexico', 'Saudi Arabia', 'Serbia', 'Switzerland', 'USA'],
  },
  {
    id: 'affiliate', name: 'Affiliate League', season_name: 'Affiliates: Season 1', sort: 2,
    blurb: '20 weekends · 60 best-of-3 matchups · Three matchups per weekend. Each team faces every other team four times, with one best-of-three matchup per weekend.',
    teams: ['Cleveland', 'Detroit', 'Las Vegas', 'Miami', 'Pittsburgh', 'San Diego'],
  },
];

// Premier playoff bracket: top eight seeds, best of three every round.
const PLAYOFFS = [
  ['qf', 1, 'Quarterfinal 1'], ['qf', 2, 'Quarterfinal 2'], ['qf', 3, 'Quarterfinal 3'], ['qf', 4, 'Quarterfinal 4'],
  ['sf', 1, 'Semifinal 1'], ['sf', 2, 'Semifinal 2'],
  ['final', 1, 'Championship'],
];

const lit = v => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const row = values => `(${values.map(lit).join(', ')})`;
const teamRef = (league, name) => `(SELECT id FROM teams WHERE league_id = ${lit(league)} AND name = ${lit(name)})`;
const weekRef = (league, n) => `(SELECT id FROM weeks WHERE league_id = ${lit(league)} AND number = ${n})`;

// The whole Season 1 structure (from seed/schedule.json, extracted from the original site) as plain
// SQL. Rows reference each other by name, so it works on an empty database with any id sequence.
export function seedSql() {
  const schedule = JSON.parse(readFileSync(join(root, 'seed', 'schedule.json'), 'utf8'));
  const out = [];
  out.push(`INSERT INTO leagues (id, name, season_name, blurb, sort) VALUES\n  ${LEAGUES
    .map(l => row([l.id, l.name, l.season_name, l.blurb, l.sort])).join(',\n  ')};`);
  for (const league of LEAGUES) {
    out.push(`INSERT INTO teams (league_id, name) VALUES\n  ${league.teams.map(t => row([league.id, t])).join(',\n  ')};`);
    out.push(`INSERT INTO weeks (league_id, number, phase, start_date, date_label) VALUES\n  ${schedule[league.id]
      .map(w => row([league.id, w.week, w.phase, w.start, w.label])).join(',\n  ')};`);
    const series = schedule[league.id].flatMap(w => w.series.map((s, i) =>
      `(${lit(league.id)}, ${weekRef(league.id, w.week)}, 'regular', ${i + 1}, '', ${teamRef(league.id, s.home)}, ${teamRef(league.id, s.away)})`));
    out.push(`INSERT INTO series (league_id, week_id, stage, slot, label, home_team_id, away_team_id) VALUES\n  ${series.join(',\n  ')};`);
  }
  out.push(`INSERT INTO roster_slots (team_id, slot)\n  SELECT t.id, s.slot FROM teams t CROSS JOIN (VALUES ${ROSTER_SLOTS
    .map((s, i) => `(${lit(s)}, ${i})`).join(', ')}) AS s(slot, ord) ORDER BY t.id, s.ord;`);
  out.push(`INSERT INTO series (league_id, week_id, stage, slot, label) VALUES\n  ${PLAYOFFS
    .map(([stage, slot, label]) => row(['premier', null, stage, slot, label])).join(',\n  ')};`);
  out.push(`INSERT INTO news (title, body) VALUES ${row(['Welcome to Season 1', 'Welcome to Soul Runner Season 1.'])};`);
  out.push(`INSERT INTO settings (key, value) VALUES ${row(['allstar', JSON.stringify({
    team1: [], team2: [], when: '', score1: null, score2: null,
  })])};`);
  return `${out.join('\n\n')}\n`;
}

// Public pages. Each view returns HTML and may export an `after(el)` hook for wiring events.
import {
  store, esc, api, $, $$, SLOTS, STAT_KEYS, STAT_LABELS, teamName, seriesGames, seriesRecord, standings, teamsIn,
  winPct, signed, currentWeek, pad2, ratio, setMsg, formData, gameWinner, teamLogo,
  teamInitials, logoUrl, gameOfTheWeek, leagueRoute, leagueFromSlug, leagueShort, shrinkLogo,
} from './core.js';
import { totals, derive, mergeByPlayer, rate, archetype, insights, highs, ARCHETYPE_MIN_GAMES } from './profile.js';

const SCOUT_MIN_GAMES = 2; // same as src/scouting.js
import { renderDiscord } from './discord-md.js';

// ---------- About ----------

const GAME_URL = 'https://nba.2k.com/2k27/buy/'; // official NBA 2K27 buy page

export function overview() {
  const d = store.data;
  const played = d.games.length;
  const next = currentWeek('premier') || currentWeek('affiliate');
  const leagueNames = d.leagues.map(leagueShort);
  const latest = d.news[0];
  return `
  <a class="game-banner" href="${GAME_URL}" target="_blank" rel="noopener noreferrer">
    <span class="game-mark">NBA <b>2K27</b></span>
    <span class="game-copy"><strong>Every league game is played on NBA 2K27 for PC.</strong><span>Don't have it yet? Get it from 2K.</span></span>
    <span class="game-cta">Buy NBA 2K27 <span aria-hidden="true">↗</span></span>
    <span class="visually-hidden">(opens the official NBA 2K site in a new tab)</span>
  </a>
  <section class="hero">
    <div class="hero-copy">
      <div class="eyebrow">SEASON 1 · ${esc(leagueNames.join(' + ').toUpperCase())}</div>
      <h1>Soul Runner<span>NBA 2k27 PC Leagues</span></h1>
      <p class="hero-tag">Two leagues. One court. Every possession counts.</p>
      <div class="hero-actions">
        <a class="promo-link" href="#players?form=player">Register to play →</a>
        ${d.leagues.map(l => `<a class="promo-link ghost" href="#${leagueRoute(l.id, 'home')}">${esc(l.name)}</a>`).join('')}
      </div>
    </div>
    <div class="hero-art"><img class="hero-logo" src="/logo.png" alt="Soul Runner SR logo" width="400" height="400"></div>
  </section>
  <div class="stats stat-strip">
    <div class="stat"><strong>${d.teams.length}</strong><span>TEAMS ACROSS TWO LEAGUES</span></div>
    <div class="stat"><strong>${d.series.filter(s => s.stage === 'regular').length}</strong><span>BEST-OF-3 MATCHUPS</span></div>
    <div class="stat"><strong>${played}</strong><span>GAMES IN THE BOOKS</span></div>
    ${next ? `<a class="stat stat-link" href="#${leagueRoute(next.week.league_id, 'schedule')}">
      <strong>WK ${pad2(next.week.number)}</strong><span>${next.live ? 'ON THE COURT NOW' : 'UP NEXT'} · ${esc(next.week.date_label).toUpperCase()}</span></a>` : ''}
  </div>
  ${latest ? `<a class="news-flash" href="#news"><span class="eyebrow">FROM TYREEK'S DESK</span><strong>${esc(latest.title)}</strong><span class="arrow" aria-hidden="true">→</span></a>` : ''}
  ${registerCards()}
  ${leagueCards()}
  ${thisWeekend()}
  <section class="about">
    <div class="about-head">
      <span class="eyebrow">FOUNDED BY TYREEK HILL</span>
      <h2>About the Leagues</h2>
    </div>
    <div class="about-body">
      <p>Founded by Tyreek Hill, the Soul Runner NBA 2K27 PC Leagues bring players together through a shared love of basketball and competitive gaming. With Premier and G-League competition, our leagues give teams a place to build chemistry, develop rivalries, and put their skills to the test on the virtual court. Every game is an opportunity to compete, represent your crew, and be part of a growing basketball community.</p>
      <p>Our goal is to bring the spotlight to PC gaming and the players who make it special. Through league matchups, team streams, and the stories that unfold throughout the season, we want to showcase the talent, dedication, and excitement of NBA 2K27 basketball on PC. Whether you’re taking the court or tuning in to support your favorite team, you have a place in Soul Runner.</p>
    </div>
  </section>
  <aside class="soul-promo" aria-labelledby="soulPromoHeading">
    <img src="/logo.png" alt="Soul Runner logo" width="400" height="400">
    <div>
      <span class="eyebrow">THE COMMUNITY BEHIND THE COMPETITION</span>
      <h3 id="soulPromoHeading">Run with Soul Runner</h3>
      <p>Bring your passion for basketball and PC gaming to the Soul Runner community. Follow Soul Runner on X to connect with the brand behind our leagues and keep the conversation going beyond the court.</p>
      <a class="promo-link" href="https://x.com/soulrunner" target="_blank" rel="noopener noreferrer">Follow @soulrunner on X ↗</a>
    </div>
  </aside>`;
}

function thisWeekend() {
  const blocks = store.data.leagues.map(l => {
    const cw = currentWeek(l.id);
    if (!cw) return '';
    const list = store.data.series.filter(s => s.week_id === cw.week.id);
    return `<section class="schedule-week">
      ${weekHeading(cw.week, list.length, cw.live, l.name.toUpperCase())}
      <div class="fixture-grid">${list.map(fixture).join('')}</div>
    </section>`;
  }).join('');
  return blocks ? `<section class="section"><h2>This Weekend</h2>${blocks}</section>` : '';
}

// Registration cards: one per form on the Registration page. Shown on the landing page and at the
// bottom of each league page so signing up is never more than one click away.
const REGISTER_CARDS = [
  ['player', 'FREE AGENTS', 'Play this season', 'Sign up as a free agent and put your name in front of every team owner.', 'Register as a free agent'],
  ['owner', 'TEAM OWNERS', 'Bring your crew', 'Register your team and its roster of up to seven players.', 'Register a team'],
  ['sponsor', 'SPONSORS', 'Back the leagues', 'Put your brand or your name behind the Soul Runner community.', 'Become a sponsor'],
];

function registerCards(heading = 'Join the Leagues') {
  return `<section class="section" aria-label="Registration">
    <div class="section-head"><div><span class="eyebrow">REGISTRATION IS OPEN</span><h2>${heading}</h2></div>
      <a class="promo-link ghost" href="#players">All registration forms</a></div>
    <div class="card-grid">${REGISTER_CARDS.map(([form, eyebrow, title, copy, cta]) => `<a class="link-card register-card" href="#players?form=${form}">
      <span class="eyebrow">${eyebrow}</span><strong>${title}</strong><span class="link-card-copy">${copy}</span>
      <span class="link-card-cta">${cta} <span aria-hidden="true">→</span></span></a>`).join('')}</div>
  </section>`;
}

// One card per league on the landing page: who leads it, its Game of the Week, a way in.
function leagueCards() {
  const cards = store.data.leagues.map(l => {
    const table = standings(l.id);
    const top = table[0];
    const g = gameOfTheWeek(l.id);
    const line = (label, value) => `<span class="league-card-line"><span>${label}</span><b>${value}</b></span>`;
    return `<a class="link-card league-card" href="#${leagueRoute(l.id, 'home')}">
      <span class="eyebrow">${esc(l.season_name.toUpperCase())}</span><strong>${esc(l.name)}</strong>
      ${line('Teams', table.length)}
      ${line('First place', top?.gp ? `${esc(top.team.name)} · ${top.sw}–${top.sl}` : 'Season not started')}
      ${g ? line('Game of the Week', `${esc(g.home.team.name)} vs ${esc(g.away.team.name)}`) : ''}
      <span class="link-card-cta">Standings, stats and schedule <span aria-hidden="true">→</span></span></a>`;
  }).join('');
  return `<section class="section" aria-labelledby="leaguesHeading">
    <div class="section-head"><div><span class="eyebrow">TWO LEAGUES · ONE COURT</span><h2 id="leaguesHeading">The Leagues</h2></div></div>
    <div class="card-grid two">${cards}</div>
  </section>`;
}

// Premier / G-League switch for the pages that come in a pair. `page`: home, teams or schedule.
function leagueSwitch(current, page) {
  return `<nav class="seg" aria-label="League">${store.data.leagues.map(l => `<a href="#${leagueRoute(l.id, page)}" ${l.id === current ? 'class="active" aria-current="page"' : ''}>${esc(leagueShort(l))}</a>`).join('')}</nav>`;
}

// Tab strip at the top of every page that belongs to one league: all of that league's pages in one row.
function leagueTabs(league, current) {
  const l = store.data.leagueById.get(league);
  const slug = leagueRoute(league, 'slug');
  const tabs = [
    ['home', 'Overview', leagueRoute(league, 'home')],
    ['standings', 'Standings', `standings?league=${slug}`],
    ['stats', 'Player Stats', `stats?league=${slug}`],
    ['schedule', 'Schedule', leagueRoute(league, 'schedule')],
    ['teams', 'Teams', leagueRoute(league, 'teams')],
    ...(league === 'premier' ? [['playoffs', 'Playoffs', 'playoffs']] : []),
    ['awards', 'Awards Race', 'awards'],
  ];
  return `<nav class="league-tabs" aria-label="${esc(l.name)} pages"><span class="league-tabs-name">${esc(leagueShort(l))}</span>${tabs.map(([key, label, href]) =>
    `<a href="#${href}" ${key === current ? 'class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

// ---------- League pages (#premier, #gleague) ----------

function gameOfTheWeekCard(league) {
  const g = gameOfTheWeek(league);
  if (!g) return '';
  const l = store.data.leagueById.get(league);
  const rec = seriesRecord(g.series);
  const side = (x, wins) => `<a class="gotw-team${rec.winner === x.team.id ? ' winner' : ''}" href="#team/${x.team.id}">
      ${teamLogo(x.team, 'lg')}
      <span class="gotw-name">${g.ranked ? `<small>#${x.rank}</small> ` : ''}${esc(x.team.name)}</span>
      <span class="gotw-record">${x.row.gp ? `${x.row.sw}–${x.row.sl} in matchups · ${signed(x.row.diff)}` : 'No games played yet'}</span>
      ${rec.games.length ? `<span class="gotw-wins">${wins}</span>` : ''}</a>`;
  const why = g.ranked
    ? `#${g.home.rank} against #${g.away.rank} in the ${esc(l.name)} standings: the highest-ranked matchup of the weekend.`
    : 'The season opener. Once results are in, this spot goes to the matchup between the highest-ranked teams.';
  const status = rec.decided ? `${esc(teamName(rec.winner))} took it ${Math.max(rec.home, rec.away)}–${Math.min(rec.home, rec.away)}`
    : rec.games.length ? 'Series in progress' : 'Best of 3';
  const games = rec.games.map(x => {
    const label = `G${x.game_number} ${x.home_score}–${x.away_score}`;
    return x.has_box ? `<a href="#box/${x.id}">${label}</a>` : label;
  }).join(' · ');
  // One Watch button per team that has posted a stream link.
  const watch = [g.home.team, g.away.team].filter(t => t.stream_url).map((t, i) =>
    `<a class="promo-link${i ? ' ghost' : ''}" href="${esc(t.stream_url)}" target="_blank" rel="noopener noreferrer">Watch on the ${esc(t.name)} stream ↗</a>`);
  return `<section class="gotw" aria-labelledby="gotwHeading">
    <div class="gotw-top">
      <div><span class="eyebrow">WEEKEND ${pad2(g.week.number)} · <time datetime="${esc(g.week.start_date)}">${esc(g.week.date_label).toUpperCase()}</time></span>
        <h3 id="gotwHeading">Game of the Week</h3></div>
      ${g.live ? '<span class="badge live">THIS WEEKEND</span>' : '<span class="badge">UP NEXT</span>'}
    </div>
    <div class="gotw-match">${side(g.home, rec.home)}<span class="gotw-vs" aria-hidden="true">VS</span>${side(g.away, rec.away)}</div>
    <p class="gotw-why">${why}</p>
    ${watch.length ? `<div class="gotw-watch">${watch.join('')}</div>` : ''}
    <div class="gotw-foot">
      <span>${status}${games ? ` · ${games}` : ''}</span>
      ${watch.length ? '' : '<span>Streams not posted yet</span>'}
      <a href="#${leagueRoute(league, 'schedule')}">Full weekend schedule →</a>
    </div>
  </section>`;
}

function standingsTable(l) {
  const playoffs = l.id === 'premier';
  return wrap(`<table class="data-table standings">
    <thead><tr><th>#</th><th>Team</th><th class="num"><abbr title="Matchups won">W</abbr></th><th class="num"><abbr title="Matchups lost">L</abbr></th><th class="num"><abbr title="Matchup win percentage">PCT</abbr></th><th class="num"><abbr title="Games won and lost">GAMES</abbr></th><th class="num"><abbr title="Point differential">DIFF</abbr></th></tr></thead>
    <tbody>${standings(l.id).map((r, i) => `<tr class="${playoffs && i === 7 ? 'playoff-line' : ''}">
      <td class="rank${playoffs && i < 8 ? ' seed' : ''}">${i + 1}</td><td><a href="#team/${r.team.id}">${esc(r.team.name)}</a></td>
      <td class="num">${r.sw}</td><td class="num">${r.sl}</td><td class="num">${winPct(r)}</td>
      <td class="num">${r.w}–${r.l}</td><td class="num">${signed(r.diff)}</td></tr>`).join('')}</tbody>
  </table>`) + (playoffs ? '<p class="muted">Dashed line: the top eight teams qualify for the playoffs.</p>' : '');
}

// A short plain-language explanation of each league, shown under the name on its landing page.
// The team and weekend counts come from the data, so they stay right if the season changes.
const LEAGUE_ABOUT = {
  premier: (teams, weekends) => `The Premier League is the top division of the Soul Runner NBA 2K27 PC Leagues. ${teams} national teams play each other twice over ${weekends} weekends, and every matchup is a best-of-three series. The top eight teams in the standings reach the playoffs and play for the championship.`,
  affiliate: (teams, weekends) => `The G-League is Soul Runner's second league, with its own season, standings and stats. ${teams} city teams play each other four times over ${weekends} weekends, one best-of-three matchup per weekend. A player can be on a G-League team and a Premier team at the same time.`,
};

export function league(id) {
  const d = store.data;
  const about = LEAGUE_ABOUT[id]?.(teamsIn(id).length, d.weeks.filter(w => w.league_id === id).length);
  const l = d.leagueById.get(id);
  const slug = leagueRoute(id, 'slug');
  const cw = currentWeek(id);
  const weekend = cw ? d.series.filter(s => s.week_id === cw.week.id) : [];
  return `<div class="panel league-page">
    ${leagueTabs(id, 'home')}
    <div class="page-head"><div><span class="eyebrow">${esc(l.season_name.toUpperCase())}</span><h2>${esc(l.name)}</h2>
      ${about ? `<p class="league-about">${esc(about)}</p>` : `<p>${esc(l.blurb)}</p>`}</div>${leagueSwitch(id, 'home')}</div>
    ${gameOfTheWeekCard(id)}
    <div class="league-cols">
      <section aria-labelledby="leagueStandings">
        <div class="section-head"><h3 id="leagueStandings">Standings</h3><a href="#standings?league=${slug}">Full standings →</a></div>
        ${standingsTable(l)}
      </section>
      <section aria-labelledby="leagueLeaders">
        <div class="section-head"><h3 id="leagueLeaders">League Leaders</h3><a href="#stats?league=${slug}">All player stats →</a></div>
        <div id="leagueLeadersBody"><p class="muted">Loading stats…</p></div>
      </section>
    </div>
    ${cw ? `<section class="schedule-week">
      ${weekHeading(cw.week, weekend.length, cw.live)}
      <div class="fixture-grid">${weekend.map(fixture).join('')}</div>
    </section>` : ''}
    ${registerCards(`Join the ${esc(l.name)}`)}
  </div>`;
}

// app.js binds one of these per league (the league id comes first).
league.after = async (id, el) => {
  const rows = await api(`/api/stats?league=${id}&phase=regular`);
  const body = $('#leagueLeadersBody', el);
  if (body) body.innerHTML = rows.length ? leaderTiles(rows) : '<p class="muted">Leaders appear here as soon as the first box score is uploaded.</p>';
};

// The best per-game average in each of the five main stats; each tile opens that player's page.
const LEADERS = [
  ['POINTS PER GAME', r => r.pts / r.gp], ['REBOUNDS PER GAME', r => r.reb / r.gp], ['ASSISTS PER GAME', r => r.ast / r.gp],
  ['STEALS PER GAME', r => r.stl / r.gp], ['BLOCKS PER GAME', r => r.blk / r.gp],
];
function leaderTiles(rows) {
  return `<div class="stats leaders">${LEADERS.map(([label, fn]) => {
    const top = [...rows].sort((a, b) => fn(b) - fn(a))[0];
    return `<a class="stat stat-link" href="#player/${top.player_id}"><strong>${fn(top).toFixed(1)}</strong><span>${label}</span><em>${esc(top.tag)} · ${esc(top.team)}</em></a>`;
  }).join('')}</div>`;
}

const wrap = table => `<div class="table-wrap">${table}</div>`;

// ---------- Teams ----------

export function teams(league) {
  const d = store.data;
  const names = teamsIn(league);
  const title = `${esc(d.leagueById.get(league).name)} Teams &amp; Rosters`;
  const selected = new URLSearchParams(location.hash.split('?')[1]).get('team') || '';
  const table = new Map(standings(league).map(r => [r.team.id, r]));
  const shown = names.filter(t => !selected || String(t.id) === selected);
  return `<div class="panel">
    ${leagueTabs(league, 'teams')}
    <div class="page-head"><h2>${title}</h2>${leagueSwitch(league, 'teams')}</div>
    <label class="league-filter">Show team
      <select data-team-filter>
        <option value="">Full League</option>
        ${names.map(t => `<option value="${t.id}" ${String(t.id) === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
    </label>
    <div class="grid team-grid" aria-live="polite">${shown.map(t => teamCard(t, table.get(t.id))).join('')}</div>
    ${selected ? rosterButton({ id: Number(selected) }) : ''}
  </div>`;
}

function teamCard(t, rec) {
  return `<article class="team">
    <header class="team-head"><a class="team-head-logo" href="#team/${t.id}" tabindex="-1" aria-hidden="true">${teamLogo(t, 'sm')}</a><h3><a href="#team/${t.id}">${esc(t.name)}</a></h3>${rec?.sw + rec?.sl ? `<span class="team-record">${rec.sw}–${rec.sl}</span>` : ''}</header>
    <p class="team-sub">${rec?.gp ? `${rec.sw}–${rec.sl} in matchups · ${rec.w}–${rec.l} in games · ${signed(rec.diff)} point differential` : 'No games played yet'}</p>
    ${rosterList(t)}
    ${teamDetails(t)}
  </article>`;
}

// The commissioner edits everything; a team's owners manage their own roster.
function rosterButton(t) {
  const { admin, manages } = store.data.me;
  if (admin) return `<div class="roster-actions"><button data-edit-team="${t.id}">Update Roster</button></div>`;
  return manages.includes(t.id) ? `<div class="roster-actions"><button data-manage-team="${t.id}">Manage Roster</button></div>` : '';
}

function rosterList(t) {
  const roster = store.data.rosterByTeam.get(t.id) || {};
  return `<ol class="roster" aria-label="${esc(t.name)} roster">
      ${SLOTS.map(([key, label]) => `<li><span class="pos" title="${esc(label)}">${key}</span>${roster[key]?.tag
        ? `<a href="#player/${roster[key].player_id}">${esc(roster[key].tag)}</a>` : '<span class="tba">To be announced</span>'}</li>`).join('')}
    </ol>`;
}

function teamDetails(t) {
  const detail = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const tba = v => (v ? esc(v) : 'To be announced');
  return `<dl class="team-details">
      ${detail('Owner/Coach', tba(t.owner_coach))}
      ${detail('Twitch.tv Stream', streamLink(t))}
      ${detail('Affiliated Team(s)', tba(t.affiliated_teams))}
    </dl>`;
}

// Link to a team's own page.
export const teamLink = id => (store.data.teamById.has(id) ? `<a href="#team/${id}">${esc(teamName(id))}</a>` : esc(teamName(id) || 'TBD'));

// ---------- Team page (#team/ID): roster and details, record, matchups, player stats ----------

const STAGE_ORDER = { regular: 0, qf: 1, sf: 2, final: 3 };

export function team(id) {
  const d = store.data;
  const t = d.teamById.get(Number(id));
  if (!t) return '<div class="panel"><h2>Team not found</h2><p><a href="#premierTeams">See all teams</a></p></div>';
  const league = d.leagueById.get(t.league_id);
  const table = standings(t.league_id);
  const rank = table.findIndex(r => r.team.id === t.id);
  const rec = table[rank];
  const matchups = d.series
    .filter(s => s.home_team_id === t.id || s.away_team_id === t.id)
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9)
      || (d.weekById.get(a.week_id)?.number ?? 0) - (d.weekById.get(b.week_id)?.number ?? 0) || a.id - b.id);
  const logo = logoUrl(t);
  // Banner: the logo stretched edge to edge, fading out on a curve into the page.
  const art = logo
    ? `<img class="banner-img" src="${logo}" alt="">`
    : `<span class="banner-initials">${esc(teamInitials(t))}</span>`;
  return `<div class="panel team-page">
    <header class="team-hero${logo ? ' has-logo' : ''}">
      <div class="team-hero-art" aria-hidden="true">${art}</div>
      ${d.me.admin ? `<button type="button" class="btn-ghost btn-small banner-edit" data-edit-team="${t.id}">${logo ? 'Change logo' : 'Add logo'}</button>` : ''}
      <div class="page-head team-hero-head">
        <div><a class="eyebrow" href="#${leagueRoute(t.league_id, 'home')}">${esc(league.name.toUpperCase())}</a>
        <h2>${esc(t.name)}</h2></div>
        <a class="promo-link ghost" href="#${leagueRoute(t.league_id, 'teams')}">All ${esc(leagueShort(league))} teams</a>
      </div>
    </header>
    <div class="stats team-record-strip">
      <div class="stat"><strong>${rec?.gp ? `#${rank + 1}` : '—'}</strong><span>IN THE STANDINGS OF ${table.length}</span></div>
      <div class="stat"><strong>${rec.sw}–${rec.sl}</strong><span>MATCHUPS WON–LOST</span></div>
      <div class="stat"><strong>${winPct(rec)}</strong><span>MATCHUP WIN %</span></div>
      <div class="stat"><strong>${rec.w}–${rec.l}</strong><span>GAMES WON–LOST</span></div>
      <div class="stat"><strong>${signed(rec.diff)}</strong><span>POINT DIFFERENTIAL</span></div>
    </div>
    <div class="team-page-grid">
      <section class="team">
        <h3 class="team-section-title">Roster</h3>
        ${rosterList(t)}
        ${teamDetails(t)}
        ${rosterButton(t)}
      </section>
      <section class="team-player-stats">
        <h3 class="team-section-title">Player Stats</h3>
        <div id="teamStats"><p class="muted">Loading stats…</p></div>
      </section>
    </div>
    <section class="team-matchups">
      <h3 class="team-section-title">Matchups</h3>
      ${matchups.length ? wrap(`<table class="data-table">
        <thead><tr><th>Week</th><th>Opponent</th><th>Result</th><th>Games</th></tr></thead>
        <tbody>${matchups.map(s => teamMatchupRow(s, t.id)).join('')}</tbody>
      </table>`) : '<p class="muted">No matchups scheduled yet.</p>'}
    </section>
  </div>`;
}

function teamMatchupRow(s, teamId) {
  const week = store.data.weekById.get(s.week_id);
  const isHome = s.home_team_id === teamId;
  const opp = isHome ? s.away_team_id : s.home_team_id;
  const rec = seriesRecord(s);
  const mine = isHome ? rec.home : rec.away, theirs = isHome ? rec.away : rec.home;
  const result = rec.decided
    ? `<span class="result ${rec.winner === teamId ? 'win' : 'loss'}">${rec.winner === teamId ? 'W' : 'L'} ${mine}–${theirs}</span>`
    : rec.games.length ? `In progress · ${mine}–${theirs}` : `<span class="muted">${week ? esc(week.date_label) : 'Upcoming'}</span>`;
  const games = rec.games.map(g => {
    const score = isHome ? `${g.home_score}–${g.away_score}` : `${g.away_score}–${g.home_score}`;
    const label = `G${g.game_number} ${score}${g.forfeit ? ' (F)' : ''}`;
    return g.has_box ? `<a href="#box/${g.id}">${label}</a>` : label;
  }).join(' · ');
  return `<tr><td>${week ? `Wk ${pad2(week.number)}` : esc(s.label)}</td><td>${opp ? teamLink(opp) : 'TBD'}</td>
    <td>${result}</td><td>${games || '—'}</td></tr>`;
}

// As the page scrolls, the banner art drifts down slower than the page and fades, so the page
// slides up over it. Sets --hero-p (0 at the top, 1 once the banner has scrolled away).
let heroScroll = null;
function watchHero(hero) {
  if (heroScroll) removeEventListener('scroll', heroScroll);
  heroScroll = null;
  if (!hero || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let queued = false;
  const update = () => {
    queued = false;
    if (!hero.isConnected) return watchHero(null); // left the team page
    const p = Math.min(1, Math.max(0, scrollY / hero.offsetHeight));
    hero.style.setProperty('--hero-p', p.toFixed(3));
  };
  heroScroll = () => {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  };
  addEventListener('scroll', heroScroll, { passive: true });
  update();
}

team.after = async (el, id) => {
  const t = store.data.teamById.get(Number(id));
  if (!t) return;
  watchHero($('.team-hero', el));
  const rows = (await api(`/api/stats?league=${t.league_id}&phase=all`))
    .filter(r => r.team_id === t.id)
    .sort((a, b) => b.pts / b.gp - a.pts / a.gp || a.tag.localeCompare(b.tag));
  const body = $('#teamStats', el);
  if (!body) return;
  body.innerHTML = rows.length ? wrap(`<table class="data-table">
    <thead><tr><th>Player</th>${STAT_COLUMNS.map(([, label]) => `<th class="num">${label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr><td><a href="#player/${r.player_id}">${esc(r.tag)}</a></td><td class="num">${r.gp}</td>
      ${['pts', 'reb', 'ast', 'stl', 'blk', 'tov'].map(k => `<td class="num">${(r[k] / r.gp).toFixed(1)}</td>`).join('')}
      <td class="num">${ratio(r.fgm, r.fga)}</td><td class="num">${ratio(r.tpm, r.tpa)}</td><td class="num">${ratio(r.ftm, r.fta)}</td></tr>`).join('')}
    </tbody></table>`) + '<p class="muted">Per-game averages over every game played for this team, playoffs included.</p>'
    : '<p>No box scores recorded for this team yet.</p>';
};

function streamLink(t) {
  return t?.stream_url
    ? `<a href="${esc(t.stream_url)}" target="_blank" rel="noopener noreferrer">${esc(t.stream_url)}</a>`
    : 'Not provided';
}

// ---------- Schedule ----------

export function schedule(league) {
  const d = store.data;
  const l = d.leagueById.get(league);
  const cw = currentWeek(league);
  const weeks = d.weeks.filter(w => w.league_id === league);
  return `<div class="panel">
    ${leagueTabs(league, 'schedule')}
    <div class="page-head"><div><h2>${esc(l.season_name)}</h2><p>${esc(l.blurb)}</p></div>${leagueSwitch(league, 'schedule')}</div>
    ${cw ? `<p><a class="promo-link" href="#week-${league}-${cw.week.number}" data-scroll>Jump to ${cw.live ? 'this weekend' : 'the next weekend'} → Weekend ${pad2(cw.week.number)}</a></p>` : ''}
    ${weeks.map(w => {
      const list = d.series.filter(s => s.week_id === w.id);
      const isCurrent = cw?.week.id === w.id;
      return `<section class="schedule-week${isCurrent ? ' current' : ''}" id="week-${league}-${w.number}">
        ${weekHeading(w, list.length, isCurrent && cw.live)}
        <div class="fixture-grid">${list.map(fixture).join('')}</div>
      </section>`;
    }).join('')}
  </div>`;
}

function weekHeading(w, count, live, prefix = '') {
  return `<div class="schedule-week-heading"><div>
      <span class="eyebrow">${prefix ? `${esc(prefix)} · ` : ''}${esc(w.phase)}</span> ${live ? '<span class="badge live">THIS WEEKEND</span>' : ''}
      <h3>Weekend ${pad2(w.number)}</h3>
      <p class="weekend-date"><time datetime="${esc(w.start_date)}">${esc(w.date_label)}</time></p>
    </div><span>${count} GAMES</span></div>`;
}

export function fixture(s) {
  const rec = seriesRecord(s);
  const home = teamName(s.home_team_id), away = teamName(s.away_team_id);
  const status = rec.decided
    ? `${esc(teamName(rec.winner))} wins the week · ${rec.home}–${rec.away}`
    : rec.games.length ? `Series in progress · ${rec.home}–${rec.away}` : 'Best of 3 · View final scores';
  const homeT = store.data.teamById.get(s.home_team_id), awayT = store.data.teamById.get(s.away_team_id);
  return `<details class="fixture series-fixture${rec.decided ? ' decided' : ''}">
    <summary>
      ${matchRows({ title: home }, { title: away }, rec, s)}
      <span class="fixture-status">${status}</span>
    </summary>
    <div class="series-scores">${seriesTable(s, home, away, rec)}</div>
    <div class="fixture-streams">
      <div>${esc(home)} Stream: ${streamLink(homeT)}</div>
      <div>${esc(away)} Stream: ${streamLink(awayT)}</div>
    </div>
  </details>`;
}

// Scoreboard-style rows: one line per team, series wins on the right once games are played.
function matchRows(h, a, rec, s) {
  const row = (t, wins, id) => {
    const won = rec.winner && rec.winner === id;
    const lost = rec.winner && rec.winner !== id;
    return `<div class="fx-row${won ? ' winner' : ''}${lost ? ' loser' : ''}">
      <span class="fx-name">${esc(t.title)}${t.hint ? `<small>${esc(t.hint)}</small>` : ''}</span>
      ${rec.games.length ? `<span class="fx-score">${wins}</span>` : ''}</div>`;
  };
  return `<div class="fixture-match"${rec.games.length ? '' : ' data-vs'}>${row(h, rec.home, s.home_team_id)}${row(a, rec.away, s.away_team_id)}</div>`;
}

function seriesTable(s, home, away, rec) {
  const byNum = Object.fromEntries(rec.games.map(g => [g.game_number, g]));
  let hw = 0, aw = 0;
  const rows = [1, 2, 3].map(n => {
    const g = byNum[n];
    if (!g) return `<tr><th scope="row">Game ${n}</th><td colspan="3">${hw === 2 || aw === 2 ? 'Not needed' : 'Awaiting final score'}</td></tr>`;
    gameWinner(g) === 'home' ? hw++ : aw++;
    const tag = side => (g.forfeit === side ? ' (Forfeited)' : '');
    return `<tr><th scope="row">Game ${n}</th><td>${g.home_score}${tag('home')}</td><td>${g.away_score}${tag('away')}</td>
      <td>${g.has_box ? `<a href="#box/${g.id}">Box score</a>` : ''}</td></tr>`;
  }).join('');
  return `<table><caption>Final Scores</caption>
    <thead><tr><th>Game</th><th>${esc(home || 'TBD')}</th><th>${esc(away || 'TBD')}</th><th><span class="visually-hidden">Box score</span></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// ---------- Standings ----------

// #standings shows both leagues; #standings?league=premier (or gleague) shows one.
export function standingsView(_id, query) {
  const only = leagueFromSlug(query?.get('league'));
  const tab = (slug, label, on) => `<a href="#standings${slug ? `?league=${slug}` : ''}" ${on ? 'class="active" aria-current="page"' : ''}>${esc(label)}</a>`;
  return `<div class="panel">${only ? leagueTabs(only, 'standings') : ''}<div class="page-head"><h2>Standings</h2>
      <nav class="seg" aria-label="League">${tab('', 'Both', !only)}${store.data.leagues.map(l => tab(leagueRoute(l.id, 'slug'), leagueShort(l), l.id === only)).join('')}</nav></div>
    <p>Ranked by matchup win percentage: each best-of-3 is one win or loss. Ties are broken by game win percentage, then point differential.</p>
    ${store.data.leagues.filter(l => !only || l.id === only).map(l => `<h3 class="eyebrow league-label"><a href="#${leagueRoute(l.id, 'home')}">${esc(l.name.toUpperCase())}</a></h3>
      ${standingsTable(l)}`).join('')}
  </div>`;
}

// ---------- Player stats ----------

const STAT_COLUMNS = [
  ['gp', 'GP', r => r.gp],
  ['ppg', 'PPG', r => r.pts / r.gp], ['rpg', 'RPG', r => r.reb / r.gp], ['apg', 'APG', r => r.ast / r.gp],
  ['spg', 'SPG', r => r.stl / r.gp], ['bpg', 'BPG', r => r.blk / r.gp], ['tpg', 'TO', r => r.tov / r.gp],
  ['fgp', 'FG%', r => (r.fga ? r.fgm / r.fga : -1)], ['tpp', '3P%', r => (r.tpa ? r.tpm / r.tpa : -1)], ['ftp', 'FT%', r => (r.fta ? r.ftm / r.fta : -1)],
];
// Text columns sort A to Z on the first click; number columns sort highest first.
const TEXT_SORTS = { player: r => r.tag, team: r => r.team };
const statState = { league: 'premier', phase: 'regular', team: '', sort: 'ppg', dir: -1, rows: [] };
const teamOptions = () => `<option value="">All teams</option>${teamsIn(statState.league).map(t =>
  `<option value="${t.id}" ${String(t.id) === statState.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;

// #stats?league=gleague opens the page on that league.
export function stats(_id, query) {
  const asked = leagueFromSlug(query?.get('league'));
  if (asked && asked !== statState.league) Object.assign(statState, { league: asked, team: '' });
  return `<div class="panel">${leagueTabs(statState.league, 'stats')}<h2>Player statistics</h2>
    <div class="toolbar">
      <label>League <select data-stat="league">${store.data.leagues.map(l => `<option value="${l.id}" ${statState.league === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>Team <select data-stat="team">${teamOptions()}</select></label>
      <label>Games <select data-stat="phase">
        <option value="regular" ${statState.phase === 'regular' ? 'selected' : ''}>Regular season</option>
        <option value="playoffs" ${statState.phase === 'playoffs' ? 'selected' : ''}>Playoffs</option>
        <option value="all" ${statState.phase === 'all' ? 'selected' : ''}>All games</option>
      </select></label>
    </div>
    <div id="statsBody"><p class="muted">Loading stats…</p></div>
  </div>`;
}

stats.after = async el => {
  el.addEventListener('change', e => {
    const key = e.target.dataset.stat;
    if (!key) return;
    statState[key] = e.target.value;
    if (key === 'team') return renderStatsTable(el);
    if (key === 'league') {
      statState.team = '';
      history.replaceState(null, '', `#stats?league=${leagueRoute(statState.league, 'slug')}`); // keep the address in step
      $('.league-tabs', el).outerHTML = leagueTabs(statState.league, 'stats');
      $('[data-stat="team"]', el).innerHTML = teamOptions();
    }
    fetchStats(el);
  });
  el.addEventListener('click', e => {
    const key = e.target.closest('[data-sort]')?.dataset.sort;
    if (!key) return;
    statState.dir = statState.sort === key ? -statState.dir : TEXT_SORTS[key] ? 1 : -1;
    statState.sort = key;
    renderStatsTable(el);
  });
  fetchStats(el);
};

async function fetchStats(el) {
  statState.rows = await api(`/api/stats?league=${statState.league}&phase=${statState.phase}`);
  renderStatsTable(el);
}

function renderStatsTable(el) {
  const rows = statState.rows.filter(r => !statState.team || String(r.team_id) === statState.team);
  const body = $('#statsBody', el);
  if (!rows.length) {
    body.innerHTML = statState.rows.length
      ? `<p>No box scores recorded for ${esc(teamName(Number(statState.team)))} yet.</p>`
      : '<p>No box scores recorded yet. Leaderboards fill in as soon as the first game is uploaded.</p>';
    return;
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const text = TEXT_SORTS[statState.sort];
  const num = (STAT_COLUMNS.find(c => c[0] === statState.sort) || STAT_COLUMNS[1])[2];
  const sorted = [...rows].sort((a, b) => (text ? byName(text(a), text(b)) : num(a) - num(b)) * statState.dir
    || byName(a.tag, b.tag));
  const sortHead = (key, label, cls = '') => `<th${cls ? ` class="${cls}"` : ''} ${statState.sort === key ? `aria-sort="${statState.dir < 0 ? 'descending' : 'ascending'}"` : ''}><button data-sort="${key}">${label}</button></th>`;
  body.innerHTML = `
    ${leaderTiles(rows)}
    ${wrap(`<table class="data-table">
      <thead><tr>${sortHead('player', 'Player')}${sortHead('team', 'Team')}
        ${STAT_COLUMNS.map(([key, label]) => sortHead(key, label, 'num')).join('')}
      </tr></thead>
      <tbody>${sorted.map(r => `<tr><td><a href="#player/${r.player_id}">${esc(r.tag)}</a></td><td>${teamLink(r.team_id)}</td>
        <td class="num">${r.gp}</td>
        ${['pts', 'reb', 'ast', 'stl', 'blk', 'tov'].map(k => `<td class="num">${(r[k] / r.gp).toFixed(1)}</td>`).join('')}
        <td class="num">${ratio(r.fgm, r.fga)}</td><td class="num">${ratio(r.tpm, r.tpa)}</td><td class="num">${ratio(r.ftm, r.fta)}</td></tr>`).join('')}
      </tbody>
    </table>`)}`;
}

// ---------- Box score + player pages ----------

export function box() {
  return '<div class="panel" id="boxPanel"><p class="muted">Loading box score…</p></div>';
}

box.after = async (el, id) => {
  const { game, lines, screenshot_id: shot } = await api(`/api/games/${id}`);
  const s = store.data.seriesById.get(game.series_id);
  const week = store.data.weekById.get(s.week_id);
  const sides = { home: s.home_team_id, away: s.away_team_id };
  const won = gameWinner(game);
  const table = side => {
    const rows = lines.filter(l => l.team_id === sides[side]);
    if (!rows.length) return `<p class="muted">No player lines recorded for ${esc(teamName(sides[side]))}.</p>`;
    const tot = Object.fromEntries(STAT_KEYS.map(k => [k, rows.reduce((t, r) => t + r[k], 0)]));
    const cells = r => `<td class="num">${r.pts}</td><td class="num">${r.reb}</td><td class="num">${r.ast}</td><td class="num">${r.stl}</td>
      <td class="num">${r.blk}</td><td class="num">${r.pf}</td><td class="num">${r.tov}</td>
      <td class="num">${r.fgm}/${r.fga}</td><td class="num">${r.tpm}/${r.tpa}</td><td class="num">${r.ftm}/${r.fta}</td>`;
    return wrap(`<table class="data-table"><caption>${esc(teamName(sides[side]))}</caption>
      <thead><tr><th>Player</th>${['PTS', 'REB', 'AST', 'STL', 'BLK', 'PF', 'TO', 'FG', '3PT', 'FT'].map(h => `<th class="num">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr><td><a href="#player/${r.player_id}">${esc(r.tag)}</a></td>${cells(r)}</tr>`).join('')}</tbody>
      <tfoot><tr><th>Team</th>${cells(tot)}</tr></tfoot></table>`);
  };
  $('#boxPanel', el).innerHTML = `
    <h2>Box Score</h2>
    <p class="eyebrow">${week ? `WEEKEND ${pad2(week.number)} · ${esc(week.phase)}` : esc(s.label.toUpperCase())} · GAME ${game.game_number}</p>
    <div class="box-head">
      <div class="${won === 'home' ? 'won' : ''}"><span class="team-score">${game.home_score}</span><span class="team-name">${teamLink(s.home_team_id)}</span>${game.forfeit === 'home' ? '<br><span class="badge">FORFEITED</span>' : ''}</div>
      <span class="fixture-vs">FINAL</span>
      <div class="${won === 'away' ? 'won' : ''}"><span class="team-score">${game.away_score}</span><span class="team-name">${teamLink(s.away_team_id)}</span>${game.forfeit === 'away' ? '<br><span class="badge">FORFEITED</span>' : ''}</div>
    </div>
    ${table('home')}${table('away')}
    <p>${shot ? `<a href="/api/screenshots/${shot}" target="_blank" rel="noopener">View the original screenshot ↗</a> · ` : ''}
      <a href="#${leagueRoute(s.league_id, 'schedule')}">Back to the schedule</a>
      ${store.data.me.admin ? ` · <a href="#game?edit=${game.id}">Edit this result</a>` : ''}</p>`;
};

export function player() {
  return '<div class="panel" id="playerPanel"><p class="muted">Loading player…</p></div>';
}

// Who this profile belongs to, and the claim / remove-claim control for whoever is looking.
function claimLine(playerId) {
  const { me, players } = store.data;
  const linked = players.find(x => x.id === playerId)?.linked;
  const remove = `<button class="link-btn" data-unclaim="${playerId}">Remove claim</button>`;
  let line = '';
  if (me.player_id === playerId) line = `This is your profile. ${remove}`;
  else if (me.pending_id === playerId && !linked) line = `Claim sent. A commissioner has to approve it. <button class="link-btn" data-unclaim="${playerId}">Cancel request</button>`;
  else if (linked) line = `Claimed profile${me.admin ? ` · ${remove}` : ''}`;
  else if (me.user && !me.player_id) line = `<button data-claim="${playerId}">This is me: claim this profile</button> <span class="small">Your Discord name does not have to match.</span>`;
  // Someone with a profile who also played under this name: a commissioner merges the two.
  else if (me.user && me.player_id) line = `<button class="btn-ghost btn-small" data-claim="${playerId}">This is also me: merge it into my profile</button> <span class="small">For when your stats landed under another name. A commissioner approves it.</span>`;
  else if (!me.user && me.discord_login) line = '<a href="/api/auth/discord">Log in with Discord</a> to claim this profile if it is yours.';
  return `<p class="muted">${line}</p><p class="msg" id="claimMsg" role="status"></p>`;
}

// ---------- Find your profile (#claim) ----------
// The header only knows a profile is yours when its name matches your Discord name. This page
// lists every record nobody has claimed, to search by in-game name, Steam name or team.

export function claimFinder() {
  const { me } = store.data;
  if (!me.user) {
    return `<div class="panel"><h2>Claim your profile</h2>
      <p>${me.discord_login ? '<a href="/api/auth/discord">Log in with Discord</a> first, then pick your player profile here.' : 'Discord login is not set up on this site yet.'}</p></div>`;
  }
  const mine = me.player_id && store.data.players.find(p => p.id === me.player_id);
  return `<div class="panel"><h2>${mine ? 'Merge another record' : 'Claim your profile'}</h2>
    <p>${mine
    ? `Your profile is <a href="#player/${mine.id}">${esc(mine.tag)}</a>. If some of your games are under another name, find that record here and ask to merge it in.`
    : 'Find the record with your stats. Your Discord name does not have to match: search by the name you play under, your Steam name or your team.'}
      A commissioner approves each request.</p>
    <div class="toolbar"><label>Search <input id="claimSearch" type="search" placeholder="In-game name, Steam name or team" autocomplete="off"></label></div>
    <p class="msg" id="claimMsg" role="status"></p>
    <div id="claimResults"><p class="muted">Loading players…</p></div>
  </div>`;
}

claimFinder.after = async el => {
  const { me } = store.data;
  if (!me.user) return;
  const list = await api('/api/claimable');
  const draw = () => {
    const q = $('#claimSearch', el).value.trim().toLowerCase();
    const hits = list.filter(p => !q || [p.tag, p.aliases, p.teams].some(x => x.toLowerCase().includes(q)));
    $('#claimResults', el).innerHTML = hits.length ? wrap(`<table class="data-table"><thead><tr><th>Player</th><th>Also known as</th><th>Team</th><th class="num">Games</th><th></th></tr></thead>
      <tbody>${hits.slice(0, 60).map(p => `<tr><td><a href="#player/${p.id}">${esc(p.tag)}</a></td><td>${esc(p.aliases) || '—'}</td><td>${esc(p.teams) || '—'}</td><td class="num">${p.games}</td>
        <td>${me.pending_id === p.id ? '<span class="muted">Request sent</span> <button class="link-btn" data-unclaim="' + p.id + '">Cancel</button>'
    : `<button class="btn-small" data-claim="${p.id}">${me.player_id ? 'Merge into mine' : 'This is me'}</button>`}</td></tr>`).join('')}</tbody></table>`)
      + (hits.length > 60 ? `<p class="muted small">Showing 60 of ${hits.length}. Type more of the name to narrow it down.</p>` : '')
      : `<p>No unclaimed player matches ${q ? `"${esc(q)}"` : 'yet'}. If you have not played a recorded game or been signed to a team, there is no record to claim yet. A commissioner can also link you with <code>/roster link</code> in Discord.</p>`;
  };
  $('#claimSearch', el).oninput = draw;
  draw();
};

// Player photo, or the first letters of the tag when there is none.
function playerPhoto(p) {
  if (p.photo_version > 0) return `<img class="player-photo" src="/api/players/${p.id}/photo?v=${p.photo_version}" alt="${esc(p.tag)}">`;
  return `<span class="player-photo player-photo-empty" aria-hidden="true">${esc(p.tag.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?')}</span>`;
}

const one = n => n.toFixed(1);
const pctCell = x => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

// #player/ID, or #player/ID?league=gleague for someone who has played in both leagues.
player.after = async (el, id, query) => {
  const { player: p, games: every, aliases } = await api(`/api/players/${id}`);
  const d = store.data, { me } = d;
  const pid = Number(id);
  const canEdit = me.admin || me.player_id === pid;

  // One league at a time: the one asked for, or the one with the most games.
  const played = d.leagues.filter(l => every.some(g => g.league_id === l.id));
  const count = l => every.filter(g => g.league_id === l.id).length;
  const league = played.find(l => l.id === leagueFromSlug(query?.get('league')))
    || [...played].sort((a, b) => count(b) - count(a))[0] || null;
  const games = every.filter(g => g.league_id === league?.id).map(g => {
    const side = g.team_id === g.home_team_id ? 'home' : 'away';
    return { ...g, opp: side === 'home' ? g.away_team_id : g.home_team_id, won: gameWinner(g) === side,
      mine: side === 'home' ? g.home_score : g.away_score, theirs: side === 'home' ? g.away_score : g.home_score };
  });
  const peers = league ? mergeByPlayer(await api(`/api/stats?league=${league.id}&phase=all`)) : [];

  const t = { ...totals(games), player_id: pid }, s = derive(t);
  const rated = rate(t, peers);
  const build = archetype(rated, t.gp);
  const facts = league ? insights({ games, peers, leagueName: league.name, playerId: pid }) : [];
  const best = highs(games);
  const wins = games.filter(g => g.won).length;

  // Current teams: every roster this player is on.
  const spots = d.roster.filter(r => r.player_id === pid).map(r => ({ team: d.teamById.get(r.team_id), slot: r.slot })).filter(x => x.team);
  const gameName = g => `${g.week ? `Wk ${pad2(g.week)}` : esc(g.label)} · G${g.game_number}`;

  const tile = (value, label) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`;
  const splitRow = (label, list) => {
    const x = totals(list), y = derive(x);
    return `<tr><th scope="row">${label}</th><td class="num">${x.gp}</td>
      ${['ppg', 'rpg', 'apg', 'spg', 'bpg', 'topg', 'pfpg'].map(k => `<td class="num">${x.gp ? one(y[k]) : '—'}</td>`).join('')}
      <td class="num">${pctCell(y.fg)}</td><td class="num">${pctCell(y.tp)}</td><td class="num">${pctCell(y.ft)}</td><td class="num">${pctCell(y.ts)}</td></tr>`;
  };
  const playoffs = games.filter(g => g.stage !== 'regular');
  const byTeam = [...new Set(games.map(g => g.team_id))];

  $('#playerPanel', el).innerHTML = `
    <section class="player-hero">
      <div class="player-photo-box">
        ${playerPhoto(p)}
        ${canEdit ? `<div class="player-photo-tools">
          <label class="promo-link btn-small file-btn">${p.photo_version > 0 ? 'Replace photo' : 'Upload photo'}<input type="file" id="photoFile" accept="image/png,image/jpeg,image/webp"></label>
          ${p.photo_version > 0 ? '<button type="button" class="btn-ghost btn-small" id="photoRemove">Remove</button>' : ''}
        </div>` : ''}
      </div>
      <div class="player-id">
        <span class="eyebrow">${spots.length ? spots.map(x => `<a href="#team/${x.team.id}">${esc(x.team.name)}</a> · ${esc(x.slot)}`).join(' &nbsp;/&nbsp; ') : 'FREE AGENT'}</span>
        <h2>${esc(p.tag)}</h2>
        ${build ? '<p class="archetype pending" aria-live="polite"><span>ARCHETYPE</span><strong>Generating name…</strong><em>Reading this player\'s stats.</em></p>'
    : `<p class="archetype locked"><span>ARCHETYPE</span><strong>Not unlocked yet</strong><em>Shows after ${ARCHETYPE_MIN_GAMES} games with a box score.</em></p>`}
        ${claimLine(pid)}
        ${canEdit ? '<p class="msg" id="photoMsg" role="status"></p>' : ''}
      </div>
      ${build ? `<div class="player-ovr" title="Worked out from this player's stats against the rest of the league"><strong>${rated.overall}</strong><span>OVERALL</span></div>` : ''}
    </section>
    ${played.length > 1 ? `<nav class="seg player-league" aria-label="League">${played.map(l =>
    `<a href="#player/${pid}?league=${leagueRoute(l.id, 'slug')}" ${l.id === league.id ? 'class="active" aria-current="page"' : ''}>${esc(leagueShort(l))}</a>`).join('')}</nav>` : ''}
    ${!t.gp ? '<p>No games recorded yet. Stats, ratings and insights fill in after the first box score.</p>' : `
    <div class="stats player-stats">
      ${tile(t.gp, 'GAMES')}${tile(`${wins}–${t.gp - wins}`, 'TEAM RECORD')}
      ${tile(one(s.ppg), 'POINTS')}${tile(one(s.rpg), 'REBOUNDS')}${tile(one(s.apg), 'ASSISTS')}
      ${tile(one(s.spg), 'STEALS')}${tile(one(s.bpg), 'BLOCKS')}${tile(one(s.topg), 'TURNOVERS')}
      ${tile(ratio(t.fgm, t.fga), 'FIELD GOAL %')}${tile(ratio(t.tpm, t.tpa), '3-POINT %')}${tile(ratio(t.ftm, t.fta), 'FREE THROW %')}
      ${tile(pctCell(s.ts), 'TRUE SHOOTING %')}
    </div>
    <p class="muted small">Per-game averages in the ${esc(league.name)}, regular season and playoffs together.</p>
    <section class="scout pending" id="scoutBox" aria-labelledby="scoutHeading" aria-live="polite">
      <div class="section-head"><h3 id="scoutHeading">Scouting Report</h3><span class="badge">AI</span></div>
      <p class="muted" id="scoutBody">${t.gp < SCOUT_MIN_GAMES ? `Shows after ${SCOUT_MIN_GAMES} games with a box score.` : 'Writing the scouting report… the first one for a player takes up to a minute.'}</p>
    </section>
    <div class="player-cols">
      <section aria-labelledby="attrHeading">
        <h3 id="attrHeading">Attributes</h3>
        <ul class="attr-list">${rated.skills.map(k => `<li><span>${k.label}</span>
          <span class="attr-bar" role="img" aria-label="${k.label}: ${k.rating} out of 99"><i data-w="${Math.round(k.score * 100)}"></i></span><b>${k.rating}</b></li>`).join('')}</ul>
        <p class="muted small">${rated.compared ? `Each rating is where this player stands among ${esc(league.name)} players with enough games, from 40 (lowest) to 99 (highest).`
    : 'Too few players have stats to compare yet, so these ratings use typical per-game figures. They switch to league rankings as more box scores come in.'}</p>
      </section>
      <section aria-labelledby="insightHeading">
        <h3 id="insightHeading">Insights</h3>
        ${facts.length ? `<ul class="insight-list">${facts.map(f => `<li><strong>${esc(f.title)}</strong><span>${esc(f.text)}</span></li>`).join('')}</ul>`
    : '<p class="muted">Insights appear as more games are played.</p>'}
        ${best.length ? `<h3 class="highs-title">Season highs</h3>
        <div class="highs">${best.map(h => `<a class="high" href="#box/${h.game.game_id}" title="${gameName(h.game)} vs ${esc(teamName(h.game.opp))}">
          <strong>${h.value}</strong><span>${h.label}</span><em>vs ${esc(teamName(h.game.opp))}</em></a>`).join('')}</div>` : ''}
      </section>
    </div>
    ${wrap(`<table class="data-table"><caption>Splits (per game)</caption>
      <thead><tr><th>Split</th>${['GP', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', 'FG%', '3P%', 'FT%', 'TS%'].map(h => `<th class="num">${h}</th>`).join('')}</tr></thead>
      <tbody>${splitRow('All games', games)}${splitRow('Wins', games.filter(g => g.won))}${splitRow('Losses', games.filter(g => !g.won))}
        ${playoffs.length ? splitRow('Regular season', games.filter(g => g.stage === 'regular')) + splitRow('Playoffs', playoffs) : ''}
        ${byTeam.length > 1 ? byTeam.map(tid => splitRow(`With ${esc(teamName(tid))}`, games.filter(g => g.team_id === tid))).join('') : ''}</tbody>
      <tfoot><tr><th scope="row">Totals</th><td class="num">${t.gp}</td>${['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf'].map(k => `<td class="num">${t[k]}</td>`).join('')}
        <td class="num">${t.fgm}/${t.fga}</td><td class="num">${t.tpm}/${t.tpa}</td><td class="num">${t.ftm}/${t.fta}</td><td class="num">eFG ${pctCell(s.efg)}</td></tr></tfoot></table>`)}
    ${wrap(`<table class="data-table"><caption>Game log</caption>
      <thead><tr><th>Game</th><th>Result</th><th>Opponent</th>${['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', 'FG', '3PT', 'FT'].map(h => `<th class="num">${h}</th>`).join('')}</tr></thead>
      <tbody>${[...games].reverse().map(g => `<tr><td><a href="#box/${g.game_id}">${gameName(g)}</a></td>
          <td><span class="wl ${g.won ? 'w' : 'l'}">${g.won ? 'W' : 'L'}</span> ${g.mine}–${g.theirs}</td><td>${teamLink(g.opp)}</td>
          <td class="num">${g.pts}</td><td class="num">${g.reb}</td><td class="num">${g.ast}</td><td class="num">${g.stl}</td><td class="num">${g.blk}</td>
          <td class="num">${g.tov}</td><td class="num">${g.pf}</td><td class="num">${g.fgm}/${g.fga}</td><td class="num">${g.tpm}/${g.tpa}</td><td class="num">${g.ftm}/${g.fta}</td></tr>`).join('')}</tbody></table>`)}`}
    ${aliases.length || canEdit ? `<section class="alias-box" aria-label="Aliases">
      <p class="muted">Also known as: ${aliases.length ? aliases.map(a => `<strong>${esc(a.alias)}</strong>${canEdit
    ? ` <button class="link-btn" data-alias-remove="${a.id}" aria-label="Remove alias ${esc(a.alias)}">remove</button>` : ''}`).join(' · ') : 'no other names yet'}</p>
      ${canEdit ? `<form id="aliasForm" class="toolbar">
        <label>Add a name you play under <input name="alias" maxlength="64" required placeholder="Steam or in-game name"></label>
        <button class="btn-small">Add alias</button>
      </form>
      <p class="muted small">Box score screenshots that show one of these names are matched to this profile, so a Steam name change does not split your stats.</p>
      <p class="msg" id="aliasMsg" role="status"></p>` : ''}
    </section>` : ''}`;
  // The site forbids inline styles (Content-Security-Policy), so the bar widths are set from here.
  for (const bar of $$('.attr-bar i', el)) bar.style.width = `${bar.dataset.w}%`;
  // Scouting report: written by the model from the game log and teammate context, then saved.
  if (t.gp >= SCOUT_MIN_GAMES) {
    const body = () => $('#scoutBody', el);
    api(`/api/players/${id}/scouting?league=${league.id}`).then(({ report: r }) => {
      const box = $('#scoutBox', el);
      if (!box) return; // the visitor already left this page
      box.classList.remove('pending');
      if (!r) {
        body().textContent = 'No scouting report yet. Reports are written when the AI reader is set up on this server.';
        return;
      }
      const items = xs => xs.map(x => `<li>${esc(x)}</li>`).join('');
      body().outerHTML = `<p class="scout-headline">${esc(r.headline)}</p>
        <p class="scout-summary">${esc(r.summary)}</p>
        <div class="scout-cols">
          <div><h4>Strengths</h4><ul class="scout-list plus">${items(r.strengths)}</ul></div>
          <div><h4>Weaknesses</h4><ul class="scout-list minus">${items(r.weaknesses)}</ul></div>
        </div>
        <div class="scout-cols">
          <div><h4>With teammates</h4><p>${esc(r.with_teammates)}</p></div>
          <div><h4>How to guard them</h4><p>${esc(r.game_plan)}</p></div>
        </div>
        <p class="muted small">Written by AI from ${r.games} box score${r.games === 1 ? '' : 's'}${r.games < t.gp ? ` (${t.gp - r.games} newer not included yet)` : ''}. Confidence: ${esc(r.confidence)}. The teammate notes are inferences from who shared the floor, not confirmed roles.</p>`;
    }).catch(() => { if (body()) body().textContent = 'The scouting report could not be loaded. Refresh to try again.'; });
  }
  // The archetype says "Generating name…" until the server answers (a few seconds the first time,
  // instant once the name is saved). One name is ever shown: the AI-written one, or the rule-based
  // one when the model is off or fails.
  if (build) {
    const show = (label, name, tagline) => {
      const box = $('.archetype', el);
      if (!box) return; // the visitor already left this page
      box.classList.remove('pending');
      $('span', box).textContent = label;
      $('strong', box).textContent = name;
      $('em', box).textContent = tagline;
    };
    api(`/api/players/${id}/archetype?league=${league.id}`)
      .then(a => (a.name ? show(a.ai ? 'ARCHETYPE · AI' : 'ARCHETYPE', a.name, a.tagline) : show('ARCHETYPE', build.name, build.basis)))
      .catch(() => show('ARCHETYPE', build.name, build.basis));
  }
  if (!canEdit) return;

  // Photo: saved as soon as a file is picked (shrunk to 640 px in the browser first).
  const photo = async (options, done) => {
    const msg = $('#photoMsg', el);
    setMsg(msg, 'Saving…');
    try {
      await api(`/api/players/${id}/photo`, options);
      await store.render();
    } catch (err) {
      setMsg(msg, err.message || done, 'error');
    }
  };
  $('#photoFile', el).onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    let image;
    try {
      image = await shrinkLogo(file, 640);
    } catch {
      return setMsg($('#photoMsg', el), 'That file could not be read as an image.', 'error');
    }
    photo({ method: 'PUT', body: { image } });
  };
  if ($('#photoRemove', el)) $('#photoRemove', el).onclick = () => photo({ method: 'DELETE' });

  const change = async (path, options) => {
    try {
      await api(`/api/players/${id}/aliases${path}`, options);
      store.render();
    } catch (err) {
      setMsg($('#aliasMsg', el), err.message, 'error');
    }
  };
  $('#aliasForm', el).onsubmit = e => {
    e.preventDefault();
    change('', { method: 'POST', body: formData(e.target) });
  };
  el.addEventListener('click', e => {
    const remove = e.target.closest('[data-alias-remove]');
    if (remove) change(`/${remove.dataset.aliasRemove}`, { method: 'DELETE' });
  });
};

// ---------- Awards ----------

export function awards() {
  return `<div class="panel"><h2>Awards Race</h2>
    <p>Choose a league player for each award. You get one vote per award and can change it at any time. Results update live for everyone.</p>
    <div class="award-grid" id="awardGrid"><p class="muted">Loading votes…</p></div></div>`;
}

awards.after = async el => {
  const render = ({ tallies, mine }) => {
    const players = store.data.players;
    $('#awardGrid', el).innerHTML = [['mvp', 'MVP'], ['dpoy', 'Defensive Player of the Year']].map(([key, title]) => {
      const board = tallies.filter(t => t.award === key).slice(0, 5);
      const myPick = players.find(p => p.id === mine[key]);
      return `<section class="award-card"><h3>${title}</h3>
        <form data-award="${key}">
          <label for="${key}Player">Vote for a player</label>
          <select id="${key}Player" name="player_id" required ${players.length ? '' : 'disabled'}>
            <option value="">${players.length ? 'Select a player' : 'No league players registered yet'}</option>
            ${players.map(p => `<option value="${p.id}" ${p.id === mine[key] ? 'selected' : ''}>${esc(p.tag)}</option>`).join('')}
          </select>
          <button ${players.length ? '' : 'disabled'}>Save vote</button>
        </form>
        <p role="status" aria-live="polite">${myPick ? `Your vote: ${esc(myPick.tag)}` : players.length ? 'No vote selected yet.' : 'Players appear here when added to a roster.'}</p>
        ${board.length ? `<ol class="vote-board">${board.map(b => `<li><span>${esc(b.tag)}</span><strong>${b.votes} vote${b.votes === 1 ? '' : 's'}</strong></li>`).join('')}</ol>` : ''}
      </section>`;
    }).join('');
  };
  el.addEventListener('submit', async e => {
    const form = e.target.closest('[data-award]');
    if (!form) return;
    e.preventDefault();
    render(await api('/api/awards/vote', { method: 'POST', body: { award: form.dataset.award, player_id: Number(form.player_id.value) } }));
  });
  render(await api('/api/awards'));
};

// ---------- All-Star + Playoffs ----------

export function allstar() {
  const a = store.data.allstar || {};
  const roster = list => (list?.length ? `<ul>${list.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p>Player selections to be announced.</p>');
  const scored = a.score1 !== null && a.score1 !== undefined && a.score2 !== null && a.score2 !== undefined;
  return `<div class="panel"><h2>All-Star Game</h2>
    <p>Two rosters selected by league founder Tyreek Hill will face off the week before the playoffs. The rosters and game time will be announced here.</p>
    <div class="postseason-banner">${a.when ? esc(a.when) : 'After the regular season · One week before the playoffs'}</div>
    <div class="award-grid">
      <section class="award-card"><h3>All-Star Team 1</h3><p>Roster selected by Tyreek Hill</p>${roster(a.team1)}</section>
      <section class="award-card"><h3>All-Star Team 2</h3><p>Roster selected by Tyreek Hill</p>${roster(a.team2)}</section>
    </div>
    <div class="panel"><h3>All-Star Game Final Score</h3><p>${scored ? `Team 1 <strong>${a.score1}</strong> — <strong>${a.score2}</strong> Team 2` : 'Team 1 — vs — Team 2'}</p></div>
  </div>`;
}

const SEEDS = { 1: [1, 8], 2: [4, 5], 3: [2, 7], 4: [3, 6] };

export function playoffs() {
  const d = store.data;
  const bracket = d.series.filter(s => s.stage !== 'regular');
  const projected = standings('premier');
  const placeholder = (s, side) => {
    if (s.stage === 'qf') {
      const seed = SEEDS[s.slot][side === 'home' ? 0 : 1];
      const team = projected[seed - 1];
      return { title: `Seed ${seed}`, hint: team?.gp ? `Projected: ${team.team.name}` : '' };
    }
    if (s.stage === 'sf') return { title: `QF ${s.slot * 2 - (side === 'home' ? 1 : 0)} winner`, hint: '' };
    return { title: `SF ${side === 'home' ? 1 : 2} winner`, hint: '' };
  };
  const match = s => {
    const rec = seriesRecord(s);
    const name = side => {
      const id = s[`${side}_team_id`];
      if (id) return { title: teamName(id), hint: '' };
      return placeholder(s, side);
    };
    const h = name('home'), a = name('away');
    return `<details class="fixture playoff-match series-fixture${rec.decided ? ' decided' : ''}"><summary>
        <span class="eyebrow">${esc(s.label)}</span>
        ${matchRows(h, a, rec, s)}
        <span class="series-hint">Best of 3 · View final scores</span>
      </summary>
      <div class="series-scores">${seriesTable(s, h.title, a.title, rec)}
        <p>${rec.decided ? `${esc(teamName(rec.winner))} advances.` : rec.games.length ? 'Series in progress · First to two wins advances.' : 'Awaiting results · First to two wins advances.'}</p>
      </div></details>`;
  };
  const round = (stage, title) => `<section class="playoff-round"><h3>${title}</h3>${bracket.filter(s => s.stage === stage).map(match).join('')}</section>`;
  return `<div class="panel"><h2>Playoffs</h2>
    <p>The top eight teams at the end of the regular season qualify for the playoffs. Every matchup is best of three: the first team to win two games advances.</p>
    <div class="postseason-banner">Final seeds and qualifying teams will be announced after the season. Until then, projections follow the current standings.</div>
    <div class="playoff-rounds">${round('qf', 'Quarterfinals')}${round('sf', 'Semifinals')}${round('final', 'Final')}</div>
  </div>`;
}

// ---------- Registration ----------

// Registration: one form at a time, picked by the links at the top (#players?form=...).
const REG_FORMS = [
  ['sponsor', 'Sponsorship'],
  ['player', 'Free Agent'],
  ['owner', 'Owner'],
];

export function registration(_id, query) {
  const current = REG_FORMS.some(([k]) => k === query?.get('form')) ? query.get('form') : 'sponsor';
  const field = (name, label, type = 'text', extra = 'required') => `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`;
  const pct = (name, label) => field(name, label, 'number', 'min="0" max="100" step="0.01" required');
  const honey = '<label class="honey" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>';
  const forms = {
    sponsor: `<section class="registration-section"><h3>Sponsorship Interest</h3>
      <form class="registration-form" data-register="sponsor"><div class="registration-grid">
        <fieldset class="result-status"><legend>Sponsor type</legend>
          <label><input type="radio" name="type" value="Company" checked><span>Company</span></label>
          <label><input type="radio" name="type" value="Individual"><span>Individual</span></label>
        </fieldset>
        ${field('name', 'Name')}${field('email', 'Contact E-mail', 'email')}${field('phone', 'Contact Phone', 'tel', '')}
        <label class="wide-field">Product or personal description<textarea name="description" rows="4" required></textarea></label>
      </div>${honey}<button>Submit sponsorship interest</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>`,
    player: `<section class="registration-section"><h3>Free Agent Registration</h3>
      <form class="registration-form" data-register="player"><div class="registration-grid">
        ${field('discordTag', 'Discord Tag')}${field('steamTag', 'Steam Tag')}
        ${field('positions', 'Position(s)', 'text', 'required maxlength="40" placeholder="e.g. PG, SG"')}
        ${pct('recWinPercent', 'Rec Win %')}${pct('fgShootingPercent', 'FG Shooting %')}${pct('threePtShootingPercent', '3-pt Shooting %')}
      </div>${honey}<button>Submit free agent registration</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>`,
    owner: `<section class="registration-section"><h3>Owner Registration</h3>
      <form class="registration-form" data-register="owner"><div class="registration-grid">
        ${field('steamTag', 'Steam Tag')}${field('discordTag', 'Discord Tag')}${field('crewName', 'Crew Name')}
        <fieldset class="roster-fields"><legend>Roster</legend><div class="owner-roster">
          ${[1, 2, 3, 4, 5, 6, 7].map(n => `<div class="owner-roster-row"><span class="pos" aria-hidden="true">${n}</span>
            ${field(`roster${n - 1}`, `<span class="visually-hidden">Player ${n} </span>Discord Tag`, 'text', 'maxlength="64" placeholder="Discord Tag"')}
            ${field(`positions${n - 1}`, `<span class="visually-hidden">Player ${n} </span>Position(s)`, 'text', 'maxlength="40" placeholder="e.g. PG, SG"')}</div>`).join('')}
        </div></fieldset>
      </div>${honey}<button>Submit owner registration</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>`,
  };
  return `<div class="panel"><div class="page-head"><h2>Registration</h2>
      <nav class="seg" aria-label="Registration type">${REG_FORMS.map(([k, label]) =>
        `<a href="#players?form=${k}" ${k === current ? 'class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav></div>
    <p>Registrations go straight to the commissioner. Contact details are never shown on the public site.</p>
    ${forms[current]}
  </div>`;
}

const REGISTER_DONE = {
  player: 'Free agent registration received. The commissioner will review it.',
  owner: 'Owner registration received. The commissioner will review it.',
  sponsor: 'Thanks for your interest. The commissioner will be in touch.',
};

registration.after = el => {
  el.addEventListener('submit', async e => {
    const form = e.target.closest('[data-register]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.register;
    const data = formData(form);
    if (kind === 'owner') data.roster = [0, 1, 2, 3, 4, 5, 6].map(i => ({ discordTag: data[`roster${i}`], positions: data[`positions${i}`] }));
    const msg = $('.msg', form);
    const button = $('button', form);
    button.disabled = true;
    try {
      await api('/api/register', { method: 'POST', body: { kind, ...data } });
      form.reset();
      setMsg(msg, REGISTER_DONE[kind], 'ok');
    } catch (err) {
      setMsg(msg, err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
};

// ---------- News ----------

// ---------- League Rules ----------

export function rules() {
  const r = store.data.rules;
  const admin = store.data.me.admin;
  if (!r?.text) {
    return `<div class="panel"><h2>League Rules</h2>
      <p>The league rules will be posted here soon.</p>
      ${admin ? '<p class="muted">Paste the rules from Discord in the <a href="#desk">Commissioner\'s Desk</a> under League Rules.</p>' : ''}
    </div>`;
  }
  const { html, headings } = renderDiscord(r.text);
  const toc = headings.filter(h => h.level <= 2);
  const updated = r.updated_at ? new Date(r.updated_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  return `<div class="panel"><div class="page-head"><div><h2>League Rules</h2>
      ${updated ? `<p class="muted">Last updated ${esc(updated)}</p>` : ''}</div>
      ${admin ? '<a class="promo-link ghost" href="#desk">Edit rules</a>' : ''}</div>
    ${toc.length >= 3 ? `<nav class="rules-toc" aria-label="Rules sections"><span class="eyebrow">JUMP TO</span>
      <ol>${toc.map(h => `<li class="lvl-${h.level}"><a href="#${h.id}" data-scroll>${h.html.replace(/<a\b[^>]*>|<\/a>/g, '')}</a></li>`).join('')}</ol></nav>` : ''}
    <article class="rules-body">${html}</article>
  </div>`;
}

// ---------- Sponsors ----------

// League sponsors, shown on the Sponsors page. Add an entry here to list another sponsor.
const SPONSORS = [
  {
    name: 'Soul Runner',
    role: 'PRESENTING SPONSOR',
    logo: '/logo.png',
    blurb: 'The brand behind the Soul Runner NBA 2K27 PC Leagues. Follow Soul Runner on X to connect with the brand and keep the conversation going beyond the court.',
    link: { href: 'https://x.com/soulrunner', label: 'Follow @soulrunner on X' },
  },
];

export function sponsors() {
  return `<div class="panel"><h2>Sponsors</h2>
    <p>The brands that make the Soul Runner NBA 2K27 PC Leagues possible.</p>
    <div class="sponsor-list">
      ${SPONSORS.map(sp => `<article class="soul-promo sponsor">
        <img src="${esc(sp.logo)}" alt="${esc(sp.name)} logo" width="400" height="400">
        <div>
          <span class="eyebrow">${esc(sp.role)}</span>
          <h3>${esc(sp.name)}</h3>
          <p>${esc(sp.blurb)}</p>
          <a class="promo-link" href="${esc(sp.link.href)}" target="_blank" rel="noopener noreferrer">${esc(sp.link.label)} ↗</a>
        </div>
      </article>`).join('')}
    </div>
    <p class="muted sponsor-cta">Interested in sponsoring? Use the Sponsorship Interest form on the <a href="#players">Registration</a> page.</p>
  </div>`;
}

export function news() {
  const posts = store.data.news;
  return `<div class="panel"><h2>Tyreek's Desk: News and Notes</h2>
    ${posts.length ? posts.map(p => `<article class="news-post">
      <time datetime="${esc(p.published_at)}">${esc(new Date(`${p.published_at.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase())}</time>
      <h3>${esc(p.title)}</h3>
      ${p.body.split(/\n\s*\n/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join('')}
    </article>`).join('') : '<p>Welcome to Soul Runner Season 1.</p>'}
  </div>`;
}

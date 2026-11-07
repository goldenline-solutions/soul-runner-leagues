// Public pages. Each view returns HTML and may export an `after(el)` hook for wiring events.
import {
  store, esc, api, $, $$, SLOTS, STAT_KEYS, STAT_LABELS, teamName, seriesGames, seriesRecord, standings, teamsIn,
  winPct, signed, currentWeek, pad2, ratio, setMsg, formData, gameWinner,
} from './core.js';

// ---------- About ----------

export function overview() {
  const d = store.data;
  const played = d.games.length;
  const next = currentWeek('premier') || currentWeek('affiliate');
  const latest = d.news[0];
  return `
  <section class="hero">
    <div class="hero-copy">
      <div class="eyebrow">SEASON 1 · PREMIER + AFFILIATE LEAGUES</div>
      <h1>Soul Runner<span>NBA 2k27 PC Leagues</span></h1>
      <p class="hero-tag">Two leagues. One court. Every possession counts.</p>
      <div class="hero-actions">
        <a class="promo-link" href="#premier">Explore the teams →</a>
        <a class="promo-link ghost" href="#schedule">See the schedule</a>
      </div>
    </div>
    <div class="hero-art"><img class="hero-logo" src="/logo.png" alt="Soul Runner SR logo" width="400" height="400"></div>
  </section>
  <div class="stats stat-strip">
    <div class="stat"><strong>${d.teams.length}</strong><span>TEAMS ACROSS TWO LEAGUES</span></div>
    <div class="stat"><strong>${d.series.filter(s => s.stage === 'regular').length}</strong><span>BEST-OF-3 MATCHUPS</span></div>
    <div class="stat"><strong>${played}</strong><span>GAMES IN THE BOOKS</span></div>
    ${next ? `<a class="stat stat-link" href="#${next.week.league_id === 'premier' ? 'schedule' : 'affiliateSchedule'}">
      <strong>WK ${pad2(next.week.number)}</strong><span>${next.live ? 'ON THE COURT NOW' : 'UP NEXT'} · ${esc(next.week.date_label).toUpperCase()}</span></a>` : ''}
  </div>
  ${latest ? `<a class="news-flash" href="#news"><span class="eyebrow">FROM TYREEK'S DESK</span><strong>${esc(latest.title)}</strong><span class="arrow" aria-hidden="true">→</span></a>` : ''}
  ${thisWeekend()}
  <section class="about">
    <div class="about-head">
      <span class="eyebrow">FOUNDED BY TYREEK HILL</span>
      <h2>About the Leagues</h2>
    </div>
    <div class="about-body">
      <p>Founded by Tyreek Hill, the Soul Runner NBA 2K27 PC Leagues bring players together through a shared love of basketball and competitive gaming. With Premier and Affiliate competition, our leagues give teams a place to build chemistry, develop rivalries, and put their skills to the test on the virtual court. Every game is an opportunity to compete, represent your crew, and be part of a growing basketball community.</p>
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

// Premier / Affiliate switch for the pages that come in a pair.
function leagueSwitch(current, routes) {
  return `<nav class="seg" aria-label="League">${store.data.leagues.map(l => `<a href="#${routes[l.id]}" ${l.id === current ? 'class="active" aria-current="page"' : ''}>${esc(l.name.replace(/ League$/, ''))}</a>`).join('')}</nav>`;
}

const wrap = table => `<div class="table-wrap">${table}</div>`;

// ---------- Teams ----------

export function teams(league) {
  const d = store.data;
  const names = teamsIn(league);
  const title = league === 'premier' ? 'Premier League Teams & Rosters' : 'Affiliate League Teams & Rosters';
  const selected = new URLSearchParams(location.hash.split('?')[1]).get('team') || '';
  const table = new Map(standings(league).map(r => [r.team.id, r]));
  const shown = names.filter(t => !selected || String(t.id) === selected);
  return `<div class="panel">
    <div class="page-head"><h2>${title}</h2>${leagueSwitch(league, { premier: 'premier', affiliate: 'affiliate' })}</div>
    <label class="league-filter">Show team
      <select data-team-filter>
        <option value="">Full League</option>
        ${names.map(t => `<option value="${t.id}" ${String(t.id) === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
    </label>
    <div class="grid team-grid" aria-live="polite">${shown.map(t => teamCard(t, table.get(t.id))).join('')}</div>
    ${selected && d.me.admin ? `<div class="roster-actions"><button data-edit-team="${esc(selected)}">Update Roster</button></div>` : ''}
  </div>`;
}

function teamCard(t, rec) {
  const roster = store.data.rosterByTeam.get(t.id) || {};
  const detail = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const tba = v => (v ? esc(v) : 'To be announced');
  return `<article class="team">
    <header class="team-head"><h3>${esc(t.name)}</h3>${rec?.gp ? `<span class="team-record">${rec.w}–${rec.l}</span>` : ''}</header>
    <p class="team-sub">${rec?.gp ? `${rec.w}–${rec.l} in games · ${rec.sw}–${rec.sl} in matchups · ${signed(rec.diff)} point differential` : 'No games played yet'}</p>
    <ol class="roster" aria-label="${esc(t.name)} roster">
      ${SLOTS.map(([key, label]) => `<li><span class="pos" title="${esc(label)}">${key}</span>${roster[key]?.tag
        ? `<a href="#player/${roster[key].player_id}">${esc(roster[key].tag)}</a>` : '<span class="tba">To be announced</span>'}</li>`).join('')}
    </ol>
    <dl class="team-details">
      ${detail('Owner/Coach', tba(t.owner_coach))}
      ${detail('Twitch.tv Stream', streamLink(t))}
      ${detail('Sponsors', tba(t.sponsors))}
      ${detail('Affiliated Team(s)', tba(t.affiliated_teams))}
    </dl>
  </article>`;
}

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
    <div class="page-head"><div><h2>${esc(l.season_name)}</h2><p>${esc(l.blurb)}</p></div>${leagueSwitch(league, { premier: 'schedule', affiliate: 'affiliateSchedule' })}</div>
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

export function standingsView() {
  return `<div class="panel"><h2>Standings</h2>
    <p>Ranked by game win percentage, then point differential. Every game of every best-of-3 counts, and so does winning the week.</p>
    ${store.data.leagues.map(l => {
      const rows = standings(l.id);
      return `<h3 class="eyebrow league-label">${esc(l.name.toUpperCase())}</h3>
      ${wrap(`<table class="data-table standings">
        <thead><tr><th>#</th><th>Team</th><th class="num">GP</th><th class="num">W</th><th class="num">L</th><th class="num">PCT</th><th class="num">DIFF</th><th class="num">WEEKS WON</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr class="${l.id === 'premier' && i === 7 ? 'playoff-line' : ''}">
          <td class="rank${l.id === 'premier' && i < 8 ? ' seed' : ''}">${i + 1}</td><td><a href="#${l.id}?team=${r.team.id}">${esc(r.team.name)}</a></td>
          <td class="num">${r.gp}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num">${winPct(r)}</td>
          <td class="num">${signed(r.diff)}</td><td class="num">${r.sw}–${r.sl}</td></tr>`).join('')}</tbody>
      </table>`)}
      ${l.id === 'premier' ? '<p class="muted">Dashed line: the top eight teams qualify for the playoffs.</p>' : ''}`;
    }).join('')}
  </div>`;
}

// ---------- Player stats ----------

const STAT_COLUMNS = [
  ['gp', 'GP', r => r.gp],
  ['ppg', 'PPG', r => r.pts / r.gp], ['rpg', 'RPG', r => r.reb / r.gp], ['apg', 'APG', r => r.ast / r.gp],
  ['spg', 'SPG', r => r.stl / r.gp], ['bpg', 'BPG', r => r.blk / r.gp], ['tpg', 'TO', r => r.tov / r.gp],
  ['fgp', 'FG%', r => (r.fga ? r.fgm / r.fga : -1)], ['tpp', '3P%', r => (r.tpa ? r.tpm / r.tpa : -1)], ['ftp', 'FT%', r => (r.fta ? r.ftm / r.fta : -1)],
];
const statState = { league: 'premier', phase: 'regular', sort: 'ppg', dir: -1, rows: [] };

export function stats() {
  return `<div class="panel"><h2>Player statistics</h2>
    <div class="toolbar">
      <label>League <select data-stat="league">${store.data.leagues.map(l => `<option value="${l.id}" ${statState.league === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
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
    fetchStats(el);
  });
  el.addEventListener('click', e => {
    const key = e.target.closest('[data-sort]')?.dataset.sort;
    if (!key) return;
    statState.dir = statState.sort === key ? -statState.dir : -1;
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
  const rows = statState.rows;
  const body = $('#statsBody', el);
  if (!rows.length) {
    body.innerHTML = '<p>No box scores recorded yet. Leaderboards fill in as soon as the first game is uploaded.</p>';
    return;
  }
  const col = STAT_COLUMNS.find(c => c[0] === statState.sort);
  const sorted = [...rows].sort((a, b) => (col[2](b) - col[2](a)) * -statState.dir || a.tag.localeCompare(b.tag));
  const leader = (key, label, fn) => {
    const top = [...rows].sort((a, b) => fn(b) - fn(a))[0];
    return `<div class="stat"><strong>${fn(top).toFixed(1)}</strong><span>${label}</span><em>${esc(top.tag)} · ${esc(top.team)}</em></div>`;
  };
  body.innerHTML = `
    <div class="stats leaders">
      ${leader('ppg', 'POINTS PER GAME', r => r.pts / r.gp)}
      ${leader('rpg', 'REBOUNDS PER GAME', r => r.reb / r.gp)}
      ${leader('apg', 'ASSISTS PER GAME', r => r.ast / r.gp)}
      ${leader('spg', 'STEALS PER GAME', r => r.stl / r.gp)}
      ${leader('bpg', 'BLOCKS PER GAME', r => r.blk / r.gp)}
    </div>
    ${wrap(`<table class="data-table">
      <thead><tr><th>Player</th><th>Team</th>
        ${STAT_COLUMNS.map(([key, label]) => `<th class="num" ${statState.sort === key ? `aria-sort="${statState.dir < 0 ? 'descending' : 'ascending'}"` : ''}><button data-sort="${key}">${label}</button></th>`).join('')}
      </tr></thead>
      <tbody>${sorted.map(r => `<tr><td><a href="#player/${r.player_id}">${esc(r.tag)}</a></td><td>${esc(r.team)}</td>
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
      <div class="${won === 'home' ? 'won' : ''}"><span class="team-score">${game.home_score}</span><span class="team-name">${esc(teamName(s.home_team_id))}</span>${game.forfeit === 'home' ? '<br><span class="badge">FORFEITED</span>' : ''}</div>
      <span class="fixture-vs">FINAL</span>
      <div class="${won === 'away' ? 'won' : ''}"><span class="team-score">${game.away_score}</span><span class="team-name">${esc(teamName(s.away_team_id))}</span>${game.forfeit === 'away' ? '<br><span class="badge">FORFEITED</span>' : ''}</div>
    </div>
    ${table('home')}${table('away')}
    <p>${shot ? `<a href="/api/screenshots/${shot}" target="_blank" rel="noopener">View the original screenshot ↗</a> · ` : ''}
      <a href="#${s.league_id === 'premier' ? 'schedule' : 'affiliateSchedule'}">Back to the schedule</a>
      ${store.data.me.admin ? ` · <a href="#game?edit=${game.id}">Edit this result</a>` : ''}</p>`;
};

export function player() {
  return '<div class="panel" id="playerPanel"><p class="muted">Loading player…</p></div>';
}

player.after = async (el, id) => {
  const { player: p, games } = await api(`/api/players/${id}`);
  const n = games.length;
  const avg = k => (n ? (games.reduce((t, g) => t + g[k], 0) / n).toFixed(1) : '—');
  const sum = k => games.reduce((t, g) => t + g[k], 0);
  $('#playerPanel', el).innerHTML = `
    <h2>${esc(p.tag)}</h2>
    <div class="stats">
      <div class="stat"><strong>${n}</strong><span>GAMES</span></div>
      <div class="stat"><strong>${avg('pts')}</strong><span>POINTS PER GAME</span></div>
      <div class="stat"><strong>${avg('reb')}</strong><span>REBOUNDS PER GAME</span></div>
      <div class="stat"><strong>${avg('ast')}</strong><span>ASSISTS PER GAME</span></div>
      <div class="stat"><strong>${ratio(sum('fgm'), sum('fga'))}</strong><span>FIELD GOAL %</span></div>
    </div>
    ${n ? wrap(`<table class="data-table"><caption>Game log</caption>
      <thead><tr><th>Game</th><th>Team</th><th>Opponent</th>${['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FG', '3PT', 'FT'].map(h => `<th class="num">${h}</th>`).join('')}</tr></thead>
      <tbody>${games.map(g => {
        const opp = g.team_id === g.home_team_id ? g.away_team_id : g.home_team_id;
        return `<tr><td><a href="#box/${g.game_id}">${g.week ? `Wk ${pad2(g.week)}` : esc(g.label)} · G${g.game_number}</a></td>
          <td>${esc(teamName(g.team_id))}</td><td>${esc(teamName(opp))}</td>
          <td class="num">${g.pts}</td><td class="num">${g.reb}</td><td class="num">${g.ast}</td><td class="num">${g.stl}</td><td class="num">${g.blk}</td>
          <td class="num">${g.tov}</td><td class="num">${g.fgm}/${g.fga}</td><td class="num">${g.tpm}/${g.tpa}</td><td class="num">${g.ftm}/${g.fta}</td></tr>`;
      }).join('')}</tbody></table>`) : '<p>No games recorded yet.</p>'}`;
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

export function registration() {
  const field = (name, label, type = 'text', extra = 'required') => `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`;
  const pct = (name, label) => field(name, label, 'number', 'min="0" max="100" step="0.01" required');
  const honey = '<label class="honey" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>';
  return `<div class="panel"><h2>Registration</h2>
    <p>Registrations go straight to the commissioner. Contact details are never shown on the public site.</p>
    <section class="registration-section"><h3>Player Registration</h3>
      <form class="registration-form" data-register="player"><div class="registration-grid">
        ${field('discordTag', 'Discord Tag')}${field('steamTag', 'Steam Tag')}
        ${pct('recWinPercent', 'Rec Win %')}${pct('fgShootingPercent', 'FG Shooting %')}${pct('threePtShootingPercent', '3-pt Shooting %')}
      </div>${honey}<button>Submit player registration</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>
    <section class="registration-section"><h3>Owner Registration</h3>
      <form class="registration-form" data-register="owner"><div class="registration-grid">
        ${field('steamTag', 'Steam Tag')}${field('discordTag', 'Discord Tag')}${field('crewName', 'Crew Name')}
        <fieldset class="roster-fields"><legend>Roster Slots</legend><div class="registration-grid">
          ${['1 PG', '2 SG', '3 SF', '4 PF', '5 C', '6th Man', '7th Man'].map((s, i) => field(`roster${i}`, s, 'text', 'placeholder="Discord Tag"')).join('')}
        </div></fieldset>
      </div>${honey}<button>Submit owner registration</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>
    <section class="registration-section"><h3>Sponsorship Interest</h3>
      <form class="registration-form" data-register="sponsor"><div class="registration-grid">
        <fieldset class="result-status"><legend>Sponsor type</legend>
          <label><input type="radio" name="type" value="Company" checked><span>Company</span></label>
          <label><input type="radio" name="type" value="Individual"><span>Individual</span></label>
        </fieldset>
        ${field('name', 'Name')}${field('email', 'Contact E-mail', 'email')}${field('phone', 'Contact Phone', 'tel', '')}
        <label class="wide-field">Product or personal description<textarea name="description" rows="4" required></textarea></label>
      </div>${honey}<button>Submit sponsorship interest</button><p class="msg" role="status" aria-live="polite"></p></form>
    </section>
  </div>`;
}

const REGISTER_DONE = {
  player: 'Player registration received. The commissioner will review it.',
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
    if (kind === 'owner') data.roster = [0, 1, 2, 3, 4, 5, 6].map(i => data[`roster${i}`]);
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

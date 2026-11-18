// Score ticker under the header: the latest final scores (each one opens its box score), plus this
// weekend's matchups that have not been played yet. It rolls right to left without stopping; it holds
// still under the pointer or keyboard focus, has a Pause button, and can be swiped or scrolled.
import { store, esc, $, pad2, teamName, gameWinner, currentWeek, leagueRoute, leagueShort } from './core.js';

const MAX_FINALS = 24;
const FEW = 8;           // with fewer finals than this, upcoming matchups fill the strip
const SPEED = 45;        // pixels per second
let shown = '';          // last rendered items, so a page change does not restart the scroll
let watcher = null;

function finalItem(g, s, week) {
  const d = store.data;
  const league = d.leagueById.get(s.league_id);
  const won = gameWinner(g);
  const row = (side, score) => `<span class="tk-row${won === side ? ' win' : ''}"><span>${esc(teamName(s[`${side}_team_id`]) || 'TBD')}</span><b>${score}${g.forfeit === side ? '<small> F</small>' : ''}</b></span>`;
  const href = g.has_box ? `#box/${g.id}` : `#${leagueRoute(s.league_id, 'schedule')}`;
  return `<a class="tk" href="${href}" title="${g.has_box ? 'Open the box score' : 'Open the schedule'}">
    <span class="tk-meta"><b>${esc(leagueShort(league).toUpperCase())}</b> ${week ? `WK ${pad2(week.number)}` : esc(s.label.toUpperCase())} · G${g.game_number} <em>FINAL</em></span>
    ${row('home', g.home_score)}${row('away', g.away_score)}</a>`;
}

function upcomingItem(s, cw) {
  const league = store.data.leagueById.get(s.league_id);
  const row = side => `<span class="tk-row"><span>${esc(teamName(s[`${side}_team_id`]) || 'TBD')}</span></span>`;
  return `<a class="tk" href="#${leagueRoute(s.league_id, 'schedule')}" title="Open the schedule">
    <span class="tk-meta"><b>${esc(leagueShort(league).toUpperCase())}</b> WK ${pad2(cw.week.number)} <em class="soon">${cw.live ? 'THIS WEEKEND' : esc(cw.week.date_label).toUpperCase()}</em></span>
    ${row('home')}${row('away')}</a>`;
}

function items() {
  const d = store.data;
  const leagueSort = new Map(d.leagues.map(l => [l.id, l.sort]));
  // Newest weekend first (playoff games have no weekend and come before everything else); inside a
  // weekend: league, then matchup, then game 1, 2, 3.
  const when = s => d.weekById.get(s.week_id)?.start_date || '9999';
  const finals = d.games.map(g => ({ g, s: d.seriesById.get(g.series_id) })).filter(x => x.s)
    .sort((a, b) => when(b.s).localeCompare(when(a.s)) || leagueSort.get(a.s.league_id) - leagueSort.get(b.s.league_id)
      || a.s.id - b.s.id || a.g.game_number - b.g.game_number)
    .slice(0, MAX_FINALS)
    .map(({ g, s }) => finalItem(g, s, d.weekById.get(s.week_id)));
  if (finals.length >= FEW) return finals;
  const upcoming = d.leagues.flatMap(l => {
    const cw = currentWeek(l.id);
    if (!cw) return [];
    return d.series.filter(s => s.week_id === cw.week.id && !d.gamesBySeries.has(s.id)).map(s => upcomingItem(s, cw));
  });
  return [...finals, ...upcoming];
}

// The ticker always rolls. The strip holds the items, then as many copies as it takes to fill the
// screen twice over, so there is always something to roll into; when one full set has gone past,
// the position jumps back by exactly one set, which looks the same. It moves by scrolling (not a
// CSS animation), so swiping and the scroll wheel still work on it.
let setWidth = 0;
let pos = 0;
let last = 0;
let paused = false;      // the Pause button
let held = false;        // pointer over it, or keyboard focus inside it

function fit(el) {
  const view = $('.ticker-view', el), track = $('.ticker-track', el), first = $('.ticker-set', el);
  if (!first || !first.offsetWidth) return;
  setWidth = first.offsetWidth;
  const copies = Math.ceil(view.clientWidth / setWidth) + 1;
  while (track.children.length - 1 > copies) track.lastChild.remove();
  while (track.children.length - 1 < copies) {
    const twin = first.cloneNode(true);
    twin.setAttribute('aria-hidden', 'true');
    for (const a of twin.querySelectorAll('a')) a.tabIndex = -1;
    track.append(twin);
  }
}

function roll(now) {
  requestAnimationFrame(roll);
  const view = $('#ticker .ticker-view');
  const dt = Math.min(100, now - last); // a background tab pauses frames; do not jump on return
  last = now;
  if (!view || !setWidth || paused || held) return;
  if (Math.abs(view.scrollLeft - pos) > 2) pos = view.scrollLeft; // the visitor scrolled it by hand
  pos += (SPEED * dt) / 1000;
  if (pos >= setWidth) pos -= setWidth;
  view.scrollLeft = pos;
}
requestAnimationFrame(roll);

function setPaused(el, value) {
  paused = value;
  const button = $('.ticker-pause', el);
  button.setAttribute('aria-pressed', String(paused));
  button.setAttribute('aria-label', paused ? 'Resume the score ticker' : 'Pause the score ticker');
  button.textContent = paused ? '▶' : '❚❚';
  try { localStorage.setItem('tickerPaused', paused ? '1' : ''); } catch { /* private mode */ }
}

export function renderTicker() {
  const el = $('#ticker');
  const list = items();
  const html = list.join('');
  if (html === shown) return;
  shown = html;
  el.hidden = !list.length;
  if (!list.length) return el.replaceChildren();
  el.innerHTML = `<span class="ticker-label">Scores</span>
    <div class="ticker-view"><div class="ticker-track"><div class="ticker-set">${html}</div></div></div>
    <button type="button" class="ticker-pause"></button>`;
  pos = 0;
  let stored = '';
  try { stored = localStorage.getItem('tickerPaused') || ''; } catch { /* private mode */ }
  setPaused(el, Boolean(stored));
  $('.ticker-pause', el).onclick = () => setPaused(el, !paused);
  const view = $('.ticker-view', el);
  view.onpointerenter = () => { held = true; };
  view.onpointerleave = () => { held = false; };
  view.onfocusin = () => { held = true; };
  view.onfocusout = () => { held = false; };
  fit(el);
  watcher?.disconnect();
  watcher = new ResizeObserver(() => fit(el));
  watcher.observe($('.ticker-view', el));
}

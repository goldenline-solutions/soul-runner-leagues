// Shared state, API access and league math for every page.

export const SLOTS = [['PG', '1 - PG'], ['SG', '2 - SG'], ['SF', '3 - SF'], ['PF', '4 - PF'], ['C', '5 - C'], ['6TH', '6th Man'], ['7TH', '7th Man']];
export const STAT_KEYS = ['pts', 'reb', 'ast', 'stl', 'blk', 'pf', 'tov', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'];
export const STAT_LABELS = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', pf: 'PF', tov: 'TO', fgm: 'FGM', fga: 'FGA', tpm: '3PM', tpa: '3PA', ftm: 'FTM', fta: 'FTA' };

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body } = {}) {
  if (method !== 'GET' && body === undefined) body = {}; // the server only accepts JSON writes (CSRF guard)
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 413 && !data.error) throw new Error('That upload is too large for the server.');
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Bootstrap payload plus lookup tables, rebuilt after every write.
export const store = { data: null };

export async function load() {
  const d = await api('/api/bootstrap');
  d.teamById = new Map(d.teams.map(t => [t.id, t]));
  d.weekById = new Map(d.weeks.map(w => [w.id, w]));
  d.seriesById = new Map(d.series.map(s => [s.id, s]));
  d.leagueById = new Map(d.leagues.map(l => [l.id, l]));
  d.gamesBySeries = new Map();
  for (const g of d.games) {
    if (!d.gamesBySeries.has(g.series_id)) d.gamesBySeries.set(g.series_id, []);
    d.gamesBySeries.get(g.series_id).push(g);
  }
  for (const list of d.gamesBySeries.values()) list.sort((a, b) => a.game_number - b.game_number);
  d.rosterByTeam = new Map();
  for (const r of d.roster) {
    if (!d.rosterByTeam.has(r.team_id)) d.rosterByTeam.set(r.team_id, {});
    d.rosterByTeam.get(r.team_id)[r.slot] = r;
  }
  store.data = d;
  return d;
}

export const teamName = id => store.data.teamById.get(id)?.name ?? '';

export const teamInitials = t => t.name.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
export const logoUrl = t => (t.logo_version > 0 ? `/api/teams/${t.id}/logo?v=${t.logo_version}` : '');

// Team logo, or initials in a badge when the commissioner hasn't uploaded one. size: CSS class suffix.
export function teamLogo(t, size = 'md') {
  if (!t) return '';
  if (t.logo_version > 0) {
    return `<img class="team-logo team-logo-${size}" src="${logoUrl(t)}" alt="${esc(t.name)} logo" loading="lazy">`;
  }
  return `<span class="team-logo team-logo-${size} team-logo-empty" aria-hidden="true">${esc(teamInitials(t))}</span>`;
}

// Shrinks an image file to fit max x max and returns a data URL (WebP, or PNG where WebP isn't supported).
// Keeps transparency, so cut-out mascots stay cut out. 1200 px keeps the full-width team banner sharp;
// if the result is over the server's 1.5 MB limit (big PNGs), it steps down in size.
export async function shrinkLogo(file, max = 1200) {
  const bitmap = await createImageBitmap(file);
  for (let size = max; ; size = Math.round(size * 0.75)) {
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.9);
    const url = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
    if (url.length * 0.75 < 1_400_000 || size < 300) return url;
  }
}
export const seriesGames = id => store.data.gamesBySeries.get(id) ?? [];
export const teamsIn = league => store.data.teams.filter(t => t.league_id === league);

export function gameWinner(g) {
  if (g.forfeit === 'home') return 'away';
  if (g.forfeit === 'away') return 'home';
  return g.home_score > g.away_score ? 'home' : 'away';
}

export function seriesRecord(series) {
  const rec = { home: 0, away: 0, games: seriesGames(series.id) };
  for (const g of rec.games) rec[gameWinner(g)]++;
  rec.decided = rec.home >= 2 || rec.away >= 2;
  rec.winner = rec.home >= 2 ? series.home_team_id : rec.away >= 2 ? series.away_team_id : null;
  return rec;
}

// Regular season table: game win %, then point differential (the original site's ranking rule).
export function standings(league) {
  const rows = new Map(teamsIn(league).map(t => [t.id, { team: t, gp: 0, w: 0, l: 0, diff: 0, sw: 0, sl: 0 }]));
  for (const s of store.data.series) {
    if (s.league_id !== league || s.stage !== 'regular') continue;
    const home = rows.get(s.home_team_id), away = rows.get(s.away_team_id);
    if (!home || !away) continue;
    for (const g of seriesGames(s.id)) {
      home.gp++; away.gp++;
      home.diff += g.home_score - g.away_score;
      away.diff += g.away_score - g.home_score;
      const win = gameWinner(g) === 'home' ? [home, away] : [away, home];
      win[0].w++; win[1].l++;
    }
    const rec = seriesRecord(s);
    if (rec.decided) {
      const win = rec.winner === s.home_team_id ? [home, away] : [away, home];
      win[0].sw++; win[1].sl++;
    }
  }
  // Ranked by series (matchup) win percentage, then game win percentage, then point differential.
  const gamePct = r => (r.gp ? r.w / r.gp : 0);
  return [...rows.values()].sort((a, b) => seriesPct(b) - seriesPct(a) || gamePct(b) - gamePct(a)
    || b.diff - a.diff || a.team.name.localeCompare(b.team.name));
}

const seriesPct = r => (r.sw + r.sl ? r.sw / (r.sw + r.sl) : 0);

// Series (matchup) win percentage, as shown in the standings: .667, 1.000.
export const winPct = r => seriesPct(r).toFixed(3).replace(/^0/, '');
export const signed = n => (n > 0 ? `+${n}` : String(n));

const todayIso = () => new Date().toLocaleDateString('en-CA');
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

// The weekend being played now, or the next one up; null once the season is over.
export function currentWeek(league) {
  const today = todayIso();
  const weeks = store.data.weeks.filter(w => w.league_id === league && w.start_date);
  const live = weeks.find(w => w.start_date <= today && today <= addDays(w.start_date, 2));
  if (live) return { week: live, live: true };
  const next = weeks.find(w => w.start_date > today);
  return next ? { week: next, live: false } : null;
}

export const pad2 = n => String(n).padStart(2, '0');

export function ratio(made, att) {
  return att ? `${((made / att) * 100).toFixed(1)}%` : '—';
}

export function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

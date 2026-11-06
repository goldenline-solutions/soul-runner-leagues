// Commissioner's Desk: registrations inbox, news, All-Star, playoff seeding, backup.
import { store, esc, api, $, teamsIn, standings, seriesGames, setMsg, formData } from './core.js';

const LABELS = {
  discordTag: 'Discord', steamTag: 'Steam', recWinPercent: 'Rec Win %', fgShootingPercent: 'FG %',
  threePtShootingPercent: '3-pt %', crewName: 'Crew', type: 'Type', name: 'Name', email: 'E-mail', phone: 'Phone', description: 'Description',
};
const SEEDS = { 1: [1, 8], 2: [4, 5], 3: [2, 7], 4: [3, 6] };
let filter = 'new';

export function desk() {
  const a = store.data.allstar || {};
  return `<div class="panel"><h2>Commissioner's Desk</h2>
    <p>Everything here is private to the commissioner. Scores and box scores live in <a href="#game">Upload Results</a>; rosters are edited from each team's card (pick a team in <a href="#premier">Premier Teams</a> or <a href="#affiliate">Affiliate Teams</a>).</p>

    <section class="registration-section"><h3>Registrations</h3>
      <div class="toolbar"><label>Show <select data-reg-filter>
        ${['new', 'approved', 'archived', 'all'].map(f => `<option value="${f}" ${f === filter ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}
      </select></label></div>
      <div id="regList" class="reg-list"><p class="muted">Loading…</p></div>
    </section>

    <section class="registration-section"><h3>Post to Tyreek's Desk</h3>
      <form id="newsForm" class="stack">
        <label>Headline<input name="title" required maxlength="200"></label>
        <label>Story<textarea name="body" rows="6" required></textarea></label>
        <button>Publish</button><p class="msg" role="status"></p>
      </form>
      <div class="reg-list">${store.data.news.map(n => `<div class="reg-card"><strong>${esc(n.title)}</strong>
        <span class="muted small"> · ${esc(n.published_at.slice(0, 10))}</span>
        <button class="btn-danger btn-small" data-del-news="${n.id}">Delete</button></div>`).join('')}</div>
    </section>

    <section class="registration-section"><h3>Playoff matchups</h3>
      <p class="muted">Set teams once the regular season ends. "Fill from standings" seeds the quarterfinals 1v8, 4v5, 2v7, 3v6.</p>
      <button class="btn-ghost" data-fill-qf>Fill quarterfinals from standings</button>
      <div class="reg-list">${playoffRows()}</div>
      <p class="msg" id="playoffMsg" role="status"></p>
    </section>

    <section class="registration-section"><h3>All-Star Game</h3>
      <form id="allstarForm" class="stack">
        <label>When (shown on the All-Star page)<input name="when" value="${esc(a.when || '')}" placeholder="Saturday, March 27 · 8 PM ET"></label>
        <label>All-Star Team 1 (one player per line)<textarea name="team1" rows="5">${esc((a.team1 || []).join('\n'))}</textarea></label>
        <label>All-Star Team 2 (one player per line)<textarea name="team2" rows="5">${esc((a.team2 || []).join('\n'))}</textarea></label>
        <label>Team 1 final score<input name="score1" type="number" min="0" value="${a.score1 ?? ''}"></label>
        <label>Team 2 final score<input name="score2" type="number" min="0" value="${a.score2 ?? ''}"></label>
        <button>Save All-Star details</button><p class="msg" role="status"></p>
      </form>
    </section>

    <section class="registration-section"><h3>Backup</h3>
      <p>Download every table as one JSON file. Keep a copy somewhere safe each week.</p>
      <a class="promo-link" href="/api/admin/export" download="soul-runner-backup.json">Download data backup</a>
    </section>
  </div>`;
}

function playoffRows() {
  const options = (selected, league) => `<option value="">To be decided</option>${teamsIn(league).map(t =>
    `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
  return store.data.series.filter(s => s.stage !== 'regular').map(s => {
    const locked = seriesGames(s.id).length > 0;
    return `<form class="reg-card toolbar" data-series="${s.id}">
      <strong>${esc(s.label)}</strong>
      <label>Home <select name="home_team_id" ${locked ? 'disabled' : ''}>${options(s.home_team_id, s.league_id)}</select></label>
      <label>Away <select name="away_team_id" ${locked ? 'disabled' : ''}>${options(s.away_team_id, s.league_id)}</select></label>
      ${locked ? '<span class="muted small">Games recorded · locked</span>' : '<button class="btn-small">Save</button>'}
    </form>`;
  }).join('');
}

desk.after = async el => {
  el.addEventListener('change', e => {
    if (e.target.dataset.regFilter === undefined) return;
    filter = e.target.value;
    loadRegistrations(el);
  });
  el.addEventListener('click', async e => {
    const t = e.target;
    const status = t.closest('[data-reg-status]');
    if (status) {
      await api(`/api/admin/registrations/${status.dataset.id}`, { method: 'PATCH', body: { status: status.dataset.regStatus } });
      await store.refresh();
      return;
    }
    const delNews = t.closest('[data-del-news]');
    if (delNews && confirm('Delete this post?')) {
      await api(`/api/admin/news/${delNews.dataset.delNews}`, { method: 'DELETE' });
      await store.refresh();
      return;
    }
    if (t.closest('[data-fill-qf]')) fillQuarterfinals(el);
  });
  el.addEventListener('submit', async e => {
    const form = e.target;
    e.preventDefault();
    const msg = $('.msg', form) || $('#playoffMsg', el);
    try {
      if (form.id === 'newsForm') await api('/api/admin/news', { method: 'POST', body: formData(form) });
      else if (form.id === 'allstarForm') await api('/api/admin/allstar', { method: 'PUT', body: formData(form) });
      else if (form.dataset.series) await api(`/api/admin/series/${form.dataset.series}`, { method: 'PUT', body: formData(form) });
      else return;
      await store.refresh();
    } catch (err) {
      setMsg(msg, err.message, 'error');
    }
  });
  await loadRegistrations(el);
};

async function loadRegistrations(el) {
  const list = (await api('/api/admin/registrations')).filter(r => filter === 'all' || r.status === filter);
  $('#regList', el).innerHTML = list.length ? list.map(r => {
    const d = r.data;
    const fields = Object.entries(d).filter(([k]) => k !== 'roster')
      .map(([k, v]) => `<dt>${esc(LABELS[k] || k)}</dt><dd>${esc(v)}</dd>`).join('');
    const roster = d.roster?.filter(x => x.discordTag).map(x => `${x.slot}: ${x.discordTag}`).join(' · ');
    return `<article class="reg-card">
      <span class="badge">${esc(r.kind.toUpperCase())}</span> <span class="muted small">${esc(r.created_at)} · ${esc(r.status)}</span>
      <dl>${fields}${roster ? `<dt>Roster</dt><dd>${esc(roster)}</dd>` : ''}</dl>
      ${r.status !== 'approved' ? `<button class="btn-small" data-reg-status="approved" data-id="${r.id}">${r.kind === 'player' ? 'Approve · add to league players' : 'Mark handled'}</button>` : ''}
      ${r.status !== 'archived' ? `<button class="btn-ghost btn-small" data-reg-status="archived" data-id="${r.id}">Archive</button>` : ''}
    </article>`;
  }).join('') : `<p class="muted">No ${filter === 'all' ? '' : `${filter} `}registrations.</p>`;
}

async function fillQuarterfinals(el) {
  const table = standings('premier');
  const msg = $('#playoffMsg', el);
  try {
    for (const s of store.data.series.filter(x => x.stage === 'qf')) {
      if (seriesGames(s.id).length) continue;
      const [hi, lo] = SEEDS[s.slot];
      await api(`/api/admin/series/${s.id}`, {
        method: 'PUT', body: { home_team_id: table[hi - 1]?.team.id, away_team_id: table[lo - 1]?.team.id },
      });
    }
    await store.refresh();
  } catch (err) {
    setMsg(msg, err.message, 'error');
  }
}


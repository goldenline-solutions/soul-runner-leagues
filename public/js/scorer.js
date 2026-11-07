// Upload Results: pick a matchup, optionally read a 2K screenshot, review the box score, save.
import {
  store, load, esc, api, $, $$, STAT_KEYS, STAT_LABELS, teamName, seriesGames, seriesRecord, currentWeek, pad2, setMsg,
} from './core.js';

const S = { ready: false };
const MAX_UPLOAD = 40 * 1024 * 1024; // bigger files are shrunk before upload (see fitForUpload)

export function scorer(id, query) {
  if (!store.data.me.admin) return loginPanel();
  if (!S.ready || (query.get('edit') && query.get('edit') !== S.appliedEdit)) initState(query);
  return `<div class="panel">
    <h2>Upload Results</h2>
    <p>Record a completed match. Standings, schedules, box scores and player stats update for everyone the moment you save.</p>
    <div class="toolbar" id="pickers">${pickers()}</div>
    <div id="scorerBody"><p class="muted">Loading…</p></div>
    <div class="step"><h3>Recently recorded</h3>${recent()}</div>
    <datalist id="playerTags">${store.data.players.map(p => `<option value="${esc(p.tag)}">`).join('')}</datalist>
  </div>`;
}

scorer.after = async el => {
  if (!store.data.me.admin) return wireLogin(el);
  el.addEventListener('change', e => onChange(el, e));
  el.addEventListener('input', e => onInput(el, e));
  el.addEventListener('click', e => onClick(el, e));
  el.addEventListener('dragover', e => { if (e.target.closest('.dropzone')) { e.preventDefault(); e.target.closest('.dropzone').classList.add('drag'); } });
  el.addEventListener('dragleave', e => e.target.closest('.dropzone')?.classList.remove('drag'));
  el.addEventListener('drop', e => {
    if (!e.target.closest('.dropzone')) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) readScreenshot(el, file);
  });
  await loadSlot();
  renderBody(el);
};

// Ctrl+V anywhere on Upload Results reads a pasted screenshot.
document.addEventListener('paste', e => {
  const el = document.getElementById('scorerBody')?.closest('.panel')?.parentElement;
  if (!el || e.target.closest?.('input, textarea')) return;
  const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
  if (file) readScreenshot(el, file);
});

// ---------- login ----------

function loginPanel() {
  return `<div class="panel"><h2>Upload Results</h2>
    <p>Upload Results is for the league commissioner. Log in to record scores, read box score screenshots and manage the league.</p>
    <form id="loginForm" class="stack">
      <label>Commissioner password<input type="password" name="password" required autocomplete="current-password"></label>
      <button>Log in</button>
      <p class="msg" role="status"></p>
    </form></div>`;
}

function wireLogin(el) {
  $('#loginForm', el).onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { password: e.target.password.value } });
      await store.refresh();
    } catch (err) {
      setMsg($('.msg', e.target), err.message, 'error');
    }
  };
}

// ---------- selection ----------

function initState(query) {
  Object.assign(S, { ready: true, league: 'premier', flash: null, warnings: [], shotUrl: null });
  const editId = Number(query.get('edit'));
  const game = editId && store.data.games.find(g => g.id === editId);
  if (game) {
    S.appliedEdit = query.get('edit');
    const s = store.data.seriesById.get(game.series_id);
    S.league = s.league_id;
    S.week = s.week_id ?? 'playoffs';
    S.seriesId = s.id;
    S.gameNumber = game.game_number;
    return;
  }
  pickWeek();
}

function weeksFor(league) {
  return store.data.weeks.filter(w => w.league_id === league);
}

function seriesFor() {
  return store.data.series.filter(s => s.league_id === S.league &&
    (S.week === 'playoffs' ? s.stage !== 'regular' : s.week_id === S.week));
}

function pickWeek() {
  const cw = currentWeek(S.league);
  const weeks = weeksFor(S.league);
  // Prefer the latest weekend that has started; otherwise the first one.
  const started = weeks.filter(w => w.start_date <= new Date().toLocaleDateString('en-CA'));
  S.week = (started.at(-1) || cw?.week || weeks[0])?.id;
  pickSeries();
}

function pickSeries() {
  const list = seriesFor();
  const open = list.find(s => s.home_team_id && s.away_team_id && !seriesRecord(s).decided);
  S.seriesId = (open || list[0])?.id;
  pickGame();
}

function pickGame() {
  const s = store.data.seriesById.get(S.seriesId);
  if (!s) { S.gameNumber = 1; return; }
  const rec = seriesRecord(s);
  S.gameNumber = rec.decided ? 1 : rec.games.length + 1;
}

function pickers() {
  const d = store.data;
  const weeks = weeksFor(S.league);
  const list = seriesFor();
  const s = d.seriesById.get(S.seriesId);
  const games = s ? seriesGames(s.id) : [];
  const rec = s ? seriesRecord(s) : null;
  const gameLabel = n => {
    if (games.some(g => g.game_number === n)) return `Game ${n} · recorded (edit)`;
    if (rec?.decided) return `Game ${n} · not needed`;
    return n === games.length + 1 ? `Game ${n} · next up` : `Game ${n}`;
  };
  return `
    <label>League <select data-pick="league">${d.leagues.map(l => `<option value="${l.id}" ${l.id === S.league ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    <label>Weekend <select data-pick="week">
      ${weeks.map(w => `<option value="${w.id}" ${w.id === S.week ? 'selected' : ''}>Weekend ${pad2(w.number)} · ${esc(w.date_label)}</option>`).join('')}
      ${d.series.some(x => x.league_id === S.league && x.stage !== 'regular') ? `<option value="playoffs" ${S.week === 'playoffs' ? 'selected' : ''}>Playoffs</option>` : ''}
    </select></label>
    <label>Matchup <select data-pick="series">${list.map(x => {
      const r = seriesRecord(x);
      const names = x.home_team_id ? `${teamName(x.home_team_id)} vs ${teamName(x.away_team_id)}` : `${x.label} · teams not set`;
      const label = x.label && x.home_team_id ? `${x.label}: ${names}` : names;
      return `<option value="${x.id}" ${x.id === S.seriesId ? 'selected' : ''}>${esc(label)}${r.games.length ? ` · ${r.home}–${r.away}${r.decided ? ' ✓' : ''}` : ''}</option>`;
    }).join('')}</select></label>
    <label>Series game <select data-pick="game">${[1, 2, 3].map(n => `<option value="${n}" ${n === S.gameNumber ? 'selected' : ''}>${gameLabel(n)}</option>`).join('')}</select></label>`;
}

// Loads the chosen game (editing) or a blank sheet prefilled with both rosters.
async function loadSlot() {
  const s = store.data.seriesById.get(S.seriesId);
  S.editingId = null;
  S.screenshotId = null;
  S.forfeit = null;
  S.scores = { home: '', away: '' };
  S.dirty = { home: false, away: false };
  S.rows = { home: [], away: [] };
  if (!s) return;
  const existing = seriesGames(s.id).find(g => g.game_number === S.gameNumber);
  if (existing) {
    const { game, lines, screenshot_id: shot } = await api(`/api/games/${existing.id}`);
    S.editingId = game.id;
    S.screenshotId = shot;
    S.forfeit = game.forfeit;
    S.scores = { home: game.home_score, away: game.away_score };
    S.dirty = { home: true, away: true };
    for (const side of ['home', 'away']) {
      S.rows[side] = lines.filter(l => l.team_id === s[`${side}_team_id`])
        .map(l => ({ tag: l.tag, stats: Object.fromEntries(STAT_KEYS.map(k => [k, l[k]])) }));
    }
  }
  // Blank sheet: roster players first, otherwise whoever played the previous game of this series.
  const previous = !existing && seriesGames(s.id).filter(g => g.game_number < S.gameNumber && g.has_box).at(-1);
  const prevLines = previous ? (await api(`/api/games/${previous.id}`)).lines : [];
  for (const side of ['home', 'away']) {
    if (S.rows[side].length) continue;
    const teamId = s[`${side}_team_id`];
    const roster = Object.values(store.data.rosterByTeam.get(teamId) || {}).filter(r => r.tag);
    const tags = roster.length ? roster.map(r => r.tag) : prevLines.filter(l => l.team_id === teamId).map(l => l.tag);
    S.rows[side] = tags.map(tag => ({ tag, stats: {} }));
    while (S.rows[side].length < 5) S.rows[side].push({ tag: '', stats: {} });
  }
}

// ---------- body ----------

function renderBody(el) {
  const s = store.data.seriesById.get(S.seriesId);
  const body = $('#scorerBody', el);
  if (!s) { body.innerHTML = '<p>No matchups in this weekend.</p>'; return; }
  if (!s.home_team_id || !s.away_team_id) {
    body.innerHTML = `<p>This playoff matchup doesn't have teams yet. Set them in the <a href="#desk">Commissioner's Desk</a>.</p>`;
    return;
  }
  const rec = seriesRecord(s);
  const blocked = !S.editingId && (rec.decided || S.gameNumber > rec.games.length + 1);
  const last = S.editingId && !seriesGames(s.id).some(g => g.game_number > S.gameNumber);
  body.innerHTML = `
    ${S.flash ? `<p class="msg ok">${S.flash}</p>` : ''}
    ${S.editingId ? `<div class="postseason-banner">Editing Game ${S.gameNumber}. Saving replaces the recorded score and box score.</div>` : ''}
    ${blocked ? `<div class="postseason-banner">${rec.decided ? 'This best-of-3 series is already decided.' : 'Record the earlier series games first.'}</div>` : ''}
    <div class="step">
      <h3>1 · Read a screenshot <span class="muted small">(optional)</span></h3>
      <label class="dropzone" id="dropzone">
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-file>
        <strong>Drop the 2K box score screenshot here</strong>
        or click to choose a file · or paste it with Ctrl+V
      </label>
      <div id="shotResult">${shotResult()}</div>
    </div>
    <div class="step">
      <div class="step-head"><h3>2 · Check the box score</h3><button type="button" class="btn-ghost btn-small" data-swap>⇄ Swap teams</button></div>
      <p class="muted">Each row is one player. Rows left blank are skipped. Highlighted rows have points that don't match 2×FGM + 3PM + FTM.</p>
      ${teamEntry('home', s)}${teamEntry('away', s)}
    </div>
    <div class="form-actions">
      <button data-save ${blocked ? 'disabled' : ''}>${S.editingId ? 'Save changes' : 'Save result'}</button>
      ${last ? '<button class="btn-danger" data-delete>Delete this game</button>' : ''}
      <button class="btn-ghost" data-reset>Start over</button>
      <p class="msg" id="saveMsg" role="status" aria-live="polite"></p>
    </div>`;
  S.flash = null;
  for (const side of ['home', 'away']) updateTotals(el, side);
}

function shotResult() {
  const parts = [];
  if (S.shotUrl || S.screenshotId) {
    const src = S.shotUrl || `/api/screenshots/${S.screenshotId}`;
    parts.push(`<div class="shot-preview"><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Box score screenshot"></a></div>`);
  }
  if (S.warnings?.length) parts.push(`<ul class="warnings">${S.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`);
  return parts.join('');
}

function teamEntry(side, s) {
  const name = teamName(s[`${side}_team_id`]);
  const rows = S.rows[side];
  return `<section class="team-entry" data-side="${side}">
    <div class="team-entry-head">
      <h4><span class="eyebrow">${side.toUpperCase()}</span><br>${esc(name)}</h4>
      <fieldset class="result-status"><legend>${esc(name)} status</legend>
        <label><input type="radio" name="status-${side}" value="played" ${S.forfeit !== side ? 'checked' : ''}><span>Played</span></label>
        <label><input type="radio" name="status-${side}" value="forfeited" ${S.forfeit === side ? 'checked' : ''}><span>Forfeited</span></label>
      </fieldset>
      <label>Final score <input class="score-input" type="number" min="0" max="400" data-score="${side}" value="${esc(S.scores[side])}"></label>
      <span class="score-note" data-note="${side}"></span>
    </div>
    <div class="series-scores"><table class="box-entry">
      <thead><tr><th>Player</th>${STAT_KEYS.map(k => `<th>${STAT_LABELS[k]}</th>`).join('')}<th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody>${rows.map((r, i) => rowHtml(side, r, i)).join('')}</tbody>
    </table></div>
    <button class="btn-ghost btn-small" data-add-row="${side}">+ Add player</button>
    <details class="paste-box"><summary>Paste stat lines from a spreadsheet or chat</summary>
      <p class="muted small">One player per line: tag, then PTS REB AST STL BLK TO PF FGM FGA 3PM 3PA FTM FTA. Pairs like 8/15 or 8-15 work too, and grades (A+, B-) are ignored.</p>
      <textarea data-paste="${side}" placeholder="Ace#1	24	6	5	2	0	3	2	9	15	3	6	3	4"></textarea>
      <button class="btn-ghost btn-small" data-apply-paste="${side}">Fill from pasted lines</button>
      <span class="msg" data-paste-msg="${side}"></span>
    </details>
  </section>`;
}

function rowHtml(side, r, i) {
  const note = r.ai
    ? `<span class="read-as">AI player · left out unless you change the name</span>`
    : r.read_as && r.how === 'fuzzy' ? `<span class="read-as fuzzy">read as "${esc(r.read_as)}" · ${r.score}% match</span>`
      : r.read_as && !r.how ? `<span class="read-as">read as "${esc(r.read_as)}" · new player</span>` : '';
  return `<tr data-row="${i}" class="${r.ai ? 'ai' : ''}">
    <td><input class="tag" data-field="tag" list="playerTags" value="${esc(r.tag)}" aria-label="Player tag">${note}</td>
    ${STAT_KEYS.map(k => `<td><input type="number" min="0" max="999" inputmode="numeric" data-field="${k}" value="${r.stats[k] ?? ''}" aria-label="${STAT_LABELS[k]}"></td>`).join('')}
    <td><button class="btn-ghost btn-small" data-remove-row aria-label="Remove row">×</button></td>
  </tr>`;
}

const num = v => Number(v) || 0;
const rowIsBlank = r => !r.tag.trim() && STAT_KEYS.every(k => !num(r.stats[k]));

function rowMismatch(r) {
  const s = r.stats;
  if (!num(s.pts) && !num(s.fga)) return null;
  const expected = 2 * num(s.fgm) + num(s.tpm) + num(s.ftm);
  return expected === num(s.pts) ? null : expected;
}

function updateTotals(el, side) {
  const rows = S.rows[side].filter(r => !r.ai);
  const pts = rows.reduce((t, r) => t + num(r.stats.pts), 0);
  const scoreInput = $(`[data-score="${side}"]`, el);
  if (!S.dirty[side] && pts) {
    S.scores[side] = pts;
    scoreInput.value = pts;
  }
  const note = $(`[data-note="${side}"]`, el);
  const score = num(scoreInput.value);
  note.textContent = pts ? `Player points add up to ${pts}${scoreInput.value !== '' && pts !== score ? ` · final score says ${score}` : ''}` : '';
  note.classList.toggle('mismatch', Boolean(pts && scoreInput.value !== '' && pts !== score));
  $$(`[data-side="${side}"] tr[data-row]`, el).forEach(tr => {
    const r = S.rows[side][Number(tr.dataset.row)];
    const exp = r && rowMismatch(r);
    tr.classList.toggle('warn', exp !== null && exp !== undefined);
    tr.title = exp !== null && exp !== undefined ? `PTS doesn't match 2×FGM + 3PM + FTM (= ${exp})` : '';
  });
}

// ---------- events ----------

async function onChange(el, e) {
  const pick = e.target.dataset.pick;
  if (pick) {
    if (location.hash.includes('?')) history.replaceState(null, '', '#game');
    S.appliedEdit = null;
    if (pick === 'league') { S.league = e.target.value; pickWeek(); }
    if (pick === 'week') { S.week = e.target.value === 'playoffs' ? 'playoffs' : Number(e.target.value); pickSeries(); }
    if (pick === 'series') { S.seriesId = Number(e.target.value); pickGame(); }
    if (pick === 'game') S.gameNumber = Number(e.target.value);
    S.warnings = [];
    S.shotUrl = null;
    $('#pickers', el).innerHTML = pickers();
    await loadSlot();
    renderBody(el);
    return;
  }
  if (e.target.dataset.file !== undefined && e.target.files[0]) readScreenshot(el, e.target.files[0]);
  const status = e.target.name?.match(/^status-(home|away)$/);
  if (status) {
    const side = status[1];
    if (e.target.value === 'forfeited') S.forfeit = side;
    else if (S.forfeit === side) S.forfeit = null;
    const other = side === 'home' ? 'away' : 'home';
    if (S.forfeit === side) $(`input[name="status-${other}"][value="played"]`, el).checked = true;
  }
}

function onInput(el, e) {
  const side = e.target.closest('[data-side]')?.dataset.side;
  if (!side) return;
  if (e.target.dataset.score) {
    S.dirty[side] = e.target.value !== '';
    S.scores[side] = e.target.value;
    updateTotals(el, side);
    return;
  }
  const field = e.target.dataset.field;
  const tr = e.target.closest('tr[data-row]');
  if (!field || !tr) return;
  const row = S.rows[side][Number(tr.dataset.row)];
  if (field === 'tag') {
    row.tag = e.target.value;
    row.ai = false;
    tr.classList.remove('ai');
  } else {
    row.stats[field] = e.target.value === '' ? '' : Number(e.target.value);
  }
  updateTotals(el, side);
}

async function onClick(el, e) {
  const t = e.target;
  const side = t.closest('[data-side]')?.dataset.side;
  if (t.closest('[data-add-row]')) {
    S.rows[side].push({ tag: '', stats: {} });
    return rerenderTeam(el, side);
  }
  if (t.closest('[data-remove-row]')) {
    S.rows[side].splice(Number(t.closest('tr').dataset.row), 1);
    return rerenderTeam(el, side);
  }
  if (t.closest('[data-apply-paste]')) {
    const lines = parseLines($(`[data-paste="${side}"]`, el).value);
    applyLines(side, lines);
    rerenderTeam(el, side);
    setMsg($(`[data-paste-msg="${side}"]`, el), lines.length ? `Filled ${lines.length} line${lines.length === 1 ? '' : 's'}.` : 'No stat lines found.', lines.length ? 'ok' : 'error');
    return;
  }
  if (t.closest('[data-swap]')) {
    // Moves every player line and score to the other team, for when the screenshot sides came out backwards.
    for (const k of ['rows', 'scores', 'dirty']) S[k] = { home: S[k].away, away: S[k].home };
    renderBody(el);
    $('[data-swap]', el).focus();
    setMsg($('#saveMsg', el), 'Swapped the players and scores of the two teams.', 'ok');
    return;
  }
  if (t.closest('[data-save]')) return save(el, t.closest('[data-save]'));
  if (t.closest('[data-delete]')) return remove(el);
  if (t.closest('[data-reset]')) {
    S.warnings = [];
    S.shotUrl = null;
    await loadSlot();
    renderBody(el);
  }
}

function rerenderTeam(el, side) {
  const s = store.data.seriesById.get(S.seriesId);
  const section = $(`[data-side="${side}"]`, el);
  const open = $('details', section).open;
  section.outerHTML = teamEntry(side, s);
  if (open) $(`[data-side="${side}"] details`, el).open = true;
  updateTotals(el, side);
}

// ---------- paste parsing ----------

export function parseLines(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    let tag, rest;
    if (/[\t,;]/.test(line)) {
      const parts = line.split(/[\t,;]/).map(p => p.trim());
      tag = parts.shift();
      rest = parts.join(' ');
    } else {
      const m = line.match(/^(.*?)\s+((?:[A-F][+-]?\s+)?\d+(?:[/-]\d+)?(?:\s+.*)?)$/i);
      if (!m) return null;
      [, tag, rest] = m;
    }
    const nums = rest.split(/\s+/).filter(Boolean).filter(t => !/^[A-F][+-]?$/i.test(t))
      .flatMap(t => t.split(/[/-]/)).map(Number);
    if (!tag || !nums.length || nums.some(Number.isNaN)) return null;
    return { tag, stats: Object.fromEntries(STAT_KEYS.map((k, i) => [k, nums[i] ?? 0])) };
  }).filter(Boolean);
}

function applyLines(side, lines) {
  for (const line of lines) {
    const rows = S.rows[side];
    const match = rows.find(r => r.tag.trim().toLowerCase() === line.tag.toLowerCase())
      || rows.find(r => !r.tag.trim() && STAT_KEYS.every(k => !num(r.stats[k])));
    if (match) Object.assign(match, { tag: match.tag.trim() ? match.tag : line.tag, stats: line.stats, ai: false });
    else rows.push(line);
  }
}

// ---------- screenshot ----------

// Hosts cap request size (Vercel: 4.5 MB), so big screenshots are re-encoded as high-quality JPEG
// before upload. Typical 1080p/1440p box scores stay sharp enough for the model to read.
const UPLOAD_TARGET = 3_200_000; // characters of data URL, about 2.4 MB of image

const asDataUrl = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(blob);
});

async function fitForUpload(file) {
  const original = await asDataUrl(file);
  if (original.length <= UPLOAD_TARGET) return original;
  const bitmap = await createImageBitmap(file);
  let width = Math.min(bitmap.width, 2560);
  for (let attempt = 0; attempt < 6; attempt++) {
    const height = Math.round(bitmap.height * (width / bitmap.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const url = canvas.toDataURL('image/jpeg', attempt === 0 ? 0.92 : 0.85);
    if (url.length <= UPLOAD_TARGET) return url;
    if (attempt > 0) width = Math.round(width * 0.85);
  }
  throw new Error('That screenshot is too large to upload. Crop it to the box score and try again.');
}

async function readScreenshot(el, file) {
  const out = $('#shotResult', el);
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    out.innerHTML = '<p class="msg error">Use a PNG, JPG, WebP or GIF screenshot.</p>';
    return;
  }
  if (file.size > MAX_UPLOAD) {
    out.innerHTML = '<p class="msg error">That screenshot is over 40 MB. Save it as a JPG and try again.</p>';
    return;
  }
  out.innerHTML = '<p class="msg">Reading the screenshot… this usually takes 10 to 30 seconds.</p>';
  $('#dropzone', el)?.classList.remove('drag');
  try {
    const image = await fitForUpload(file);
    const r = await api('/api/admin/ingest', { method: 'POST', body: { image, series_id: S.seriesId } });
    if (r.duplicate_game_id && !r.lines) {
      out.innerHTML = `<p class="msg error">This exact screenshot is already saved. <a href="#box/${r.duplicate_game_id}">Open that box score</a>.</p>`;
      return;
    }
    S.shotUrl = URL.createObjectURL(file);
    S.screenshotId = r.screenshot_id;
    S.warnings = [...(r.cached ? ['Read earlier: using the saved reading of this screenshot (no new model call).'] : []), ...r.warnings];
    S.forfeit = null;
    S.scores = { home: r.home_score, away: r.away_score };
    S.dirty = { home: true, away: true };
    for (const side of ['home', 'away']) {
      S.rows[side] = r.lines.filter(l => l.side === side).map(l => ({
        tag: l.tag, stats: { ...l.stats }, read_as: l.read_as, how: l.match?.how, score: l.match?.score, ai: l.ai,
      }));
    }
    renderBody(el);
    if (r.duplicate_game_id) {
      $('#shotResult', el).insertAdjacentHTML('afterbegin', `<p class="msg error">Looks like a game already on record: <a href="#box/${r.duplicate_game_id}">compare with that box score</a>.</p>`);
    }
  } catch (err) {
    out.innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
  }
}

// ---------- save / delete ----------

async function save(el, button) {
  const msg = $('#saveMsg', el);
  const s = store.data.seriesById.get(S.seriesId);
  const box = [];
  for (const side of ['home', 'away']) {
    for (const r of S.rows[side]) {
      if (r.ai || rowIsBlank(r)) continue;
      box.push({ side, tag: r.tag.trim(), ...Object.fromEntries(STAT_KEYS.map(k => [k, num(r.stats[k])])) });
    }
  }
  const body = {
    series_id: s.id, game_number: S.gameNumber, forfeit: S.forfeit,
    home_score: num($('[data-score="home"]', el).value), away_score: num($('[data-score="away"]', el).value),
    box, screenshot_id: S.screenshotId,
  };
  button.disabled = true;
  try {
    await api(S.editingId ? `/api/admin/games/${S.editingId}` : '/api/admin/games', { method: S.editingId ? 'PUT' : 'POST', body });
    const line = `${teamName(s.home_team_id)} ${body.home_score}–${body.away_score} ${teamName(s.away_team_id)}, Game ${S.gameNumber}`;
    await load();
    // Move on to the next game of the series, or the next open matchup that weekend.
    const rec = seriesRecord(store.data.seriesById.get(s.id));
    if (rec.decided) pickSeries(); else S.gameNumber = rec.games.length + 1;
    S.flash = `Saved: ${esc(line)}.`;
    S.warnings = [];
    S.shotUrl = null;
    S.appliedEdit = null;
    if (location.hash === '#game') store.render(); else location.hash = '#game';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    setMsg(msg, err.message, 'error');
    button.disabled = false;
  }
}

async function remove(el) {
  if (!confirm(`Delete Game ${S.gameNumber} and its box score? This can't be undone.`)) return;
  try {
    await api(`/api/admin/games/${S.editingId}`, { method: 'DELETE' });
    S.flash = `Deleted Game ${S.gameNumber}.`;
    await load();
    pickGame();
    store.render();
  } catch (err) {
    setMsg($('#saveMsg', el), err.message, 'error');
  }
}

function recent() {
  const games = [...store.data.games].sort((a, b) => b.id - a.id).slice(0, 10);
  if (!games.length) return '<p class="muted">No games recorded yet.</p>';
  return `<div class="table-wrap"><table class="data-table"><tbody>${games.map(g => {
    const s = store.data.seriesById.get(g.series_id);
    const w = store.data.weekById.get(s.week_id);
    return `<tr><td>${w ? `Weekend ${pad2(w.number)}` : esc(s.label)} · G${g.game_number}</td>
      <td>${esc(teamName(s.home_team_id))} ${g.home_score}–${g.away_score} ${esc(teamName(s.away_team_id))}${g.forfeit ? ' (forfeit)' : ''}</td>
      <td>${g.has_box ? `<a href="#box/${g.id}">Box score</a>` : '<span class="muted">No box score</span>'}</td>
      <td><a href="#game?edit=${g.id}">Edit</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

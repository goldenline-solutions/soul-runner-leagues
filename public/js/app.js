// Router, navigation and the roster editor dialog.
import { store, load, esc, api, $, SLOTS, setMsg, formData, currentWeek, pad2, teamLogo, shrinkLogo } from './core.js';
import * as v from './views.js';
import { scorer } from './scorer.js';
import { desk } from './desk.js';

// [route, page title, view, options]
//   nav:   shorter label for the nav bar
//   under: no nav item of its own; highlights that route's item instead (league switch pages)
//   staff: nav item only shows for the commissioner (the page itself still opens, with a login form)
//   admin: commissioner only
const PAGES = [
  ['overview', 'About', v.overview],
  ['premier', 'Premier Teams', () => v.teams('premier'), { nav: 'Teams' }],
  ['affiliate', 'Affiliate Teams', () => v.teams('affiliate'), { under: 'premier' }],
  ['schedule', 'Premier: Season 1', () => v.schedule('premier'), { nav: 'Schedule' }],
  ['affiliateSchedule', 'Affiliates: Season 1', () => v.schedule('affiliate'), { under: 'schedule' }],
  ['standings', 'Standings', v.standingsView],
  ['stats', 'Player Stats', v.stats],
  ['awards', 'Awards Race', v.awards],
  ['allstar', 'All-Star Game', v.allstar],
  ['playoffs', 'Playoffs', v.playoffs],
  ['news', "Tyreek's Desk: News and Notes", v.news, { nav: "Tyreek's Desk" }],
  ['rules', 'League Rules', v.rules, { nav: 'Rules' }],
  ['sponsors', 'Sponsors', v.sponsors],
  ['players', 'Registration', v.registration],
  ['game', 'Upload Results', scorer, { staff: true }],
  ['desk', "Commissioner's Desk", desk, { admin: true }],
];
const HIDDEN = { box: v.box, player: v.player, team: v.team };
const HIDDEN_UNDER = { box: 'schedule', player: 'stats', team: 'premier' };

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  return { name: name || 'overview', id, query: new URLSearchParams(query) };
}

export async function refresh() {
  await load();
  render();
}
store.refresh = refresh;
store.render = () => render();

function renderNav(active) {
  const admin = store.data.me.admin;
  const current = PAGES.find(p => p[0] === active)?.[3]?.under || HIDDEN_UNDER[active] || active;
  const link = ([id, label, , opt = {}], cls = '') => {
    const on = id === current;
    return `<a href="#${id}" class="${cls}${on ? ' active' : ''}" ${on ? 'aria-current="page"' : ''}>${esc(opt.nav || label)}</a>`;
  };
  const isStaff = p => p[3]?.admin || p[3]?.staff;
  // Commissioner links sit in the top bar on wide screens and at the end of the nav row on phones.
  $('#nav').innerHTML = PAGES.filter(p => !p[3]?.under && !isStaff(p)).map(p => link(p)).join('')
    + (admin ? PAGES.filter(isStaff).map(p => link(p, 'staff-nav')).join('') : '');
  // Same links at the bottom of every page, so nobody has to scroll back up to change pages.
  $('#footerNav').innerHTML = PAGES.filter(p => !p[3]?.under && (!isStaff(p) || admin))
    .map(p => link(p, isStaff(p) ? 'staff-foot' : '')).join('');
  const cw = currentWeek('premier');
  $('#headerMeta').innerHTML = (cw
    ? `<a class="live-chip${cw.live ? ' live' : ''}" href="#schedule"><span class="dot" aria-hidden="true"></span><span class="live-label">${cw.live ? 'This weekend' : 'Up next'} · </span>Weekend ${pad2(cw.week.number)}<span class="live-date"> · ${esc(cw.week.date_label)}</span></a>`
    : '') + (admin ? `<span class="staff-links">${PAGES.filter(isStaff).map(p => link(p, 'staff-link')).join('')}</span>` : '');
  $('#headerMeta').classList.toggle('has-staff', admin);
  if (DESKTOP.matches) $('#nav .active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  $('#footerAuth').innerHTML = admin
    ? '<span class="muted">Commissioner mode</span> · <button class="link-btn" data-logout>Log out</button>'
    : '<a class="muted" href="#game">Commissioner login</a>';
}

function render() {
  const { name, id, query } = parseHash();
  const page = PAGES.find(p => p[0] === name);
  const view = page?.[2] || HIDDEN[name] || v.overview;
  if (page?.[3]?.admin && !store.data.me.admin) {
    location.hash = '#game';
    return;
  }
  renderNav(page || HIDDEN[name] ? name : 'overview');
  const container = document.createElement('div');
  container.className = 'page';
  container.innerHTML = view(id, query);
  $('#view').replaceChildren(container);
  document.title = page && name !== 'overview'
    ? `${page[1]} · Soul Runner NBA 2k27 PC Leagues` : 'Soul Runner Presents: NBA 2k27 PC Leagues';
  const t = name === 'team' && store.data.teamById.get(Number(id));
  if (t) document.title = `${t.name} · Soul Runner NBA 2k27 PC Leagues`;
  view.after?.(container, id, query)?.catch?.(showError(container));
}

const showError = container => err => {
  container.insertAdjacentHTML('afterbegin', `<p class="msg error">${esc(err.message)}</p>`);
};

// ---------- roster editor ----------

function openRosterEditor(teamId) {
  const t = store.data.teamById.get(Number(teamId));
  if (!t) return;
  const roster = store.data.rosterByTeam.get(t.id) || {};
  const dialog = $('#dialog');
  const input = (name, label, value, type = 'text', extra = '') =>
    `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="dialogTitle">${esc(t.name)} · Update Roster</h2><button type="button" class="btn-ghost" data-close>Close</button></div>
    <section class="logo-editor" aria-label="Team logo">
      <div id="logoPreview">${teamLogo(t, 'lg')}</div>
      <div>
        <strong>Team logo / mascot</strong>
        <p class="muted small">PNG, JPG or WebP. It fills the team page banner, so a wide or busy image works well; the middle shows best. Resized to 1200 px. Saves as soon as you pick it.</p>
        <label class="promo-link btn-small file-btn">${t.logo_version > 0 ? 'Replace logo' : 'Upload logo'}<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp"></label>
        ${t.logo_version > 0 ? '<button type="button" class="btn-ghost btn-small" id="logoRemove">Remove</button>' : ''}
        <p class="msg" id="logoMsg" role="status"></p>
      </div>
    </section>
    <form id="rosterForm">
      <div class="registration-grid">
        ${input('owner_coach', 'Owner/Coach', t.owner_coach)}
        ${input('stream_url', 'Twitch.tv Stream', t.stream_url, 'url', 'placeholder="https://twitch.tv/…"')}
        ${input('affiliated_teams', 'Affiliated Team(s)', t.affiliated_teams)}
        ${SLOTS.map(([key, label]) => input(`slot_${key}`, label, roster[key]?.tag || '', 'text', 'placeholder="Discord Tag" list="playerTags"')).join('')}
      </div>
      <datalist id="playerTags">${store.data.players.map(p => `<option value="${esc(p.tag)}">`).join('')}</datalist>
      <p class="muted">Roster player slots use Discord tags. New tags become league players automatically.</p>
      <button>Save roster</button> <button type="button" class="btn-ghost" data-close>Cancel</button>
      <p class="msg" role="status"></p>
    </form>`;
  dialog.showModal();
  const afterLogo = async text => {
    await refresh(); // re-renders the page behind the dialog with the new logo
    openRosterEditor(t.id);
    setMsg($('#logoMsg'), text, 'ok');
  };
  $('#logoFile').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $('#logoMsg');
    setMsg(msg, 'Uploading…');
    try {
      const image = await shrinkLogo(file);
      await api(`/api/admin/teams/${t.id}/logo`, { method: 'PUT', body: { image } });
      await afterLogo('Logo saved.');
    } catch (err) {
      setMsg(msg, err.message || 'That file could not be read as an image.', 'error');
    }
  };
  if ($('#logoRemove')) {
    $('#logoRemove').onclick = async () => {
      try {
        await api(`/api/admin/teams/${t.id}/logo`, { method: 'DELETE' });
        await afterLogo('Logo removed.');
      } catch (err) {
        setMsg($('#logoMsg'), err.message, 'error');
      }
    };
  }
  $('#rosterForm').onsubmit = async e => {
    e.preventDefault();
    const data = formData(e.target);
    const body = { ...data, roster: Object.fromEntries(SLOTS.map(([key]) => [key, data[`slot_${key}`]])) };
    try {
      await api(`/api/admin/teams/${t.id}`, { method: 'PUT', body });
      dialog.close();
      await refresh();
    } catch (err) {
      setMsg($('#rosterForm .msg'), err.message, 'error');
    }
  };
}

// ---------- global events ----------

document.addEventListener('click', async e => {
  const scroll = e.target.closest('[data-scroll]');
  if (scroll) {
    e.preventDefault();
    document.getElementById(scroll.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (e.target.closest('[data-close]')) return $('#dialog').close();
  const edit = e.target.closest('[data-edit-team]');
  if (edit) return openRosterEditor(edit.dataset.editTeam);
  if (e.target.closest('[data-logout]')) {
    await api('/api/logout', { method: 'POST', body: {} });
    location.hash = '#overview';
    await refresh();
  }
});

document.addEventListener('change', e => {
  const filter = e.target.closest('[data-team-filter]');
  if (!filter) return;
  const { name } = parseHash();
  location.hash = filter.value ? `#${name}?team=${filter.value}` : `#${name}`;
});

// ---------- phone menu ----------
// Below 901px the nav becomes a full-screen menu behind the hamburger button.

const DESKTOP = matchMedia('(min-width: 901px)');

function setMenu(open) {
  const header = $('.site-header'), toggle = $('#menuToggle');
  header.classList.toggle('menu-open', open);
  document.body.classList.toggle('menu-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  for (const el of [$('#view'), $('.site-footer')]) el.inert = open; // keep Tab inside the open menu
  if (open) ($('#nav a.active') || $('#nav a'))?.focus({ preventScroll: true });
}
const menuOpen = () => $('.site-header').classList.contains('menu-open');

$('#menuToggle').addEventListener('click', () => setMenu(!menuOpen()));
$('#nav').addEventListener('click', e => { if (e.target.closest('a') && menuOpen()) setMenu(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuOpen()) {
    setMenu(false);
    $('#menuToggle').focus();
  }
});
DESKTOP.addEventListener('change', e => { if (e.matches && menuOpen()) setMenu(false); });

window.addEventListener('hashchange', () => {
  if (!store.data) return; // still loading; the first render picks up the new hash
  render();
  window.scrollTo(0, 0);
});

refresh().catch(err => {
  $('#view').innerHTML = `<div class="panel"><h2>Couldn't load the league</h2><p>${esc(err.message)}</p></div>`;
});

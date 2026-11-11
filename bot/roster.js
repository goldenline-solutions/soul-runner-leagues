// Roster management in Discord. src/roster.js changes the database and says which roles follow,
// and this file applies them: the team's role on a signing, off on a release, the free agent role
// for players with no team, and the Owner / Captain roles for team staff.
//
// Three levels:
//   everyone                 /roster view, /roster freeagents
//   a team's owner, captain  sign (from the free agent pool), release, move (slot only): own team
//   commissioners            everything. A commissioner holds the COMMISSIONER_ROLE_ID role or
//                            has Manage Server.
import { UserError } from '../src/league.js';
import { ROSTER_SLOTS } from '../src/seed.js';
import * as roster from '../src/roster.js';

const EPHEMERAL = 64;
const MANAGE_GUILD = 32n;

const sub = (name, description, options = []) => ({ type: 1, name, description, options });
const TEAM = { type: 3, name: 'team', description: 'Team', required: true, autocomplete: true };
const USER = { type: 6, name: 'user', description: 'Discord member', required: true };
const SLOT = { type: 3, name: 'slot', description: 'Roster slot (default: the first empty one)', choices: ROSTER_SLOTS.map(s => ({ name: s, value: s })) };

export const commands = [{
  contexts: [0], integration_types: [0], type: 1, name: 'roster', description: 'Team rosters and free agents',
  options: [
    sub('view', "Show a team's roster", [TEAM]),
    sub('freeagents', 'Show the free agent pool'),
    sub('sign', 'Sign a member to a team (owners and captains: free agents, own team)', [TEAM, USER, SLOT]),
    sub('release', 'Release a member from their team (owners and captains: own team)', [USER, { ...TEAM, required: false, description: 'Only needed when they are on a team in each league' }]),
    sub('move', 'Change a player\'s slot. Commissioners: also move them to another team in the league', [USER, TEAM, SLOT]),
    sub('staff', 'Commissioners: make a member an owner or captain of a team, or remove them', [TEAM, USER, {
      type: 3, name: 'position', description: 'Their position on the team', required: true,
      choices: [{ name: 'owner', value: 'owner' }, { name: 'captain', value: 'captain' }, { name: 'remove', value: 'remove' }],
    }]),
    sub('freeagent', 'Commissioners: put a member with no team in the free agent pool', [USER]),
    sub('link', 'Commissioners: connect a member to a player record that already exists', [
      USER, { type: 3, name: 'player', description: 'Player record (not linked yet)', required: true, autocomplete: true },
    ]),
    sub('setrole', "Commissioners: set the Discord role a team's players get", [TEAM, { type: 8, name: 'role', description: 'The team role', required: true }]),
    sub('autoroles', 'Commissioners: scan the server roles and match them to teams by name'),
    sub('sync', 'Commissioners: make everyone\'s roles match the rosters, and list problems'),
  ],
}];

const OPEN_TO_ALL = ['view', 'freeagents'];
// Open to a team's owners and captains too; src/roster.js limits them to their own team.
const STAFF_TOO = ['sign', 'release', 'move'];

const isCommissioner = (i, ctx) => i.memberPermissions.has(MANAGE_GUILD)
  || Boolean(ctx.commissionerRoleId && i.member?.roles.cache.has(ctx.commissionerRoleId));
const actor = (i, ctx) => ({ commissioner: isCommissioner(i, ctx), discordId: i.user.id });

// ---------- roles ----------

// Applies what a roster change says about roles. Role problems never undo the roster change:
// they come back as warnings for the commissioner to fix (then /roster sync).
// freeAgent / owner / captain: true adds that server-wide role, false removes it, undefined leaves it.
async function applyRoles(i, ctx, discordId, { add, remove, freeAgent, owner, captain }) {
  const flag = (roleId, on) => (roleId && on !== undefined ? [[on ? 'addRole' : 'removeRole', roleId]] : []);
  const changes = [
    ...add.map(role => ['addRole', role]), ...remove.map(role => ['removeRole', role]),
    ...flag(ctx.freeAgentRoleId, freeAgent), ...flag(ctx.ownerRoleId, owner), ...flag(ctx.captainRoleId, captain),
  ];
  const warnings = [];
  for (const [method, role] of changes) {
    try {
      await i.guild.members[method]({ user: discordId, role, reason: `Roster change by ${i.user.username}` });
    } catch (err) {
      warnings.push(`Could not ${method === 'addRole' ? 'add' : 'remove'} <@&${role}>: ${err.message}`);
    }
  }
  return warnings;
}

// Everyone holding the free agent role in Discord joins the pool, so the role and the pool agree
// however the role was given. Members on a roster are skipped (sync takes the role off them).
// Returns a note for the reply when the role holders could not be read, else ''.
async function adoptRoleHolders(i, ctx) {
  if (!ctx.freeAgentRoleId) return 'No free agent role is set, so only the pool is shown. Run `/roster autoroles`, or set `FREE_AGENT_ROLE_ID`.';
  const holders = [];
  try {
    for (let after; ;) { // the member list comes 1000 at a time
      const page = [...(await i.guild.members.list({ limit: 1000, after })).values()];
      holders.push(...page.filter(m => !m.user.bot && m.roles.cache.has(ctx.freeAgentRoleId)));
      if (page.length < 1000) break;
      after = page.at(-1).user.id;
    }
  } catch (err) {
    return `Could not read who holds <@&${ctx.freeAgentRoleId}> (${err.message}), so only the pool is shown. `
      + 'Turn on **Server Members Intent** for the bot: Discord Developer Portal → your app → Bot → Privileged Gateway Intents.';
  }
  const inPool = new Set((await roster.freeAgents(ctx.db)).map(p => p.discord_id));
  for (const m of holders.filter(h => !inPool.has(h.user.id))) {
    await roster.addFreeAgent(ctx.db, { member: { id: m.user.id, name: m.user.username }, by: i.user.id })
      .catch(err => { if (!(err instanceof UserError)) throw err; }); // on a roster, or their name belongs to another record
  }
  return '';
}

const withWarnings = (text, warnings) => (warnings.length
  ? `${text}\n⚠️ ${warnings.join('\n⚠️ ')}\nCheck that the bot has Manage Roles and that its role is above these roles, then run \`/roster sync\`.`
  : text);

// ---------- commands ----------

const quiet = (i, content) => i.reply({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } });
const loud = (i, content) => i.reply({ content, allowedMentions: { parse: [] } });
const teamId = i => Number(i.options.getString('team')) || null; // autocomplete sends the team id
const member = i => {
  const u = i.options.getUser('user');
  return { id: u.id, name: u.username };
};
const who = p => (p.discord_id ? `<@${p.discord_id}>` : p.tag);

const ACTIONS = {
  view: async (i, { db }) => {
    const { team, staff, slots } = await roster.teamRoster(db, teamId(i));
    const people = role => staff.filter(st => st.role === role).map(st => `<@${st.discord_id}>`).join(' ') || '-';
    await quiet(i, `**${team.name}** (${team.league})${team.discord_role_id ? ` · <@&${team.discord_role_id}>` : ''}\n`
      + `Owner: ${people('owner')} · Captain: ${people('captain')}\n`
      + slots.map(s => `\`${s.slot.padEnd(3)}\` ${s.player_id ? `${s.tag}${s.discord_id ? ` <@${s.discord_id}>` : ' (not linked)'}` : '-'}`).join('\n'));
  },
  staff: async (i, ctx) => {
    const m = member(i);
    const position = i.options.getString('position');
    const r = await roster.setStaff(ctx.db, { teamId: teamId(i), member: m, role: position === 'remove' ? null : position });
    const text = r.role ? `<@${m.id}> is now ${r.role === 'owner' ? 'an owner' : 'a captain'} of **${r.team.name}**.` : `<@${m.id}> is no longer an owner or captain of **${r.team.name}**.`;
    await loud(i, withWarnings(text, await applyRoles(i, ctx, m.id, r.roles)));
  },
  freeagents: async (i, ctx) => {
    await i.deferReply({ flags: EPHEMERAL });
    const note = await adoptRoleHolders(i, ctx);
    const list = await roster.freeAgents(ctx.db);
    const body = list.length
      ? `**Free agents (${list.length})**\n${list.slice(0, 40).map(p => `• ${who(p)}`).join('\n')}${list.length > 40 ? `\n…and ${list.length - 40} more` : ''}`
      : 'There are no free agents.';
    await i.editReply({ content: `${body}${note ? `\n\n${note}` : ''}`.slice(0, 1900), allowedMentions: { parse: [] } });
  },
  sign: async (i, ctx) => {
    // Holding the free agent role counts as being a free agent, even if nobody ran /roster freeagent.
    const holdsRole = Boolean(ctx.freeAgentRoleId && i.options.getMember('user')?.roles.cache.has(ctx.freeAgentRoleId));
    const m = { ...member(i), freeAgentRole: holdsRole };
    const r = await roster.sign(ctx.db, { teamId: teamId(i), member: m, slot: i.options.getString('slot'), by: i.user.id, actor: actor(i, ctx) });
    await loud(i, withWarnings(`✅ <@${m.id}> signed with **${r.team.name}** (${r.slot}).`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  release: async (i, ctx) => {
    const m = member(i);
    const r = await roster.release(ctx.db, { member: m, teamId: teamId(i), by: i.user.id, actor: actor(i, ctx) });
    await loud(i, withWarnings(`<@${m.id}> was released by **${r.team.name}**${r.freeAgent ? ' and is now a free agent' : ''}.`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  move: async (i, ctx) => {
    const m = member(i);
    const r = await roster.move(ctx.db, { member: m, teamId: teamId(i), slot: i.options.getString('slot'), by: i.user.id, actor: actor(i, ctx) });
    const text = r.from.id === r.team.id
      ? `<@${m.id}> moved from ${r.from.slot} to ${r.slot} on **${r.team.name}**.`
      : `🔁 <@${m.id}> moved from **${r.from.name}** to **${r.team.name}** (${r.slot}).`;
    await loud(i, withWarnings(text, await applyRoles(i, ctx, m.id, r.roles)));
  },
  freeagent: async (i, ctx) => {
    const m = member(i);
    const r = await roster.addFreeAgent(ctx.db, { member: m, by: i.user.id });
    await loud(i, withWarnings(`<@${m.id}> is now a free agent.`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  link: async (i, ctx) => {
    const m = member(i);
    const r = await roster.link(ctx.db, { member: m, playerId: Number(i.options.getString('player')) });
    const teams = r.spots.map(s => s.team).join(' and ');
    await quiet(i, withWarnings(`<@${m.id}> is linked to the player record **${r.player.discord_tag}**${teams ? ` (on ${teams})` : ''}.`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  // Reads every role in the server and fills in team roles and the server-wide roles by name.
  autoroles: async (i, ctx) => {
    await i.deferReply({ flags: EPHEMERAL });
    const all = [...(await i.guild.roles.fetch()).values()]
      .filter(r => !r.managed && r.id !== i.guild.id) // not other bots' roles, not @everyone
      .map(r => ({ id: r.id, name: r.name }));
    const have = Object.fromEntries(Object.keys(roster.SPECIAL_ROLES).map(key => [key, ctx[`${key}RoleId`]]));
    const r = await roster.autoAssignRoles(ctx.db, all, have);
    const label = { commissioner: 'Commissioner', freeAgent: 'Free agent', owner: 'Owner', captain: 'Captain' };
    const options = roles => roles.slice(0, 5).map(x => `<@&${x.id}>`).join(', ');
    const lines = [
      `Scanned ${all.length} roles. ${r.matched.length} team roles set now, ${r.alreadySet} were already set.`,
      ...r.matched.map(m => `✅ **${m.team.name}** → <@&${m.role.id}>`),
      ...r.special.set.map(x => `✅ ${label[x.key]} role → <@&${x.role.id}>`),
      ...(r.unsure.length || r.special.unsure.length ? ['**More than one possible role; set these yourself:**'] : []),
      ...r.unsure.map(u => `• **${u.team.name}**: ${options(u.roles)} (use \`/roster setrole\`)`),
      ...r.special.unsure.map(u => `• ${label[u.key]} role: ${options(u.roles)} (set it in .env)`),
      ...(r.none.length ? [`**No role found for:** ${r.none.map(team => team.name).join(', ')} (use \`/roster setrole\`)`] : []),
      ...(r.special.none.length ? [`**No role found for:** ${r.special.none.map(key => label[key].toLowerCase()).join(', ')} (optional; create the role and run this again)`] : []),
      'Run `/roster sync` to give the roles to current rosters.',
    ];
    await i.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
  },
  setrole: async (i, { db }) => {
    const role = i.options.getRole('role');
    const team = await roster.setTeamRole(db, teamId(i), role.id);
    await quiet(i, `**${team.name}** players now get <@&${role.id}>. Run \`/roster sync\` to give it to the current roster.`);
  },
  sync: async (i, ctx) => {
    await i.deferReply({ flags: EPHEMERAL });
    const note = await adoptRoleHolders(i, ctx);
    const { teamRoleIds, members, problems } = await roster.audit(ctx.db);
    if (note && ctx.freeAgentRoleId) problems.push(note);
    // The server-wide roles this bot hands out, next to the team roles.
    const flags = [['freeAgent', ctx.freeAgentRoleId], ['owner', ctx.ownerRoleId], ['captain', ctx.captainRoleId]].filter(([, role]) => role);
    const managed = [...teamRoleIds, ...flags.map(([, role]) => role)];
    let fixed = 0, adopted = 0;
    for (const p of members) {
      const guildMember = await i.guild.members.fetch(p.discord_id).catch(() => null);
      if (!guildMember) {
        if (p.roleIds.length) problems.push(`${p.tag} is on a roster but is not in the server.`);
        continue;
      }
      // Someone given the free agent role by hand joins the pool, instead of losing the role.
      // (Refused when they are on a roster: then the role is simply removed below.)
      if (ctx.freeAgentRoleId && !p.freeAgent && guildMember.roles.cache.has(ctx.freeAgentRoleId)) {
        p.freeAgent = await roster.addFreeAgent(ctx.db, { member: { id: p.discord_id, name: p.tag }, by: i.user.id })
          .then(() => true, err => { if (err instanceof UserError) return false; throw err; });
        if (p.freeAgent) adopted++;
      }
      // Of the roles this bot manages, the member should hold exactly these.
      const should = new Set([...p.roleIds, ...flags.filter(([key]) => p[key]).map(([, role]) => role)]);
      const add = managed.filter(r => should.has(r) && !guildMember.roles.cache.has(r));
      const remove = managed.filter(r => !should.has(r) && guildMember.roles.cache.has(r));
      if (!add.length && !remove.length) continue;
      const warnings = await applyRoles(i, {}, p.discord_id, { add, remove });
      if (warnings.length) problems.push(`${p.tag}: ${warnings[0]}`);
      else fixed++;
    }
    const lines = [`Checked ${members.length} members. Roles fixed for ${fixed}.${adopted ? ` Added ${adopted} to the free agent pool because they hold the free agent role.` : ''}`,
      ...(problems.length ? ['**To fix by hand:**', ...problems.slice(0, 15).map(x => `• ${x}`)] : ['No problems found.']),
      ...(problems.length > 15 ? [`…and ${problems.length - 15} more`] : [])];
    await i.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
  },
};

// Team and player-record choices as someone types.
async function choices(db, { name, value }) {
  if (name === 'team') {
    const teams = await db.all(`SELECT t.id, t.name, l.name AS league FROM teams t JOIN leagues l ON l.id = t.league_id
      WHERE t.name ILIKE ? ORDER BY t.name LIMIT 25`, `%${value}%`);
    return teams.map(t => ({ name: `${t.name} (${t.league})`.slice(0, 100), value: String(t.id) }));
  }
  const players = await db.all(`SELECT id, discord_tag FROM players WHERE discord_id IS NULL AND discord_tag ILIKE ?
    ORDER BY lower(discord_tag) LIMIT 25`, `%${value}%`);
  return players.map(p => ({ name: p.discord_tag.slice(0, 100), value: String(p.id) }));
}

// The server-wide role ids: .env first, then what /roster autoroles found and saved.
async function withRoles(base) {
  const saved = await roster.savedRoles(base.db);
  const ctx = { ...base };
  for (const key of Object.keys(roster.SPECIAL_ROLES)) ctx[`${key}RoleId`] = base[`${key}RoleId`] || saved[key] || '';
  return ctx;
}

export async function handle(interaction, base) {
  if (interaction.isAutocomplete()) return interaction.respond(await choices(base.db, interaction.options.getFocused(true)));
  try {
    const ctx = await withRoles(base);
    const key = interaction.options.getSubcommand();
    if (!OPEN_TO_ALL.includes(key) && !STAFF_TOO.includes(key) && !isCommissioner(interaction, ctx)) {
      throw new UserError('Only a commissioner can do that.', 403);
    }
    await ACTIONS[key](interaction, ctx);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    const content = err instanceof UserError ? err.message : 'Something went wrong. Try again.';
    await (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: EPHEMERAL }));
  }
}

export default { commands, names: ['roster'], handle };

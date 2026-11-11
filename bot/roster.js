// Roster management in Discord. Commissioners (Manage Server) sign, release and move players;
// src/roster.js changes the database and says which roles follow, and this file applies them:
// the team's role on a signing, off on a release, and the free agent role for players with no team.
// /roster view and /roster freeagents are open to everyone.
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
    sub('sign', 'Commissioners: sign a member to a team', [TEAM, USER, SLOT]),
    sub('release', 'Commissioners: release a member from their team', [USER, { ...TEAM, required: false, description: 'Only needed when they are on a team in each league' }]),
    sub('move', 'Commissioners: move a member to another team in the same league, or to another slot', [USER, TEAM, SLOT]),
    sub('freeagent', 'Commissioners: put a member with no team in the free agent pool', [USER]),
    sub('link', 'Commissioners: connect a member to a player record that already exists', [
      USER, { type: 3, name: 'player', description: 'Player record (not linked yet)', required: true, autocomplete: true },
    ]),
    sub('setrole', "Commissioners: set the Discord role a team's players get", [TEAM, { type: 8, name: 'role', description: 'The team role', required: true }]),
    sub('sync', 'Commissioners: make everyone\'s roles match the rosters, and list problems'),
  ],
}];

const OPEN_TO_ALL = ['view', 'freeagents'];

// ---------- roles ----------

// Applies what a roster change says about roles. Role problems never undo the roster change:
// they come back as warnings for the commissioner to fix (then /roster sync).
async function applyRoles(i, ctx, discordId, { add, remove, freeAgent }) {
  const free = ctx.freeAgentRoleId;
  const changes = [
    ...add.map(role => ['addRole', role]), ...remove.map(role => ['removeRole', role]),
    ...(free ? [[freeAgent ? 'addRole' : 'removeRole', free]] : []),
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
    const { team, slots } = await roster.teamRoster(db, teamId(i));
    await quiet(i, `**${team.name}** (${team.league})${team.discord_role_id ? ` · <@&${team.discord_role_id}>` : ''}\n`
      + slots.map(s => `\`${s.slot.padEnd(3)}\` ${s.player_id ? `${s.tag}${s.discord_id ? ` <@${s.discord_id}>` : ' (not linked)'}` : '-'}`).join('\n'));
  },
  freeagents: async (i, { db }) => {
    const list = await roster.freeAgents(db);
    await quiet(i, list.length
      ? `**Free agents (${list.length})**\n${list.slice(0, 40).map(p => `• ${who(p)}`).join('\n')}${list.length > 40 ? `\n…and ${list.length - 40} more` : ''}`
      : 'There are no free agents.');
  },
  sign: async (i, ctx) => {
    const m = member(i);
    const r = await roster.sign(ctx.db, { teamId: teamId(i), member: m, slot: i.options.getString('slot'), by: i.user.id });
    await loud(i, withWarnings(`✅ <@${m.id}> signed with **${r.team.name}** (${r.slot}).`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  release: async (i, ctx) => {
    const m = member(i);
    const r = await roster.release(ctx.db, { member: m, teamId: teamId(i), by: i.user.id });
    await loud(i, withWarnings(`<@${m.id}> was released by **${r.team.name}**${r.freeAgent ? ' and is now a free agent' : ''}.`, await applyRoles(i, ctx, m.id, r.roles)));
  },
  move: async (i, ctx) => {
    const m = member(i);
    const r = await roster.move(ctx.db, { member: m, teamId: teamId(i), slot: i.options.getString('slot'), by: i.user.id });
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
  setrole: async (i, { db }) => {
    const role = i.options.getRole('role');
    const team = await roster.setTeamRole(db, teamId(i), role.id);
    await quiet(i, `**${team.name}** players now get <@&${role.id}>. Run \`/roster sync\` to give it to the current roster.`);
  },
  sync: async (i, ctx) => {
    await i.deferReply({ flags: EPHEMERAL });
    const { teamRoleIds, players, problems } = await roster.audit(ctx.db);
    const managed = [...teamRoleIds, ...(ctx.freeAgentRoleId ? [ctx.freeAgentRoleId] : [])];
    let fixed = 0;
    for (const p of players) {
      const guildMember = await i.guild.members.fetch(p.discord_id).catch(() => null);
      if (!guildMember) {
        if (p.roleIds.length) problems.push(`${p.tag} is on a roster but is not in the server.`);
        continue;
      }
      // Of the roles this bot manages, the member should hold exactly these.
      const should = new Set([...p.roleIds, ...(p.freeAgent && ctx.freeAgentRoleId ? [ctx.freeAgentRoleId] : [])]);
      const add = managed.filter(r => should.has(r) && !guildMember.roles.cache.has(r));
      const remove = managed.filter(r => !should.has(r) && guildMember.roles.cache.has(r));
      if (!add.length && !remove.length) continue;
      const warnings = await applyRoles(i, { freeAgentRoleId: '' }, p.discord_id, { add, remove, freeAgent: false });
      if (warnings.length) problems.push(`${p.tag}: ${warnings[0]}`);
      else fixed++;
    }
    const lines = [`Checked ${players.length} linked players. Roles fixed for ${fixed}.`,
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

export async function handle(interaction, ctx) {
  if (interaction.isAutocomplete()) return interaction.respond(await choices(ctx.db, interaction.options.getFocused(true)));
  try {
    const key = interaction.options.getSubcommand();
    if (!OPEN_TO_ALL.includes(key) && !interaction.memberPermissions.has(MANAGE_GUILD)) {
      throw new UserError('Only a commissioner (Manage Server) can change rosters.', 403);
    }
    await ACTIONS[key](interaction, ctx);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    const content = err instanceof UserError ? err.message : 'Something went wrong. Try again.';
    await (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: EPHEMERAL }));
  }
}

export default { commands, names: ['roster'], handle };

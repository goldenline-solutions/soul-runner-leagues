// Team scrim queue in Discord. Every command, button and modal calls src/scrim.js (the same
// functions the site's API calls), then sync() brings Discord in line with the database:
//   - runs the matcher
//   - opens a private thread for each new match and posts each status change in it
//   - archives threads 24 hours after the result is confirmed
//   - edits the pinned live queue message in the queue channel
// sync() also runs every 30 seconds, which is how joins made on the site reach Discord.
import { UserError } from '../src/league.js';
import * as scrim from '../src/scrim.js';
import { attachmentToDataUrl } from './boxscore.js';

const TICK_MS = 30_000;
const EPHEMERAL = 64;
const MANAGE_GUILD = 32n;
const PRIVATE_THREAD = 12;
const GUILD_ONLY = { contexts: [0], integration_types: [0] };
const PREFIX = 'scrim:';

const sub = (name, description, options = []) => ({ type: 1, name, description, options });
const TEAM = { type: 3, name: 'team', description: 'Team', required: true, autocomplete: true };
const USER = { type: 6, name: 'user', description: 'Discord member', required: true };

export const commands = [
  {
    ...GUILD_ONLY, type: 1, name: 'queue', description: 'Team scrim queue',
    options: [
      sub('join', 'Put your team in the queue (captains only)', [
        { type: 3, name: 'mode', description: 'scrim is unrated (default), ranked counts', choices: scrim.MODES.map(m => ({ name: m, value: m })) },
        { type: 4, name: 'size', description: 'Players per side (default 5)', min_value: 1, max_value: 5 },
        { type: 4, name: 'minutes_available', description: 'How long you can wait (default 60)', min_value: 5, max_value: 720 },
        { type: 4, name: 'skill_min', description: 'Only meet teams rated at least this', min_value: 0, max_value: 5000 },
        { type: 4, name: 'skill_max', description: 'Only meet teams rated at most this', min_value: 0, max_value: 5000 },
      ]),
      sub('leave', 'Take your team out of the queue'),
      sub('status', "Your team's queue entry or match"),
      sub('list', 'Who is waiting right now'),
    ],
  },
  {
    ...GUILD_ONLY, type: 1, name: 'match', description: 'Your current scrim match',
    options: [
      sub('accept', 'Accept the match you were paired into'),
      sub('decline', 'Decline the match you were paired into'),
      sub('host', 'Record who hosts the lobby', [{
        type: 3, name: 'team', description: 'Who hosts', required: true,
        choices: [{ name: 'My team', value: 'mine' }, { name: 'The other team', value: 'theirs' }],
      }]),
      sub('report', 'Report the final score with a screenshot', [
        { type: 4, name: 'score_a', description: 'Score of the first team on the match card', required: true, min_value: 0, max_value: 400 },
        { type: 4, name: 'score_b', description: 'Score of the second team on the match card', required: true, min_value: 0, max_value: 400 },
        { type: 11, name: 'screenshot', description: 'The final score screenshot', required: true },
      ]),
      sub('confirm', 'Confirm the result the other team reported'),
      sub('dispute', 'Dispute this match and call a commissioner'),
    ],
  },
  {
    ...GUILD_ONLY, type: 1, name: 'team', description: 'Scrim team captains and members', default_member_permissions: String(MANAGE_GUILD),
    options: [
      sub('captain', 'Make someone a captain of a team', [TEAM, USER]),
      sub('add', 'Add a player or sub to a team', [TEAM, USER, {
        type: 3, name: 'role', description: 'player (default) or sub', choices: [{ name: 'player', value: 'player' }, { name: 'sub', value: 'sub' }],
      }]),
      sub('remove', 'Take someone off their team', [USER]),
      sub('disband', "Remove everyone from a team and cancel its queue entry or match", [TEAM]),
      sub('testopponent', 'Testing: queue a fake opponent that never answers', [
        { type: 3, name: 'mode', description: 'scrim (default) or ranked', choices: scrim.MODES.map(m => ({ name: m, value: m })) },
        { type: 4, name: 'size', description: 'Players per side (default 5)', min_value: 1, max_value: 5 },
      ]),
    ],
  },
];

// ---------- what the bot says ----------

const unix = d => Math.floor(new Date(d).getTime() / 1000);
const label = m => `${m.mode} ${m.team_size}v${m.team_size}`;
const button = (id, text, style) => ({ type: 2, custom_id: PREFIX + id, label: text, style }); // 1 blue, 2 grey, 3 green, 4 red
const row = (...components) => ({ type: 1, components });
const mentions = (members, pick = () => true) => members.filter(pick).map(u => `<@${u.discord_id}>`).join(' ');
const isCaptain = u => u.role === 'captain';

// The pinned live queue message. Waiting times are Discord timestamps, so they count up on their own.
export function queuePayload(entries) {
  const lines = entries.map((e, i) => `${i + 1}. **${e.team}** · ${label(e)} · waiting since <t:${unix(e.created_at)}:R>`);
  return {
    embeds: [{
      title: 'Scrim queue',
      description: lines.join('\n') || 'Nobody is waiting. Be the first.',
      footer: { text: 'Captains: press Join Queue, or use /queue join' },
    }],
    components: [row(button('join', 'Join Queue', 1), button('leave', 'Leave Queue', 2))],
  };
}

// One thread message per match status. `members` is scrim.matchMembers().
export function matchPayload(m, members, { adminRoleId = '', siteUrl = '' } = {}) {
  const captains = mentions(members, isCaptain);
  const ping = { users: members.filter(isCaptain).map(u => u.discord_id) };
  const score = `**${m.team_a}** ${m.team_a_score} – ${m.team_b_score} **${m.team_b}**`;
  switch (m.status) {
    case 'pending_accept': return {
      content: `${captains}\nMatch found. Both captains: accept within ${scrim.ACCEPT_MINUTES} minutes.`,
      embeds: [{
        title: `${m.team_a} vs ${m.team_b}`,
        fields: [
          { name: 'Team A', value: m.team_a, inline: true },
          { name: 'Team B', value: m.team_b, inline: true },
          { name: 'Format', value: label(m), inline: true },
        ],
      }],
      components: [row(button('accept', 'Accept', 3), button('decline', 'Decline', 4))],
      allowedMentions: ping,
    };
    case 'accepted': return {
      content: [
        'Both teams accepted. From here it is on you:',
        '1. Decide who hosts the lobby, then record it with `/match host`.',
        '2. Swap gamertags in this thread and set up the game.',
        `3. When it is over, one captain runs \`/match report\` with the score and a screenshot. \`score_a\` is ${m.team_a}, \`score_b\` is ${m.team_b}.`,
        '4. The other captain confirms it.',
      ].join('\n'),
    };
    case 'in_progress': return {
      content: `**${m.host_team_id === m.team_a_id ? m.team_a : m.team_b}** hosts. Report the result here with \`/match report\` when you are done.`,
    };
    case 'awaiting_result': return {
      content: `${captains}\nResult reported: ${score}. The other team's captain confirms or disputes it.`,
      embeds: siteUrl && m.screenshot_id ? [{ image: { url: `${siteUrl.replace(/\/$/, '')}/api/screenshots/${m.screenshot_id}` } }] : [],
      components: [row(button(`confirm:${m.id}`, 'Confirm result', 3), button('dispute', 'Dispute', 4))],
      allowedMentions: ping,
    };
    case 'completed': return { content: `Final: ${score}. Confirmed. This thread is archived in 24 hours.` };
    case 'disputed': return {
      content: `${adminRoleId ? `<@&${adminRoleId}> ` : ''}This match is disputed. A commissioner will sort it out here.`,
      allowedMentions: { roles: adminRoleId ? [adminRoleId] : [] },
    };
    default: return { // cancelled
      content: `Match cancelled: ${m.cancel_reason}. A team that did its part is back in the queue; the other is out and can rejoin.`,
    };
  }
}

function statusText({ team, entry, match }) {
  if (!team) return "You're not on a team yet. Ask a commissioner to add you.";
  if (match) {
    const where = match.discord_thread_id ? ` Thread: <#${match.discord_thread_id}>` : '';
    return `**${team.name}**: match ${match.team_a} vs ${match.team_b} (${label(match)}), status \`${match.status}\`.${where}`;
  }
  if (entry) return `**${team.name}** is in the queue for ${label(entry)} since <t:${unix(entry.created_at)}:R>, until <t:${unix(entry.available_until)}:t>.`;
  return `**${team.name}** is not in the queue.`;
}

const joinedText = ({ team, entry, match }) => (match
  ? `**${team.name}** is matched: ${match.team_a} vs ${match.team_b}. A private thread opens in a moment.`
  : `**${team.name}** is in the queue for ${label(entry)} until <t:${unix(entry.available_until)}:t>.`);

// ---------- commands, buttons, the modal ----------

const quiet = (i, content) => i.reply({ content, flags: EPHEMERAL });
const loud = (i, content) => i.reply({ content, allowedMentions: { parse: [] } });
const teamId = i => Number(i.options.getString('team')); // autocomplete sends the team id

async function memberFromOption(i, db) {
  const target = i.options.getUser('user');
  return { target, user: await scrim.upsertUser(db, { discordId: target.id, name: target.username }) };
}

const ACTIONS = {
  'queue join': async (i, { db }, user) => quiet(i, joinedText(await scrim.joinQueue(db, user.id, {
    mode: i.options.getString('mode'), team_size: i.options.getInteger('size'), minutes: i.options.getInteger('minutes_available'),
    skill_min: i.options.getInteger('skill_min'), skill_max: i.options.getInteger('skill_max'),
  }))),
  'queue leave': async (i, { db }, user) => quiet(i, `**${(await scrim.leaveQueue(db, user.id)).team.name}** left the queue.`),
  'queue status': async (i, { db }, user) => quiet(i, statusText(await scrim.queueStatus(db, user.id))),
  'queue list': async (i, { db }) => i.reply({ embeds: queuePayload(await scrim.listQueue(db)).embeds, flags: EPHEMERAL }),

  // The Join Queue button opens a form, so nobody has to remember the command options.
  join: i => i.showModal({
    custom_id: `${PREFIX}joinform`, title: 'Join the scrim queue',
    components: [
      row({ type: 4, custom_id: 'mode', label: 'Mode: scrim or ranked', style: 1, value: 'scrim', required: true }),
      row({ type: 4, custom_id: 'size', label: 'Players per side (1 to 5)', style: 1, value: '5', required: true }),
      row({ type: 4, custom_id: 'minutes', label: 'Minutes you can wait', style: 1, value: '60', required: true }),
    ],
  }),
  joinform: async (i, { db }, user) => quiet(i, joinedText(await scrim.joinQueue(db, user.id, {
    mode: i.fields.getTextInputValue('mode').trim().toLowerCase(),
    team_size: i.fields.getTextInputValue('size').trim(), minutes: i.fields.getTextInputValue('minutes').trim(),
  }))),
  leave: (i, ctx, user) => ACTIONS['queue leave'](i, ctx, user),

  'match accept': async (i, { db }, user) => {
    const { team, match } = await scrim.respondToMatch(db, user.id, true);
    await loud(i, `**${team.name}** accepted.${match.status === 'accepted' ? '' : ' Waiting on the other captain.'}`);
  },
  'match decline': async (i, { db }, user) => loud(i, `**${(await scrim.respondToMatch(db, user.id, false)).team.name}** declined.`),
  accept: (i, ctx, user) => ACTIONS['match accept'](i, ctx, user),
  decline: (i, ctx, user) => ACTIONS['match decline'](i, ctx, user),

  'match host': async (i, { db }, user) => {
    await scrim.setHost(db, user.id, i.options.getString('team'));
    await quiet(i, 'Host recorded.');
  },
  'match report': async (i, { db, ingest, fetchImpl }, user) => {
    await i.deferReply(); // downloading and checking the screenshot can take a while
    const image = await attachmentToDataUrl(i.options.getAttachment('screenshot'), fetchImpl);
    const { team, warning } = await scrim.reportResult(db, ingest, user.id, {
      score_a: i.options.getInteger('score_a'), score_b: i.options.getInteger('score_b'), image,
    });
    await i.editReply({ content: `**${team.name}** reported the result.${warning ? `\n⚠️ ${warning}` : ''}`, allowedMentions: { parse: [] } });
  },
  'match confirm': async (i, { db }, user, matchId) => {
    // A commissioner can press Confirm on any result card; captains confirm their own match.
    const admin = Boolean(matchId) && i.memberPermissions.has(MANAGE_GUILD) && (await scrim.memberTeam(db, user.id))?.role !== 'captain';
    await scrim.confirmResult(db, user.id, { admin, matchId: Number(matchId) });
    await loud(i, `Result confirmed by <@${i.user.id}>.`);
  },
  confirm: (i, ctx, user, matchId) => ACTIONS['match confirm'](i, ctx, user, matchId),
  'match dispute': async (i, { db }, user) => loud(i, `**${(await scrim.disputeMatch(db, user.id)).team.name}** disputed this match.`),
  dispute: (i, ctx, user) => ACTIONS['match dispute'](i, ctx, user),

  'team captain': async (i, { db }) => {
    const { target, user } = await memberFromOption(i, db);
    await scrim.setMember(db, teamId(i), user.id, 'captain');
    await quiet(i, `<@${target.id}> is now a captain.`);
  },
  'team add': async (i, { db }) => {
    const { target, user } = await memberFromOption(i, db);
    await scrim.setMember(db, teamId(i), user.id, i.options.getString('role') || 'player');
    await quiet(i, `<@${target.id}> is on the team.`);
  },
  'team remove': async (i, { db }) => {
    const { target, user } = await memberFromOption(i, db);
    await scrim.removeMember(db, user.id);
    await quiet(i, `<@${target.id}> is off their team.`);
  },
  'team testopponent': async (i, { db }) => {
    const { team, entry, match } = await scrim.queueFakeOpponent(db, { mode: i.options.getString('mode'), team_size: i.options.getInteger('size') });
    await quiet(i, `Fake opponent **${team.name}** ${match ? 'is matched: the thread opens in a moment' : `is in the queue for ${label(entry)}: now join with the same mode and size`}. `
      + `It never accepts, so the match cancels after ${scrim.ACCEPT_MINUTES} minutes. Clean up with \`/team disband\` on ${team.name}.`);
  },
  'team disband': async (i, { db }) => {
    await scrim.disbandTeam(db, teamId(i));
    await quiet(i, 'Team disbanded: no members, and its queue entry or match is cancelled.');
  },
};

async function teamChoices(db, typed) {
  const teams = await db.all(`SELECT t.id, t.name, l.name AS league FROM teams t JOIN leagues l ON l.id = t.league_id
    WHERE t.name ILIKE ? ORDER BY t.name LIMIT 25`, `%${typed}%`);
  return teams.map(t => ({ name: `${t.name} (${t.league})`.slice(0, 100), value: String(t.id) }));
}

export async function handle(interaction, ctx) {
  if (interaction.isAutocomplete()) return interaction.respond(await teamChoices(ctx.db, interaction.options.getFocused()));
  try {
    const user = await scrim.upsertUser(ctx.db, { discordId: interaction.user.id, name: interaction.user.username });
    const [key, arg] = interaction.isChatInputCommand()
      ? [`${interaction.commandName} ${interaction.options.getSubcommand()}`]
      : interaction.customId.slice(PREFIX.length).split(':');
    await ACTIONS[key](interaction, ctx, user, arg);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    const content = err instanceof UserError ? err.message : 'Something went wrong. Try again.';
    await (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: EPHEMERAL }));
  }
  await sync(interaction.client, ctx);
}

// ---------- keeping Discord in line with the database ----------

// Runs are chained, so a button press and the timer never work on the same match at once.
export function sync(client, ctx) {
  ctx.scrimSync = (ctx.scrimSync ?? Promise.resolve()).then(() => tick(client, ctx)).catch(err => console.error(err));
  return ctx.scrimSync;
}

async function tick(client, ctx) {
  const { db } = ctx;
  await scrim.runMatcher(db);
  if (!ctx.queueChannelId) return; // no channel configured: the queue still works, without threads or the live message

  for (const m of await scrim.matchesToAnnounce(db)) {
    try {
      await announce(client, ctx, m);
    } catch (err) {
      console.error(`Match ${m.id}: could not post "${m.status}" in Discord. Trying again on the next tick.`, err);
    }
  }
  for (const m of await scrim.threadsToArchive(db)) {
    const thread = await client.channels.fetch(m.discord_thread_id).catch(() => null);
    await thread?.setArchived(true);
    await scrim.markArchived(db, m.id);
  }
  await refreshQueueMessage(client, ctx);
}

async function announce(client, ctx, m) {
  const { db } = ctx;
  const members = await scrim.matchMembers(db, m);
  let thread = m.discord_thread_id ? await client.channels.fetch(m.discord_thread_id).catch(() => null) : null;
  if (!m.discord_thread_id && m.status === 'pending_accept') {
    const channel = await client.channels.fetch(ctx.queueChannelId);
    thread = await channel.threads.create({
      name: `${m.team_a} vs ${m.team_b}`.slice(0, 100), type: PRIVATE_THREAD, invitable: false, autoArchiveDuration: 1440,
    });
    await scrim.setThread(db, m.id, thread.id);
    for (const u of members) {
      // Someone who left the server can't be added; the rest of the team still gets in.
      await thread.members.add(u.discord_id).catch(err => console.error(`Could not add ${u.discord_id} to the match thread: ${err.message}`));
    }
  }
  if (thread) {
    await thread.send(matchPayload(m, members, ctx));
    if (m.status === 'cancelled') await thread.setArchived(true);
  }
  await scrim.markAnnounced(db, m.id, m.status);
}

const QUEUE_MESSAGE = 'scrim_queue_message';

// One pinned message in the queue channel, edited only when the queue actually changed.
async function refreshQueueMessage(client, ctx) {
  const { db } = ctx;
  const payload = queuePayload(await scrim.listQueue(db));
  const json = JSON.stringify(payload);
  if (json === ctx.scrimQueueShown) return;
  const channel = await client.channels.fetch(ctx.queueChannelId);
  const saved = await db.get('SELECT value FROM settings WHERE key = ?', QUEUE_MESSAGE);
  const edited = saved && await channel.messages.edit(JSON.parse(saved.value), payload).catch(() => null);
  if (!edited) { // first run, or someone deleted the message
    const message = await channel.send(payload);
    await message.pin();
    await db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, QUEUE_MESSAGE, JSON.stringify(message.id));
  }
  ctx.scrimQueueShown = json;
}

export function start(client, ctx) {
  if (!ctx.queueChannelId) console.warn('SCRIM_QUEUE_CHANNEL_ID is not set: the queue works, but there are no match threads and no live queue message.');
  sync(client, ctx);
  setInterval(() => sync(client, ctx), TICK_MS);
}

export default { commands, names: ['queue', 'match', 'team'], prefix: PREFIX, handle, start };

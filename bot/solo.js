// Solo queue in Discord. Players queue alone; their positions are the PG / SG / LOCK / BACKEND / C
// roles they hold in the server. Every command and button calls src/solo.js, then sync() brings
// Discord in line with the database, the same way bot/scrim.js does for the team queue:
// the matcher, a private thread per match, and the pinned live queue message.
import { UserError } from '../src/league.js';
import { upsertUser } from '../src/scrim.js';
import * as solo from '../src/solo.js';
import { attachmentToDataUrl } from './boxscore.js';

const TICK_MS = 30_000;
const EPHEMERAL = 64;
const MANAGE_GUILD = 32n;
const PRIVATE_THREAD = 12;
const PREFIX = 'solo:';

const sub = (name, description, options = []) => ({ type: 1, name, description, options });

export const commands = [{
  contexts: [0], integration_types: [0], type: 1, name: 'solo', description: 'Solo queue: get placed on a team by position',
  options: [
    sub('join', 'Join the solo queue with your position roles', [
      { type: 4, name: 'minutes_available', description: 'How long you can wait (default 60)', min_value: 5, max_value: 720 },
    ]),
    sub('leave', 'Leave the solo queue'),
    sub('status', 'Your place in the queue or your match'),
    sub('accept', 'Accept the match you were placed in'),
    sub('decline', 'Decline the match you were placed in'),
    sub('report', 'Report your game: who won, and the final box score screenshot', [
      { type: 3, name: 'winner', description: 'Which team won', required: true, choices: [{ name: 'Team A', value: 'A' }, { name: 'Team B', value: 'B' }] },
      { type: 11, name: 'screenshot', description: 'The final box score screenshot', required: true },
    ]),
    sub('cancel', 'Commissioners: call off the match in this thread'),
    sub('testfill', 'Commissioners: add 9 fake players that never accept, for testing alone'),
  ],
}];

// ---------- what the bot says ----------

const unix = d => Math.floor(new Date(d).getTime() / 1000);
const button = (id, text, style) => ({ type: 2, custom_id: PREFIX + id, label: text, style });
const row = (...components) => ({ type: 1, components });
const who = p => (p.fake ? p.name : `<@${p.discord_id}>`);

// The pinned live queue message: who is waiting, and how many can play each position.
export function queuePayload(entries) {
  const lines = entries.map((e, i) => `${i + 1}. ${who({ ...e, name: e.discord_name, fake: solo.FAKE_IDS.includes(e.discord_id) })} · ${e.positions.split(',').join(' / ')} · <t:${unix(e.created_at)}:R>`);
  const counts = solo.POSITIONS.map(p => `${p} ${entries.filter(e => e.positions.split(',').includes(p)).length}`);
  return {
    embeds: [{
      title: 'Solo queue',
      description: lines.join('\n') || 'Nobody is waiting. Be the first.',
      fields: [{ name: 'Can play (a game needs 2 of each)', value: counts.join(' · ') }],
      footer: { text: `Your positions are your ${solo.POSITIONS.join(' / ')} roles` },
    }],
    components: [row(button('join', 'Join Solo Queue', 1), button('leave', 'Leave', 2))],
    allowedMentions: { parse: [] },
  };
}

const roster = (players, side) => players.filter(p => p.side === side).map(p => `**${p.position}** ${who(p)}`).join('\n') || '-';

// One thread message per match status. `players` is solo.matchPlayers().
export function matchPayload(m, players) {
  switch (m.status) {
    case 'pending_accept': return {
      content: `${players.filter(p => !p.fake).map(who).join(' ')}\nGame found. Everyone: accept within ${solo.ACCEPT_MINUTES} minutes.`,
      embeds: [{
        title: `Solo match #${m.id}`,
        fields: [{ name: 'Team A', value: roster(players, 'A'), inline: true }, { name: 'Team B', value: roster(players, 'B'), inline: true }],
      }],
      components: [row(button('accept', 'Accept', 3), button('decline', 'Decline', 4))],
      allowedMentions: { users: players.filter(p => !p.fake).map(p => p.discord_id) },
    };
    case 'in_progress': return {
      content: [
        'All ten accepted. From here it is on you:',
        '1. Team A\'s PG hosts the lobby, unless you agree otherwise here.',
        '2. Swap gamertags in this thread and set up the game.',
        '3. When it is over, anyone in the game presses the button for the team that won and uploads the final box score screenshot.',
      ].join('\n'),
      embeds: [{
        title: `Solo match #${m.id}: report the result`,
        fields: [{ name: 'Team A', value: roster(players, 'A'), inline: true }, { name: 'Team B', value: roster(players, 'B'), inline: true }],
        footer: { text: 'The score and player stats are read from the screenshot' },
      }],
      components: [row(button('result:A', 'Team A won', 3), button('result:B', 'Team B won', 3))],
      allowedMentions: { parse: [] },
    };
    case 'completed': return { content: `Final: **Team A** ${m.team_a_score} – ${m.team_b_score} **Team B**. This thread is archived in 24 hours.` };
    default: return { // cancelled
      content: `Match cancelled: ${m.cancel_reason}.${m.cancel_reason === 'cancelled by a commissioner' || m.cancel_reason === 'no result reported'
        ? ' Use `/solo join` to queue again.' : ' Players who did their part are back in the queue; anyone else can rejoin with `/solo join`.'}`,
    };
  }
}

function statusText({ seat, match, entry }) {
  if (seat) {
    const where = match.discord_thread_id ? ` Thread: <#${match.discord_thread_id}>` : '';
    return `You are **${seat.position}** on Team ${seat.side} in solo match #${match.id}, status \`${match.status}\`.${where}`;
  }
  if (entry) return `You are in the solo queue as ${entry.positions.split(',').join(' / ')} since <t:${unix(entry.created_at)}:R>, until <t:${unix(entry.available_until)}:t>.`;
  return 'You are not in the solo queue.';
}

// ---------- commands and buttons ----------

const quiet = (i, content) => i.reply({ content, flags: EPHEMERAL });
const loud = (i, content) => i.reply({ content, allowedMentions: { parse: [] } });
// The position roles the member holds in this server.
const rolePositions = i => solo.positionsFromRoles([...i.member.roles.cache.values()].map(r => r.name));
const commissioner = i => {
  if (!i.memberPermissions.has(MANAGE_GUILD)) throw new UserError('Only a commissioner (Manage Server) can do that.', 403);
};

async function report(i, { db, ingest, fetchImpl }, user, winner, file) {
  await i.deferReply(); // downloading and reading the screenshot can take a while
  const image = await attachmentToDataUrl(file, fetchImpl);
  const m = await solo.reportResult(db, ingest, user.id, { winner, image });
  await i.editReply({
    content: `Result reported by <@${i.user.id}>: **Team A** ${m.team_a_score} – ${m.team_b_score} **Team B**. Player stats saved.`,
    allowedMentions: { parse: [] },
  });
}

const ACTIONS = {
  join: async (i, { db }, user) => {
    const { entry, match } = await solo.joinQueue(db, user.id, { positions: rolePositions(i), minutes: i.options?.getInteger('minutes_available') });
    await quiet(i, match
      ? 'Game found. A private thread opens in a moment.'
      : `You are in the solo queue as ${entry.positions.split(',').join(' / ')} until <t:${unix(entry.available_until)}:t>.`);
  },
  leave: async (i, { db }, user) => {
    await solo.leaveQueue(db, user.id);
    await quiet(i, 'You left the solo queue.');
  },
  status: async (i, { db }, user) => quiet(i, statusText(await solo.queueStatus(db, user.id))),
  accept: async (i, { db }, user) => {
    const { accepted } = await solo.respondToMatch(db, user.id, true);
    await loud(i, `<@${i.user.id}> accepted (${accepted} of ${solo.POSITIONS.length * 2}).`);
  },
  decline: async (i, { db }, user) => {
    await solo.respondToMatch(db, user.id, false);
    await loud(i, `<@${i.user.id}> declined.`);
  },
  report: (i, ctx, user) => report(i, ctx, user, i.options.getString('winner'), i.options.getAttachment('screenshot')),
  // The "Team A won" / "Team B won" buttons open a form with one field: the screenshot.
  result: (i, ctx, user, winner) => i.showModal({
    custom_id: `${PREFIX}resultform:${winner}`, title: `Team ${winner} won: upload the box score`,
    components: [{
      type: 18, label: 'Final box score screenshot', description: 'The score and player stats are read from it',
      component: { type: 19, custom_id: 'screenshot', min_values: 1, max_values: 1, required: true },
    }],
  }),
  resultform: (i, ctx, user, winner) => report(i, ctx, user, winner, i.fields.getUploadedFiles('screenshot', true).first()),
  cancel: async (i, { db }) => {
    commissioner(i);
    await solo.cancelByThread(db, i.channelId);
    await loud(i, `Match called off by <@${i.user.id}>.`);
  },
  testfill: async (i, { db }) => {
    commissioner(i);
    const added = await solo.fillWithFakes(db);
    await quiet(i, `${added} fake players are in the solo queue, each able to play any position. Now run \`/solo join\`. `
      + `They never accept, so the match cancels after ${solo.ACCEPT_MINUTES} minutes and they leave the queue.`);
  },
};

export async function handle(interaction, ctx) {
  try {
    const user = await upsertUser(ctx.db, { discordId: interaction.user.id, name: interaction.user.username });
    const [key, arg] = interaction.isChatInputCommand() ? [interaction.options.getSubcommand()] : interaction.customId.slice(PREFIX.length).split(':');
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
  ctx.soloSync = (ctx.soloSync ?? Promise.resolve()).then(() => tick(client, ctx)).catch(err => console.error(err));
  return ctx.soloSync;
}

async function tick(client, ctx) {
  const { db } = ctx;
  await solo.runMatcher(db);
  if (!ctx.soloChannelId) return; // no channel configured: the queue still works, without threads or the live message

  for (const m of await solo.matchesToAnnounce(db)) {
    try {
      await announce(client, ctx, m);
    } catch (err) {
      console.error(`Solo match ${m.id}: could not post "${m.status}" in Discord. Trying again on the next tick.`, err);
    }
  }
  for (const m of await solo.threadsToArchive(db)) {
    const thread = await client.channels.fetch(m.discord_thread_id).catch(() => null);
    await thread?.setArchived(true);
    await solo.markArchived(db, m.id);
  }
  await refreshQueueMessage(client, ctx);
}

async function announce(client, ctx, m) {
  const { db } = ctx;
  const players = await solo.matchPlayers(db, m.id);
  let thread = m.discord_thread_id ? await client.channels.fetch(m.discord_thread_id).catch(() => null) : null;
  if (!m.discord_thread_id && m.status === 'pending_accept') {
    const channel = await client.channels.fetch(ctx.soloChannelId);
    thread = await channel.threads.create({ name: `Solo match #${m.id}`, type: PRIVATE_THREAD, invitable: false, autoArchiveDuration: 1440 });
    await solo.setThread(db, m.id, thread.id);
    for (const p of players.filter(x => !x.fake)) {
      await thread.members.add(p.discord_id).catch(err => console.error(`Could not add ${p.discord_id} to the solo match thread: ${err.message}`));
    }
  }
  if (thread) {
    await thread.send(matchPayload(m, players));
    if (m.status === 'cancelled') await thread.setArchived(true);
  }
  await solo.markAnnounced(db, m.id, m.status);
}

const QUEUE_MESSAGE = 'solo_queue_message';

// One pinned message in the solo queue channel, edited only when the queue actually changed.
async function refreshQueueMessage(client, ctx) {
  const { db } = ctx;
  const payload = queuePayload(await solo.listQueue(db));
  const json = JSON.stringify(payload);
  if (json === ctx.soloQueueShown) return;
  const channel = await client.channels.fetch(ctx.soloChannelId);
  const saved = await db.get('SELECT value FROM settings WHERE key = ?', QUEUE_MESSAGE);
  const edited = saved && await channel.messages.edit(JSON.parse(saved.value), payload).catch(() => null);
  if (!edited) { // first run, or someone deleted the message
    const message = await channel.send(payload);
    await message.pin();
    await db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, QUEUE_MESSAGE, JSON.stringify(message.id));
  }
  ctx.soloQueueShown = json;
}

export function start(client, ctx) {
  if (!ctx.soloChannelId) console.warn('SOLO_QUEUE_CHANNEL_ID is not set: the solo queue works, but there are no match threads and no live queue message.');
  sync(client, ctx);
  setInterval(() => sync(client, ctx), TICK_MS);
}

export default { commands, names: ['solo'], prefix: PREFIX, handle, start };

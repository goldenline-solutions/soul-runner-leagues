// Soul Runner Discord bot. Runs as its own long-lived process (npm run bot), next to the site:
// it uses the same database and the same src/ code, so a reading made here shows up on the site.
// Vercel can't host it (no long-lived processes); run it on any always-on machine.
//
// Each feature in ./ exports { commands, names, handle }, plus optionally `prefix` (the start of its
// button and modal ids) and `start(client, ctx)` (run once the bot is logged in). Add new ones to FEATURES.
import { resolve } from 'node:path';
import { Client, Events, GatewayIntentBits, PermissionFlagsBits as P } from 'discord.js';
import { root, loadEnv } from '../src/env.js';
import { connectPostgres, setup } from '../src/db.js';
import { ingestConfig } from '../src/ingest.js';
import boxscore from './boxscore.js';
import scrim from './scrim.js';
import solo from './solo.js';
import roster from './roster.js';

const FEATURES = [boxscore, scrim, solo, roster];
// What the scrim and solo queues need in their channels (the pinned live message, the private match
// threads), plus Manage Roles for the roster commands.
const PERMISSIONS = P.ManageRoles | P.ViewChannel | P.SendMessages | P.EmbedLinks | P.PinMessages | P.CreatePrivateThreads | P.SendMessagesInThreads | P.ManageThreads;

loadEnv();
const env = process.env;
if (!env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Add the bot token to .env (see the Discord bot section of README.md).');
  process.exit(1);
}

const db = env.DATABASE_URL
  ? connectPostgres(env.DATABASE_URL)
  // The embedded database is single-process: stop `npm start` first, or set DATABASE_URL.
  : await (await import('../src/db-local.js')).connectLocal(resolve(root, env.LOCAL_DB_DIR || 'data/pglite'));
if (env.DATABASE_URL) await setup(db);

const ctx = {
  db, ingest: ingestConfig(env), siteUrl: env.SITE_URL || '',
  queueChannelId: env.SCRIM_QUEUE_CHANNEL_ID || '', adminRoleId: env.SCRIM_ADMIN_ROLE_ID || '',
  soloChannelId: env.SOLO_QUEUE_CHANNEL_ID || '', freeAgentRoleId: env.FREE_AGENT_ROLE_ID || '',
};
if (!ctx.ingest.apiKey) console.warn('OPENAI_API_KEY is not set: /boxscore will answer that screenshot reading is not set up.');

// Commands, buttons and forms arrive as interactions, so no privileged intents are needed.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async c => {
  console.log(`Logged in as ${c.user.tag}.`);
  console.log(env.DATABASE_URL ? 'Database: PostgreSQL (DATABASE_URL)' : 'Database: embedded Postgres in data/pglite');
  console.log(`Invite link: https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`);
  await registerCommands(c);
  for (const f of FEATURES) f.start?.(c, ctx);
});

// With DISCORD_GUILD_ID the commands belong to that one server; without it, to every server the bot is in.
async function registerCommands(c) {
  const commands = FEATURES.flatMap(f => f.commands);
  const guildId = env.DISCORD_GUILD_ID;
  if (guildId && !c.guilds.cache.has(guildId)) {
    // Discord refuses server commands for a server the bot hasn't joined ("Missing Access").
    console.warn(`The bot is not in server ${guildId} yet. Open the invite link above and add it; commands register as soon as it joins.`);
    console.warn(`(If it is already in your server, DISCORD_GUILD_ID is wrong. It is in: ${[...c.guilds.cache.values()].map(g => `${g.name} ${g.id}`).join(', ') || 'no servers'}.)`);
    return;
  }
  try {
    await c.application.commands.set(commands, ...(guildId ? [guildId] : []));
    console.log(`${commands.length} commands registered${guildId ? ` in server ${guildId}` : ' globally'}.`);
  } catch (err) {
    console.error(`Could not register commands: ${err.message}`);
  }
}

client.on(Events.GuildCreate, guild => {
  if (guild.id === env.DISCORD_GUILD_ID && client.isReady()) registerCommands(client);
});

client.on(Events.InteractionCreate, async interaction => {
  // Commands (and their autocomplete) are routed by name, buttons and forms by their id prefix.
  const feature = FEATURES.find(f => (interaction.commandName
    ? f.names.includes(interaction.commandName)
    : f.prefix && interaction.customId?.startsWith(f.prefix)));
  if (!feature) return;
  try {
    await feature.handle(interaction, ctx);
  } catch (err) {
    console.error(err);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await client.destroy();
    await db.close?.();
    process.exit(0);
  });
}

await client.login(env.DISCORD_TOKEN);

// Box score reading from Discord. Two ways in, one pipeline (src/ingest.js):
//   /boxscore screenshot:<image>                     slash command
//   right-click a message -> Apps -> Read box score  message command
// The reading is stored (so the same image is never paid for twice) and the matchup is worked out
// from the players. Nothing is saved as a game until a commissioner presses the Save button under
// the reading, or saves it in Upload Results on the site.
import { UserError } from '../src/league.js';
import { ingestScreenshot, storedDraft } from '../src/ingest.js';
import { recordGame } from '../src/api.js';

const PREFIX = 'box:';
const EPHEMERAL = 64;
const SAVED_ROOM = 300; // kept free under the message limit for the "Saved" line
const MANAGE_GUILD = String(1 << 5); // who sees the commands by default; change in Server Settings -> Integrations
const GUILD_ONLY = { contexts: [0], integration_types: [0], default_member_permissions: MANAGE_GUILD };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 10 * 1024 * 1024;
const MESSAGE_LIMIT = 2000;

export const SLASH_NAME = 'boxscore';
export const MENU_NAME = 'Read box score';

export const commands = [
  {
    ...GUILD_ONLY, type: 1, name: SLASH_NAME, description: 'Read a 2K box score screenshot',
    options: [{ type: 11, name: 'screenshot', description: 'The box score screenshot', required: true }],
  },
  { ...GUILD_ONLY, type: 3, name: MENU_NAME },
];

const isImage = a => IMAGE_TYPES.includes(String(a.contentType || '').split(';')[0].trim());

export async function attachmentToDataUrl(attachment, fetchImpl = fetch) {
  const mime = String(attachment.contentType || '').split(';')[0].trim();
  if (!IMAGE_TYPES.includes(mime)) throw new UserError('Upload a PNG, JPG, WebP or GIF screenshot.');
  if (attachment.size > MAX_BYTES) throw new UserError('Screenshot is larger than 10 MB.');
  const res = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(30e3) });
  if (!res.ok) throw new Error(`Could not download the screenshot from Discord (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new UserError('Screenshot is larger than 10 MB.');
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const clean = s => String(s ?? '').replace(/[`\r\n]/g, "'");
const cell = (v, w) => String(v ?? 0).padStart(w);
const HEADER = `${''.padEnd(17)}PTS REB AST STL BLK  TO    FG    3P    FT`;

function sideTable(label, score, lines) {
  const rows = lines.map(l => {
    const s = l.stats;
    const flag = l.ai ? '~' : l.match ? ' ' : '*';
    const name = clean(l.tag || l.read_as).slice(0, 15).padEnd(15);
    const made = (m, a) => `${m ?? 0}-${a ?? 0}`.padStart(6);
    return `${flag}${name} ${cell(s.pts, 3)} ${cell(s.reb, 3)} ${cell(s.ast, 3)} ${cell(s.stl, 3)} ${cell(s.blk, 3)} ${cell(s.tov, 3)}`
      + `${made(s.fgm, s.fga)}${made(s.tpm, s.tpa)}${made(s.ftm, s.fta)}`;
  });
  return [`${label} ${score}`, ...rows].join('\n');
}

// Turns an ingestScreenshot() result into the text of the bot's reply.
export function formatReading(r, { siteUrl = '' } = {}) {
  const site = siteUrl.replace(/\/$/, '');
  if (r.duplicate_game_id && !r.lines) {
    return `This exact screenshot is already saved as a game.${site ? ` ${site}/#box/${r.duplicate_game_id}` : ''}`;
  }
  const side = s => r.lines.filter(l => l.side === s);
  const sr = r.series; // the matchup worked out from the players, when there is one
  const away = sr ? clean(sr.away_team).slice(0, 40) : 'AWAY';
  const home = sr ? clean(sr.home_team).slice(0, 40) : 'HOME';
  const table = ['```', HEADER, sideTable(away, r.away_score, side('away')), '', sideTable(home, r.home_score, side('home')), '```'].join('\n');
  const legend = [
    r.lines.some(l => !l.ai && !l.match) && '`*` not a league player yet',
    r.lines.some(l => l.ai) && '`~` AI player',
  ].filter(Boolean).join(' · ');
  const title = sr ? `${away} ${r.away_score}, ${home} ${r.home_score}` : `Away ${r.away_score}, Home ${r.home_score}`;
  const where = sr && [
    clean(sr.league), sr.week ? `Weekend ${String(sr.week).padStart(2, '0')}` : clean(sr.label || sr.stage),
    sr.decided ? 'series already decided' : `Game ${sr.next_game_number}`,
  ].filter(Boolean).join(' · ');
  const head = `**Box score read: ${title}**${r.cached ? ' (read earlier, no new model call)' : ''}${where ? `\n${where}` : ''}`;
  const onSite = site ? `in Upload Results: ${site}/#game` : 'in Upload Results on the site';
  // Kept to one line: the Save button replaces the last line of the message.
  const foot = saveButton(r)
    ? `Not saved yet. Press Save below, or fix names and stats first ${onSite}`
    : `Not saved yet. ${sr ? '' : "Couldn't tell which matchup this is from the players. "}Review and save it ${onSite}`;

  // Warnings take whatever room is left under Discord's message limit.
  const fixed = [head, table, legend, foot].filter(Boolean).join('\n');
  let room = MESSAGE_LIMIT - fixed.length - 40 - SAVED_ROOM;
  const shown = [];
  for (const w of r.warnings || []) {
    const line = `- ${clean(w)}`;
    if (line.length + 1 > room) break;
    shown.push(line);
    room -= line.length + 1;
  }
  const hidden = (r.warnings || []).length - shown.length;
  if (hidden) shown.push(`- …and ${hidden} more on the site`);
  return [head, table, legend, shown.length && `**Check:**\n${shown.join('\n')}`, foot].filter(Boolean).join('\n');
}

const button = (label, customId, style) => ({ type: 1, components: [{ type: 2, style, label, custom_id: customId }] });

// A Save button only when the matchup is known, still open, and this isn't a game already recorded.
function saveButton(r) {
  const sr = r.series;
  if (!sr || sr.decided || r.duplicate_game_id) return null;
  return button(`Save as Game ${sr.next_game_number}`, `${PREFIX}save:${r.screenshot_id}:${sr.id}:${sr.next_game_number}`, 3);
}

export function readingPayload(r, opts) {
  const save = r.lines && saveButton(r);
  return { content: formatReading(r, opts), components: save ? [save] : [], allowedMentions: { parse: [] } };
}

// The Save button. Saving creates any player the league doesn't know yet, so with unknown names the
// first press only swaps the button for one that says so.
async function save(interaction, { db, siteUrl = '' }) {
  const [action, shotId, seriesId, gameNumber] = interaction.customId.slice(PREFIX.length).split(':');
  if (!interaction.memberPermissions?.has(BigInt(MANAGE_GUILD))) {
    return interaction.reply({ content: 'Only members with Manage Server can save games.', flags: EPHEMERAL });
  }
  await interaction.deferUpdate();
  const draft = await storedDraft(db, Number(shotId), Number(seriesId));
  const lines = draft.lines.filter(l => !l.ai);
  const fresh = lines.filter(l => !l.match).length;
  if (fresh && action === 'save') {
    const label = `Add ${fresh} new player${fresh > 1 ? 's' : ''} (*) and save`;
    return interaction.editReply({ components: [button(label, `${PREFIX}force:${shotId}:${seriesId}:${gameNumber}`, 4)] });
  }
  const { id, roster } = await recordGame(db, {
    series_id: Number(seriesId), game_number: Number(gameNumber), home_score: draft.home_score, away_score: draft.away_score,
    box: lines.map(l => ({ side: l.side, tag: l.tag, ...l.stats })), screenshot_id: Number(shotId),
  });
  const site = siteUrl.replace(/\/$/, '');
  const joined = roster.added.length ? ` Added to rosters: ${roster.added.map(a => `${clean(a.tag)} (${clean(a.team)})`).join(', ')}.` : '';
  const saved = `✅ Saved as Game ${gameNumber} by <@${interaction.user.id}>.${site ? ` ${site}/#box/${id}` : ''}${joined}`.slice(0, SAVED_ROOM);
  const body = interaction.message.content.split('\n').slice(0, -1).join('\n'); // drop the "Not saved yet" line
  await interaction.editReply({ content: `${body}\n${saved}`, components: [], allowedMentions: { parse: [] } });
}

function pickAttachment(interaction) {
  if (interaction.commandName === SLASH_NAME) return interaction.options.getAttachment('screenshot');
  const found = [...interaction.targetMessage.attachments.values()].find(isImage);
  if (!found) throw new UserError('That message has no PNG, JPG, WebP or GIF image attached.');
  return found;
}

export async function handle(interaction, ctx) {
  const { db, ingest, siteUrl, fetchImpl } = ctx;
  if (interaction.customId) {
    try {
      return await save(interaction, ctx);
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      const content = `Couldn't save it: ${err instanceof UserError ? err.message : 'something went wrong.'}`;
      return interaction.deferred || interaction.replied
        ? interaction.followUp({ content, flags: EPHEMERAL }) : interaction.reply({ content, flags: EPHEMERAL });
    }
  }
  await interaction.deferReply(); // a reading takes 10 seconds to a few minutes
  try {
    const attachment = pickAttachment(interaction);
    const image = await attachmentToDataUrl(attachment, fetchImpl);
    const reading = await ingestScreenshot(db, ingest, { image, detect_series: true });
    // The slash command's upload is not shown in the channel on its own, so show it with the reading.
    const embeds = interaction.commandName === SLASH_NAME ? [{ image: { url: attachment.url } }] : [];
    await interaction.editReply({ ...readingPayload(reading, { siteUrl }), embeds });
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    const message = err instanceof UserError ? err.message : 'Something went wrong reading that screenshot.';
    await interaction.editReply({ content: `Couldn't read it: ${message}`.slice(0, MESSAGE_LIMIT), allowedMentions: { parse: [] } });
  }
}

export default { commands, names: [SLASH_NAME, MENU_NAME], prefix: PREFIX, handle };

// Screenshot ingest: reads a 2K box score image with an OpenAI vision model, then turns it into a
// draft box score for the commissioner to confirm. Ported from the 2K-app pipeline
// (validate -> extract -> integrity retry -> 3PM back-fill -> duplicate checks), with one change:
// nothing is saved as a game until the commissioner reviews it in Upload Results.
import { createHash } from 'node:crypto';
import { UserError } from './league.js';
import {
  VALIDATION_PROMPT, VALIDATION_SCHEMA, EXTRACTION_PROMPT, BOX_SCORE_SCHEMA, feedbackPrompt, repairPrompt,
} from './ingest-prompts.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FUZZY_THRESHOLD = 88; // same cut-off the 2K-app fuzzy merge uses
const ROSTER_THRESHOLD = 75; // looser cut-off for players on the two teams in this matchup

export function ingestConfig(env) {
  return {
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || 'gpt-5',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    validate: env.INGEST_VALIDATE !== '0',
    reasoningEffort: env.OPENAI_REASONING_EFFORT || 'low', // gpt-5 / o-series only
  };
}

// ---------- model calls ----------

async function callModel(cfg, dataUrl, prompt, name, schema) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(120e3),
    body: JSON.stringify({
      model: cfg.model,
      // Reasoning models (gpt-5, o-series) only accept the default temperature.
      ...(/^(gpt-5|o\d)/.test(cfg.model) ? { reasoning_effort: cfg.reasoningEffort } : { temperature: 0 }),
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }, { type: 'text', text: prompt }],
      }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Model API returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(body.choices[0].message.content);
}

async function validateScreenshot(cfg, dataUrl) {
  let v;
  try {
    v = await callModel(cfg, dataUrl, VALIDATION_PROMPT, 'ScreenshotValidation', VALIDATION_SCHEMA);
  } catch (err) {
    throw new UserError("Unable to validate screenshot. Please ensure you're uploading a valid NBA 2K 5v5 box score screenshot. " +
      `Validation error: ${err.message}`);
  }
  const missing = [];
  if (!v.has_basketball_stats) missing.push('basketball statistics');
  if (!v.has_player_gamertags) missing.push('player gamertags');
  if (!v.has_team_scores) missing.push('team scores');
  if (!v.has_nba2k_interface) missing.push('NBA2K interface');
  // Only a clear 3v3/2v2 game is rejected for its player count. A miscount (a crew-leader name taken
  // for a sixth player, or a player who left) goes on to extraction, where the commissioner sees every row.
  const smallSided = !v.is_5v5_game && /3v3|2v2/i.test(v.reason);
  if (smallSided) missing.push('5v5 game format (only 5v5 games are accepted, not 3v3 or 2v2)');
  if (!missing.length && (v.is_valid_rec_screenshot || !v.is_5v5_game)) return;
  const reason = [v.reason, missing.length ? `Missing required elements: ${missing.join(', ')}.` : ''].filter(Boolean).join('. ');
  throw new UserError(`The uploaded image is not a valid NBA 2K 5v5 box score screenshot. ${reason} ` +
    'Please upload a screenshot from the game stats screen showing player statistics, team scores, and game information.');
}

export async function extractBoxScore(cfg, dataUrl, { retryOnError = true, feedback = null } = {}) {
  if (cfg.validate) await validateScreenshot(cfg, dataUrl);
  const instruction = feedback ? feedbackPrompt(feedback) : EXTRACTION_PROMPT;
  let data;
  try {
    data = await callModel(cfg, dataUrl, instruction, 'BoxScoreExtraction', BOX_SCORE_SCHEMA);
  } catch (err) {
    if (!retryOnError) throw err;
    try {
      data = await callModel(cfg, dataUrl, repairPrompt(instruction, err.message), 'BoxScoreExtraction', BOX_SCORE_SCHEMA);
    } catch (retryErr) {
      throw new Error(`Extraction failed after retry: ${retryErr.message}`);
    }
  }
  data.metadata.extracted_from = 'nba2k_rec_boxscore_screenshot';
  return data;
}

// ---------- checks ----------

export function structureWarnings(data) {
  const out = [];
  const players = data.players || [];
  if (players.length !== 10) out.push(`Expected 10 players, found ${players.length}`);
  for (const side of ['AWAY', 'HOME']) {
    const rows = players.filter(p => p.side === side);
    if (rows.length !== 5) out.push(`${side} team has ${rows.length} players (expected 5)`);
    const idx = rows.map(p => p.row_index);
    if (new Set(idx).size !== idx.length) out.push(`${side} team has duplicate row_index values`);
    if (idx.some(i => i < 0 || i > 4)) out.push(`${side} team has row_index outside 0-4`);
  }
  const sides = (data.teams || []).map(t => t.side);
  if (sides.length !== 2 || !sides.includes('AWAY') || !sides.includes('HOME')) out.push('Expected exactly two teams: AWAY and HOME');
  return out;
}

export function integrityWarnings(data) {
  const out = [];
  for (const side of ['away', 'home']) {
    const q = data.game?.quarters?.[side];
    const score = data.game?.[`${side}_score`];
    // Only when all four quarters were read: blanks mean "not visible", not zero.
    if (Array.isArray(q) && q.length === 4 && q.every(v => Number.isInteger(v))) {
      const sum = q.reduce((s, v) => s + v, 0);
      if (sum > score) out.push(`${side.toUpperCase()} quarter scores sum (${sum}) != final score (${score})`);
      // Overtime points have no quarter slot, so a short sum is expected and not worth a retry.
      if (sum < score) out.push(`${side.toUpperCase()} quarters add up to ${sum} of ${score}: overtime, or a misread quarter`);
    }
  }
  for (const team of data.teams || []) {
    const sum = (data.players || []).filter(p => p.side === team.side).reduce((s, p) => s + (p.stats?.pts || 0), 0);
    if (sum !== team.totals?.pts) out.push(`${team.side} team: player points sum (${sum}) != team total (${team.totals?.pts})`);
  }
  out.push(...headerWarnings(data));
  // A stat line that doesn't add up was usually read from two different rows.
  for (const p of data.players || []) {
    const st = p.stats || {};
    const expected = 2 * (st.fgm || 0) + (st.tpm || 0) + (st.ftm || 0);
    if ((st.pts || 0) !== expected) {
      out.push(`${p.side} row ${p.row_index + 1} (${p.gamertag}): PTS ${st.pts} doesn't match 2 x FGM + 3PM + FTM = ${expected}, re-read that row`);
    }
  }
  return out;
}

// The header-row name (crew leader) read as a player pushes every name one row off its stats.
export function headerWarnings(data) {
  const out = [];
  for (const team of data.teams || []) {
    const header = normalizeName(cleanGamertag(team.header_name));
    if (!header) continue;
    const hit = (data.players || []).find(p => p.side === team.side && p.row_index === 0 && normalizeName(cleanGamertag(p.gamertag)) === header);
    const elsewhere = (data.players || []).filter(p => normalizeName(cleanGamertag(p.gamertag)) === header);
    if (hit || elsewhere.length > 1) {
      out.push(`"${cleanGamertag(team.header_name)}" is the name in the ${team.side} table's header row, not a player row: player names may be one row off their stats`);
    }
  }
  return out;
}

const isCritical = w => /player points sum|quarter scores sum|header row|re-read that row/i.test(w);
export const EXTRACTION_VERSION = 2; // bump when prompts change so stored readings are redone

// ---------- names ----------

// Strips a console icon OCR'd as a leading "0 ", the voice-chat glyph, and stray symbols at either end.
export function cleanGamertag(raw) {
  return String(raw ?? '')
    .replace(/🔊/gu, '')
    .trim()
    .replace(/^(0\s+)+/, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export const normalizeName = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

// rapidfuzz fuzz.ratio: normalized Indel similarity, 100 * (1 - indel / (len_a + len_b)).
export function fuzzRatio(a, b) {
  if (!a.length && !b.length) return 100;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  const lcs = prev[b.length];
  return 100 * (2 * lcs) / (a.length + b.length);
}

const AI_NAME = /^(ai( player)?|cpu|player ?\d*)$/i;

// Order: exact Discord/Steam tag anywhere in the league, then a close match on the two teams'
// rosters (roster: Set of player ids), then a very close match anywhere. taken: ids already
// given to another row of this screenshot.
export function matchPlayer(players, name, { roster = null, taken = null } = {}) {
  const target = normalizeName(name);
  if (!target) return null;
  const free = players.filter(p => !taken?.has(p.id));
  for (const p of free) {
    if (normalizeName(p.discord_tag) === target || (p.steam_tag && normalizeName(p.steam_tag) === target)) {
      return { player_id: p.id, tag: p.discord_tag, how: 'exact', score: 100 };
    }
  }
  const closest = (pool, threshold, how) => {
    let best = null;
    for (const p of pool) {
      for (const candidate of [p.discord_tag, p.steam_tag]) {
        if (!candidate) continue;
        const score = fuzzRatio(target, normalizeName(candidate));
        if (score >= threshold && (!best || score > best.score)) best = { player_id: p.id, tag: p.discord_tag, how, score: Math.round(score) };
      }
    }
    return best;
  };
  return (roster && closest(free.filter(p => roster.has(p.id)), ROSTER_THRESHOLD, 'roster'))
    || closest(free, FUZZY_THRESHOLD, 'fuzzy');
}

// ---------- pipeline ----------

function parseDataUrl(image) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) throw new UserError('Upload a PNG, JPG, WebP or GIF screenshot.');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new UserError('Screenshot is larger than 10 MB.', 413);
  return { mime: m[1], buffer };
}

// Back-fills 3PM from PTS - 2*FGM - FTM when the model left it at 0 (2K-app behaviour).
function backfillThrees(lines, warnings) {
  for (const l of lines) {
    const s = l.stats;
    if (!s.tpm && s.pts > 0 && s.fgm > 0) {
      const tpm = Math.max(0, Math.min(s.fgm, s.pts - 2 * s.fgm - s.ftm));
      if (tpm > 0) {
        s.tpm = tpm;
        if (s.tpa < tpm) s.tpa = tpm;
        warnings.push(`Calculated 3PM (${tpm}) for player ${l.read_as} based on PTS, FGM, and FTM`);
      }
    }
  }
}

// Builds the draft the Upload Results form consumes. 2K sides (AWAY/HOME) are mapped onto the
// league matchup's home/away by roster overlap, since the screenshot does not name teams.
export async function buildDraft(db, data, seriesId) {
  const warnings = [];
  const players = await db.all('SELECT id, discord_tag, steam_tag FROM players');
  const rosterTeam = new Map((await db.all('SELECT player_id, team_id FROM roster_slots WHERE player_id IS NOT NULL'))
    .map(r => [r.player_id, r.team_id]));

  const series = seriesId ? await db.get('SELECT * FROM series WHERE id = ?', seriesId) : null;
  const matchupTeams = [series?.home_team_id, series?.away_team_id].filter(Boolean);
  const roster = matchupTeams.length
    ? new Set([...rosterTeam].filter(([, team]) => matchupTeams.includes(team)).map(([id]) => id)) : null;

  const lines = [...(data.players || [])]
    .sort((a, b) => (a.side === b.side ? a.row_index - b.row_index : a.side === 'AWAY' ? -1 : 1))
    .map(p => {
      const readAs = cleanGamertag(p.gamertag);
      const ai = !readAs || AI_NAME.test(readAs);
      const s = p.stats || {};
      return {
        side2k: p.side, row_index: p.row_index, read_as: readAs || p.gamertag, ai, match: null, tag: readAs,
        stats: {
          pts: s.pts, reb: s.reb, ast: s.ast, stl: s.stl, blk: s.blk, tov: s.tov, pf: s.fouls,
          fgm: s.fgm, fga: s.fga, tpm: s.tpm, tpa: s.tpa, ftm: s.ftm, fta: s.fta,
        },
      };
    });
  // Exact names claim their player first, then the closest remaining matches, so two rows never
  // point at the same player.
  const taken = new Set();
  const pending = lines.filter(l => !l.ai);
  while (pending.length) {
    let pick = null;
    for (const l of pending) {
      const m = matchPlayer(players, l.read_as, { roster, taken });
      if (m && (!pick || m.score > pick.m.score)) pick = { l, m };
    }
    if (!pick) break;
    Object.assign(pick.l, { match: pick.m, tag: pick.m.tag });
    taken.add(pick.m.player_id);
    pending.splice(pending.indexOf(pick.l), 1);
  }
  backfillThrees(lines, warnings);
  for (const l of lines) {
    if (l.ai) warnings.push(`${l.side2k} row ${l.row_index + 1} looks like an AI player ("${l.read_as}"). It is left out unless you keep it.`);
    else if (!l.match) warnings.push(`"${l.read_as}" is not a known league player yet. Saving will add them.`);
  }

  let swap = false;
  if (series?.home_team_id) {
    // score[k] counts matched players who sit on the expected roster for that mapping.
    const score = { straight: 0, swapped: 0 };
    for (const l of lines) {
      const team = l.match && rosterTeam.get(l.match.player_id);
      if (!team) continue;
      const leagueSide = team === series.home_team_id ? 'HOME' : team === series.away_team_id ? 'AWAY' : null;
      if (!leagueSide) continue;
      score[leagueSide === l.side2k ? 'straight' : 'swapped']++;
    }
    swap = score.swapped > score.straight;
    if (swap) warnings.push("The screenshot's HOME side matches this matchup's away roster, so sides were flipped.");
  }

  const toLeague = side2k => ((side2k === 'HOME') !== swap ? 'home' : 'away');
  return {
    home_score: swap ? data.game.away_score : data.game.home_score,
    away_score: swap ? data.game.home_score : data.game.away_score,
    swap,
    platform: (data.players || []).filter(p => /^0\s/.test(String(p.gamertag).trim())).length > 4 ? 'Console' : 'PC',
    lines: lines.map(l => ({ ...l, side: toLeague(l.side2k) })),
    warnings,
  };
}

async function duplicateGame(db, draft) {
  const tags = draft.lines.filter(l => l.match).map(l => l.match.player_id).sort((a, b) => a - b).join(',');
  if (!tags) return null;
  const candidates = await db.all('SELECT id FROM games WHERE (home_score = ? AND away_score = ?) OR (home_score = ? AND away_score = ?)',
    draft.home_score, draft.away_score, draft.away_score, draft.home_score);
  for (const g of candidates) {
    const ids = (await db.all('SELECT player_id FROM box_scores WHERE game_id = ? ORDER BY player_id', g.id)).map(r => r.player_id).join(',');
    if (ids === tags) return g.id;
  }
  return null;
}

export async function ingestScreenshot(db, cfg, { image, series_id: seriesId }) {
  const { mime, buffer } = parseDataUrl(image);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const known = await db.get('SELECT id, game_id, extracted, warnings FROM screenshots WHERE sha256 = ?', sha256);
  if (known?.game_id) {
    return { screenshot_id: known.id, duplicate_game_id: known.game_id, message: 'Game already ingested with this image hash' };
  }

  let data, warnings;
  const stored = known?.extracted && JSON.parse(known.extracted);
  if (stored?.extraction_version === EXTRACTION_VERSION) {
    data = stored;
    warnings = JSON.parse(known.warnings);
  } else {
    if (!cfg.apiKey) throw new UserError('Screenshot reading is not set up yet: add OPENAI_API_KEY to the server settings.', 503);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    try {
      data = await extractBoxScore(cfg, dataUrl);
      if (structureWarnings(data).length) {
        data = await extractBoxScore(cfg, dataUrl, { retryOnError: false, feedback: structureWarnings(data) });
      }
      warnings = structureWarnings(data);
      const critical = integrityWarnings(data).filter(isCritical);
      if (critical.length) {
        try {
          const retry = await extractBoxScore(cfg, dataUrl, { retryOnError: false, feedback: critical });
          const still = integrityWarnings(retry).filter(isCritical);
          if (still.length < critical.length) data = retry;
          if (still.length) warnings.push(`Critical integrity issues persist after retry: ${still.join('; ')}`);
        } catch (err) {
          warnings.push(`Integrity retry failed: ${err.message}. Continuing with original extraction.`);
        }
      }
      for (const w of integrityWarnings(data)) if (!warnings.includes(w)) warnings.push(w);
      data.extraction_version = EXTRACTION_VERSION;
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(`Extraction failed: ${err.message}`, 502);
    }

    await db.run(`INSERT INTO screenshots (sha256, mime, image, extracted, warnings) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sha256) DO UPDATE SET mime = excluded.mime, image = excluded.image,
        extracted = excluded.extracted, warnings = excluded.warnings`,
    sha256, mime, buffer, JSON.stringify(data), JSON.stringify(warnings));
  }

  const screenshot = await db.get('SELECT id FROM screenshots WHERE sha256 = ?', sha256);
  const sid = Number(seriesId);
  const draft = await buildDraft(db, data, Number.isInteger(sid) && sid > 0 && sid < 2 ** 31 ? sid : null);
  const dup = await duplicateGame(db, draft);
  if (dup) draft.warnings.unshift('Duplicate game found: same players with the same scores are already recorded.');
  return {
    screenshot_id: screenshot.id,
    cached: stored?.extraction_version === EXTRACTION_VERSION,
    duplicate_game_id: dup,
    quarters: data.game.quarters,
    ...draft,
    warnings: [...warnings, ...draft.warnings],
  };
}

// Screenshots are public once attached to a saved game (proof for the box score); drafts are admin-only.
export async function readScreenshot(db, id, admin) {
  const row = await db.get('SELECT mime, image, game_id FROM screenshots WHERE id = ?', id);
  if (!row || (!row.game_id && !admin)) throw new UserError('Screenshot not found.', 404);
  return { mime: row.mime, data: Buffer.from(row.image) };
}

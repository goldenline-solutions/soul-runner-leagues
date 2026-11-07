// Prompts and JSON schemas ported verbatim from the 2K-app ingest pipeline
// (backend/openai_client.py). Keep them in sync deliberately: they were tuned on real screenshots.

export const VALIDATION_PROMPT =
  "You are validating NBA2K Rec box score screenshots. Analyze this image carefully.\n\n" +
  "A VALID NBA2K Rec box score screenshot MUST contain ALL of the following:\n" +
  "1. Basketball statistics table with columns showing: PTS (points), REB (rebounds), AST (assists), STL (steals), BLK (blocks), etc.\n" +
  "2. Player identifiers - EXACTLY 5 players per team, 10 players total (5v5 game format). Players may have:\n" +
  "   - Human player gamertags/usernames\n" +
  "   - AI player names (e.g., 'AI Player', 'CPU', generic names, or blank names)\n" +
  "   - Any combination of human and AI players\n" +
  "   Games with AI players are VALID as long as there are exactly 10 players total (5 per team)\n" +
  "3. Team scores showing final scores for two teams (usually labeled AWAY and HOME or similar)\n" +
  "4. NBA2K game interface elements (NBA2K branding, game UI, Rec mode indicators)\n" +
  "5. Basketball game context (not a map, not a menu, not a different game)\n" +
  "6. 5v5 game format - MUST have exactly 10 players total (5 per team). NOT 3v3 (6 players) or 2v2 (4 players)\n\n" +
  "If the image is:\n" +
  "- A map, landscape, or non-game image → INVALID\n" +
  "- A menu screen, settings, or non-box-score screen → INVALID\n" +
  "- A different game or sport → INVALID\n" +
  "- Missing any of the required elements above → INVALID\n" +
  "- Only partially showing stats or cut off → INVALID\n" +
  "- A 3v3 game (6 players total, 3 per team) → INVALID (only 5v5 games are accepted)\n" +
  "- A 2v2 game (4 players total, 2 per team) → INVALID (only 5v5 games are accepted)\n" +
  "- Any game format other than 5v5 → INVALID\n\n" +
  "IMPORTANT: Games with AI players (CPU players, bots, or players with generic/blank names) are VALID as long as:\n" +
  "- There are exactly 10 players total (5 per team)\n" +
  "- All other required elements are present\n" +
  "- It's a 5v5 Rec game format\n\n" +
  "Be strict. Only mark as valid if you can clearly see ALL required elements of a complete 5v5 Rec box score with exactly 10 players (human or AI).\n\n" +
  // This league plays crew / Pro-Am games, which the original Rec-only wording rejected.
  "MODE: This league plays 5v5 games in any NBA 2K team mode. Rec, Pro-Am, crew games and private or league games are all VALID. " +
  "Never reject a screenshot for being Pro-Am, crew or a custom team game instead of Rec. Treat every mention of Rec above as any 5v5 NBA 2K team game.";

export const VALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    is_valid_rec_screenshot: { type: 'boolean', description: 'True only if this is definitively a valid NBA2K Rec box score screenshot' },
    has_basketball_stats: { type: 'boolean', description: 'True if the image contains basketball statistics (points, rebounds, assists, etc.)' },
    has_player_gamertags: { type: 'boolean', description: "True if the image contains player gamertags, usernames, or player identifiers (including AI players with generic names like 'AI Player' or 'CPU')" },
    has_team_scores: { type: 'boolean', description: 'True if the image contains team scores (away/home or similar)' },
    has_nba2k_interface: { type: 'boolean', description: 'True if the image shows NBA2K game interface elements' },
    is_5v5_game: { type: 'boolean', description: 'True if the game is 5v5 (exactly 10 players total: 5 per team). Must be False for 3v3 (6 players) or 2v2 (4 players) games.' },
    reason: { type: 'string', description: "Brief explanation of why it is or isn't valid (only if invalid)" },
  },
  required: ['is_valid_rec_screenshot', 'has_basketball_stats', 'has_player_gamertags', 'has_team_scores', 'has_nba2k_interface', 'is_5v5_game', 'reason'],
  additionalProperties: false,
};

// Added for this site after a real screenshot came back with every name one row off its stats:
// the model took the name in each table's header row (the crew leader) for a player.
const LAYOUT = '\n\n' +
  'How the 2K GAME STATS screen is laid out:\n' +
  '- There are two team tables, one above the other. The top table is AWAY, the bottom table is HOME.\n' +
  '- Each table starts with a header row: one name on the left (the crew leader, crew name or team name), then the column labels ' +
  '(GRD, PTS, REB, AST, STL, BLK, FOULS, TO, FGM/FGA, 3PM/3PA, FTM/FTA). That header name is NOT a player and has no stat line. ' +
  'Put it in teams[].header_name and never in players. The same person may also appear as a player row; only the row under the header counts.\n' +
  '- The 5 players of a team are the 5 rows between its header row and its TOTAL row. row_index 0 is the first row under the header.\n' +
  '- Read every player row straight across: a name belongs to the numbers on the same horizontal line, never to the line above or below. ' +
  'Check: PTS = 2 x FGM + 3PM + FTM for each row.\n' +
  '- A highlighted (for example yellow) row is a normal player row. Labels like YOU, YOUR MATCHUP, TOTAL, QUIT or CLOSE are not players.\n' +
  '- The large score beside each table on the scoreboard is that table\'s final score and equals its TOTAL PTS.';

export const EXTRACTION_PROMPT =
  'Extract the stats exactly as shown. ' +
  "Preserve gamertags/player names exactly as displayed (including AI player names like 'AI Player', 'CPU', or generic names). " +
  'Include any small icon or symbol that appears immediately before a name (e.g. a circle, or platform logo like PlayStation/Xbox)—do NOT strip these leading symbols; copy the gamertag exactly as shown so the first character may be that icon. ' +
  'Use integers. If a value is blank, use 0. ' +
  'If the screenshot shows specific defensive matchups (which player is guarding which player), ' +
  'extract them in the indicated_matchups array. If no matchups are clearly indicated, ' +
  'set indicated_matchups to null. ' +
  'Platform detection: Look specifically for a small circular icon or platform logo (e.g. PlayStation, Xbox, or a circle/dot) in front of each player name on the scoreboard. ' +
  'If you see such an icon before the names, set metadata.platform_hint to "Console" and metadata.has_platform_icons_before_names to true. ' +
  'If names start with normal text only (no icon), set metadata.platform_hint to "PC" or null and metadata.has_platform_icons_before_names to false. ' +
  'Return only JSON per schema.' +
  LAYOUT;

export function feedbackPrompt(feedback) {
  return `${EXTRACTION_PROMPT}\n\n` +
    'IMPORTANT: The previous extraction had validation errors. Please carefully review and fix:\n' +
    `${feedback.map(e => `- ${e}`).join('\n')}\n\n` +
    'Ensure you extract exactly 10 players (5 per team: AWAY and HOME), each with a unique row_index (0-4) on their team. ' +
    'Make sure all required fields are present and correctly formatted.';
}

export function repairPrompt(instruction, errorMessage) {
  return `${instruction}\n\n` +
    `Previous attempt failed with error: ${errorMessage}. ` +
    'Please ensure the output strictly conforms to the schema.';
}

const STATS = {
  type: 'object',
  properties: Object.fromEntries(['pts', 'reb', 'ast', 'stl', 'blk', 'fouls', 'tov', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta']
    .map(k => [k, { type: 'integer' }])),
  required: ['pts', 'reb', 'ast', 'stl', 'blk', 'fouls', 'tov', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'],
  additionalProperties: false,
};
const QUARTERS = { type: 'array', items: { type: ['integer', 'null'] }, minItems: 4, maxItems: 4 };
const SIDE = { type: 'string', enum: ['AWAY', 'HOME'] };

export const BOX_SCORE_SCHEMA = {
  type: 'object',
  properties: {
    metadata: {
      type: 'object',
      properties: {
        season_label: { type: ['string', 'null'] },
        mode_label: { type: ['string', 'null'] },
        extracted_from: { type: 'string' },
        platform_hint: {
          type: ['string', 'null'],
          description: "Set to 'Console' if you see a small circular icon or platform logo (e.g. PlayStation, Xbox) immediately before player names on the scoreboard; otherwise 'PC' or null",
        },
        has_platform_icons_before_names: {
          type: 'boolean',
          description: 'True if you see a small icon (e.g. circle, platform logo like PlayStation or Xbox) before each player name on the scoreboard',
        },
      },
      required: ['season_label', 'mode_label', 'extracted_from', 'platform_hint', 'has_platform_icons_before_names'],
      additionalProperties: false,
    },
    game: {
      type: 'object',
      properties: {
        away_score: { type: 'integer' },
        home_score: { type: 'integer' },
        quarters: {
          type: 'object',
          properties: { away: QUARTERS, home: QUARTERS },
          required: ['away', 'home'],
          additionalProperties: false,
        },
      },
      required: ['away_score', 'home_score', 'quarters'],
      additionalProperties: false,
    },
    teams: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          side: SIDE,
          header_name: { type: ['string', 'null'], description: "The single name at the left of this table's header row (crew leader or team name). Not a player." },
          grade: { type: ['string', 'null'] },
          totals: STATS,
        },
        required: ['side', 'header_name', 'grade', 'totals'],
        additionalProperties: false,
      },
      minItems: 2,
      maxItems: 2,
    },
    players: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          side: SIDE,
          row_index: { type: 'integer', minimum: 0, maximum: 4 },
          gamertag: { type: 'string' },
          grade: { type: ['string', 'null'] },
          stats: STATS,
        },
        required: ['side', 'row_index', 'gamertag', 'grade', 'stats'],
        additionalProperties: false,
      },
      minItems: 10,
      maxItems: 10,
    },
    indicated_matchups: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          defender_gamertag: { type: 'string' },
          offender_gamertag: { type: 'string' },
          defender_side: SIDE,
          offender_side: SIDE,
        },
        required: ['defender_gamertag', 'offender_gamertag', 'defender_side', 'offender_side'],
        additionalProperties: false,
      },
    },
  },
  required: ['metadata', 'game', 'teams', 'players', 'indicated_matchups'],
  additionalProperties: false,
};

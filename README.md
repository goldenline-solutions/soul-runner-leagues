# Soul Runner NBA 2k27 PC Leagues

The league site, rebuilt on a real database. Same look, same words, same rules as the original
single-file site, but every score, box score, roster and registration is stored once on the server
and shown to everyone.

## Run it locally

Needs Node.js 22.13 or newer.

1. `npm install`
2. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` and `SESSION_SECRET`.
3. `npm start`, then open http://localhost:8787.

With no `DATABASE_URL`, it runs on an embedded Postgres in `data/pglite` (no database server
needed). The first start loads both schedules (Premier: 22 weekends, 132 matchups; Affiliates: 20
weekends, 60 matchups), all 18 teams and the playoff bracket. Set `DATABASE_URL` to work against a
real Postgres database instead.

`npm test` runs the checks: best-of-3 rules, box score validation, registrations, votes, rate limits,
the setup script, and the screenshot pipeline against a fake model server.

## Put it online

See [DEPLOY.md](DEPLOY.md): GitHub repo → Neon Postgres database → Vercel.

## Commissioner workflow

Log in from the footer link ("Commissioner login") or the Upload Results tab.

- **Upload Results**: pick weekend → matchup → game. Then either
  - drop or paste (Ctrl+V) a 2K box score screenshot, or
  - paste stat lines from a spreadsheet or chat, or
  - type them in.

  Check the rows and save. Standings, schedules, stats, box scores and award candidates update
  instantly. Recorded games can be edited or deleted from the same screen. Anyone in the box score
  who isn't on a roster yet goes into the first empty slot (PG → 7th Man) of the team they played
  for; nobody already on a roster is moved or replaced.
- **Team cards** (Premier/Affiliate Teams → pick a team → Update Roster): owner, stream link,
  affiliates and the 7 roster slots. The same dialog uploads the **team logo / mascot** (PNG, JPG or
  WebP, shrunk to 1200 px in the browser, stored in the `team_logos` table). It shows on team cards
  and as the team page banner (a blurred wash plus the logo, fading out on a curve as the page scrolls
  over it; the scroll effect is off for visitors who turn on "reduce motion"). Teams without one get
  initials. Commissioners can also use the banner's "Change logo" button to open the dialog.
- **Sponsors page**: the list lives in `SPONSORS` at the top of the Sponsors section in
  `public/js/views.js`. Add an entry (name, role, logo in `public/`, blurb, link) to list a sponsor.
- **Commissioner's Desk**: the registrations inbox (approving a player adds them to the league),
  posts to Tyreek's Desk, **League Rules** (paste the rules from Discord; Discord formatting is kept
  and shown on the Rules page), **Fill empty roster slots** (the roster autofill, run over every saved
  game), playoff matchups ("Fill quarterfinals from standings"), All-Star details, and
  **Download data backup**.

## Screenshot reading

This is a port of the 2K-app ingest pipeline (`C:\_2K-app\backend\ingest_service.py` and
`openai_client.py`). The prompts and JSON schemas are copied word for word into
`src/ingest-prompts.js`. It works like this:

1. A validation call checks the image is a 5v5 2K box score.
2. An extraction call reads 10 players × 13 stats plus team totals.
3. The parser re-asks once with feedback if player points don't add up.
4. It back-fills missing 3PM.
5. It flags duplicates: the exact same image (SHA-256), or the same players with the same score.

What's different for the league:

- **Nothing saves automatically.** The reading fills the Upload Results form, and the
  commissioner confirms it, because a league game belongs to a specific matchup and game number.
- **Sides are matched by roster.** A screenshot doesn't name teams, so its AWAY/HOME sides are
  matched onto the matchup's teams by roster overlap, then flipped if needed.
- **Names are matched to league players.** The site checks Discord and Steam tags: an exact match
  anywhere in the league first, then a 75% match on the two teams' rosters, then an 88% match
  anywhere (the 2K-app threshold). Two rows never get the same player. Unknown names are flagged,
  and AI players are left out. Nothing is created until you save.
- **Saving matches tags exactly, ignoring case.** A box score name that is a player's Discord tag
  or Steam tag goes to that player; any other name becomes a new player.
- **The same image is never read twice.** Re-uploading it reuses the stored reading, so there's
  no second model charge.
- **Big screenshots are shrunk in the browser** to about 2.4 MB of high-quality JPEG before upload
  (Vercel caps requests at 4.5 MB). Normal 1080p and 1440p box scores upload unchanged.
- **Saved screenshots are public.** Once a game is saved, its screenshot shows as "View the
  original screenshot" on the box score.
- **Quarter checks are softer.** Quarter scores are only checked when all four were read, and a
  short sum is treated as possible overtime instead of triggering a retry.

To turn it on, set `OPENAI_API_KEY` (in `.env` locally, or in the Vercel project settings). Optional settings:

- `OPENAI_MODEL`: defaults to `gpt-5`. `gpt-4o` is faster and cheaper but misreads names and stat rows on crew screenshots.
- `OPENAI_REASONING_EFFORT`: `low` by default (gpt-5 only). `medium` reads a little more carefully but can take 2 to 4 minutes.
- `INGEST_VALIDATE=0`: skips the validation call. Use this if league games get rejected by the
  "Rec box score" check.

Without a key, manual and paste entry still work.

## Discord bot

The bot reads box score screenshots from Discord with the same pipeline as Upload Results. It is
its own process (`npm run bot`) and has to run on an always-on machine: Vercel can't host it.

Set it up once:

1. https://discord.com/developers/applications → **New Application** → **Bot** → **Reset Token**.
   Put the token in `.env` as `DISCORD_TOKEN`. No privileged intents are needed.
2. Set `DISCORD_GUILD_ID` (right-click the server → Copy Server ID) and `SITE_URL` in `.env`.
   Use the same `DATABASE_URL` and `OPENAI_API_KEY` as the site.
3. `npm run bot`. It prints an invite link: open it and add the bot to the server.

Then, in Discord:

- `/boxscore screenshot:<image>` reads an uploaded screenshot.
- Right-click a message with a screenshot → **Apps** → **Read box score**.

The bot replies with both teams' lines and anything to check.

- **It finds the matchup itself.** When each side of the screenshot has at least two players from
  one team's roster, the bot picks the earliest matchup between those two teams that is still being
  played, names the teams and flips the sides if needed.
- **Save as Game N.** With a matchup found, the reply has a Save button. Only members with
  **Manage Server** can press it. If the box score has names the league doesn't know (marked `*`),
  the first press turns the button into "Add N new players and save", because saving creates
  those players; fix a misread name in Upload Results instead.
- **No button** when the bot can't tell the matchup, the series is already decided, or the same
  players and score are already recorded. Save those from Upload Results: the reading is stored,
  so dropping the same image file there reuses it with no second model call (unless the site had
  to shrink it first).

Both commands start limited to members with **Manage Server**; change who can use them in Server
Settings → Integrations.

**Keeping it running.** On the league server the bot runs under pm2 as `soulrunner-bot` and comes
back after a reboot with the rest of the pm2 list. After changing bot code: `pm2 restart soulrunner-bot`.
Logs: `pm2 logs soulrunner-bot`. Don't also start `npm run bot` in a terminal: two copies would
both answer.

New bot features go in `bot/` as a file exporting `{ commands, names, handle }`, added to
`FEATURES` in `bot/index.js`. A feature with buttons or forms also exports `prefix` (the start of
its component ids), and one that needs a timer exports `start(client, ctx)`.

## Scrim queue

Teams mark themselves ready, the queue pairs them, and the bot opens a private thread where they
swap gamertags and set the game up themselves. Nothing touches NBA 2K. The bot and the site share
one queue: both call `src/scrim.js`, and all of it lives in the database.

Set it up once:

1. In `.env`, set `SCRIM_QUEUE_CHANNEL_ID` (the `#scrim-queue` channel) and `SCRIM_ADMIN_ROLE_ID`
   (pinged on disputes; make the role mentionable).
2. Restart the bot and re-invite it with the link it prints. It now asks for: View Channel, Send
   Messages, Embed Links, Pin Messages, Create Private Threads, Send Messages in Threads, Manage Threads.
3. For browser login, set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, and add the redirect
   `SITE_URL/api/auth/discord/callback` in the developer portal under OAuth2.
4. Name the captains: `/team captain team:<team> user:<member>`. Only captains can queue, accept,
   host, report, confirm or dispute. A person is on one team; a team can have several captains.

The bot posts one pinned message in the queue channel and edits it when the queue changes. Its
**Join Queue** button opens a form for mode, size and minutes.

| Command | Who | What it does |
| --- | --- | --- |
| `/queue join [mode] [size] [minutes_available] [skill_min] [skill_max]` | captain | Queues the team. Defaults: scrim, 5v5, 60 minutes. |
| `/queue leave` | captain | Cancels the waiting entry. |
| `/queue status` | team member | The team's entry or current match. |
| `/queue list` | anyone | Who is waiting: team, mode, size, how long. Never ratings. |
| `/match accept`, `/match decline` | captain | Answer a new match (also buttons on the match card). |
| `/match host team:<mine or theirs>` | captain | Records who hosts the lobby. |
| `/match report score_a score_b screenshot` | captain | Reports the score. `score_a` is the first team on the match card. |
| `/match confirm` | other captain | Confirms the reported result (also a button; a commissioner can press it too). |
| `/match dispute` | captain | Marks the match disputed and pings the admin role. |
| `/team captain`, `/team add`, `/team remove`, `/team disband` | Manage Server | Who is on which team. |
| `/team testopponent [mode] [size]` | Manage Server | Testing: queues a fake opponent that never answers. |

Match lifecycle:

1. **Queue.** An entry waits until its window ends (`expired`) or the captain leaves (`cancelled`).
2. **Matcher** (`runMatcher` in `src/scrim.js`). Runs on every join and every 30 seconds in the bot.
   Oldest entry first, it takes the oldest other entry with the same mode and size whose skill
   window overlaps. Both entries become `matched`.
3. **`pending_accept`.** The bot opens a private thread for both teams' members and posts the match
   card. Both captains have 5 minutes.
   - Both accept → `accepted`.
   - One declines → `cancelled`. The decliner leaves the queue; the other team goes back in line.
   - Time runs out → `cancelled`. A team that accepted goes back in line; a team that never
     answered leaves the queue.
4. **`accepted` → `in_progress`** once a captain records the host. This step can be skipped.
5. **`awaiting_result`** after `/match report`. The screenshot is stored in the `screenshots` table.
   For 5v5, with `OPENAI_API_KEY` set, it is also read and a score that doesn't match is flagged.
6. **`completed`** when the other captain confirms. The thread is archived 24 hours later.
7. **`disputed`** at any point after both accepted. Both teams can queue again; a commissioner
   settles it in the thread.

A team can't queue while it has a match in steps 3 to 5. If a team loses its last captain or is
disbanded, its entry is cancelled, its match is cancelled, and the opponent goes back in line.

**Scrim stats.** When a 5v5 result is reported and the screenshot's score agrees with the reported
score, each human player's line is saved to `scrim_box_scores` (match, team, name, the 13 stats,
and the league player when the name matched one). This is a separate table from the league's
`box_scores`, so scrims never touch standings, league stats or awards, and no players are created.
A score that disagrees is flagged in the reply and saves no lines. 3v3 results, and servers
without `OPENAI_API_KEY`, save the score and screenshot only. Nothing on the site shows these
stats yet. Count a row only when its match is `completed`:

```sql
SELECT b.name, COUNT(*) AS games, SUM(b.pts) AS pts
FROM scrim_box_scores b JOIN matches m ON m.id = b.match_id
WHERE m.status = 'completed' GROUP BY b.name ORDER BY pts DESC;
```

**Testing alone.** One person can't captain two teams, so `/team testopponent [mode] [size]`
(Manage Server) queues a team that has no members under a made-up captain. Join the queue from
your own team with the same mode and size: the thread opens, the match card appears, and you can
accept. Nobody answers for the other side, so the match cancels after 5 minutes and your team goes
back in line. `/team disband` on the stand-in team cleans it up.

`teams.skill_rating` starts at 1000 and nothing changes it yet. The place to add a rating change
for ranked results is marked `RATING HOOK` in `confirmResult` in `src/scrim.js`.

Site API (JSON; writes need a Discord login cookie from `GET /api/auth/discord`):

| Route | What it does |
| --- | --- |
| `GET /api/me` | The logged-in Discord user, their team, entry and match. |
| `GET /api/queue` | The live queue. |
| `POST /api/queue` | Join. Body: `mode`, `team_size`, `minutes`, `skill_min`, `skill_max` (all optional). |
| `DELETE /api/queue` | Leave. |
| `GET /api/matches`, `GET /api/matches/:id` | Recent matches with status and result. |
| `POST /api/matches/accept`, `/decline`, `/confirm`, `/dispute` | Act on your team's current match. |
| `POST /api/matches/host` | Body: `team_id`. |
| `POST /api/matches/report` | Body: `score_a`, `score_b`, `image` (a data URL). |
| `POST /api/admin/matches/:id/confirm` | Commissioner login: confirm any reported result. |

A match made from the site gets its Discord thread on the bot's next 30 second tick. The 5 minute
accept timeout also runs in the bot, so the bot has to be running for the queue to work fully.

## Solo queue

Players without a team queue alone and get placed by position. Separate from the scrim queue:
its own tables (`solo_queue_entries`, `solo_matches`), its own channel, its own `/solo` command.
Discord only; the site has no solo endpoints, because positions come from Discord roles.

**Setup**

1. Create five roles in the server named exactly `PG`, `SG`, `LOCK`, `BACKEND` and `C` (case does
   not matter). A player's positions are the ones of these roles they hold; they can hold several.
2. Set `SOLO_QUEUE_CHANNEL_ID` in `.env` to the channel for the pinned live message and the private
   match threads. Use a different channel from `SCRIM_QUEUE_CHANNEL_ID`.
3. Restart the bot.

| Command | Who | What |
| --- | --- | --- |
| `/solo join [minutes_available]` | Anyone with a position role | Join the line. Also the **Join Solo Queue** button. |
| `/solo leave`, `/solo status` | Players | Leave, or see your place or your match. |
| `/solo accept`, `/solo decline` | Players in a match | Also buttons on the match card. |
| `/solo report winner screenshot` | Any of the ten | Ends the game; score and stats are read from the screenshot. Also the **Team A won** / **Team B won** buttons. No second confirmation. |
| `/solo cancel` | Manage Server | Run in a match thread to call that match off. |
| `/solo testfill` | Manage Server | Testing: adds 9 fake players that never accept. |

**How a game forms** (`seatGame` and `runMatcher` in `src/solo.js`)

1. The matcher runs on every join and every 30 seconds. It walks the line, longest wait first, and
   fills ten seats: two per position. A seated player can be moved to another position they play
   to make room for someone, but is never pushed out of the game.
2. When all ten seats fill, the first player found for a position is on Team A, the second on
   Team B. The ten get a private thread with the rosters and Accept / Decline buttons.
3. All ten accept within 5 minutes: the game is on. A decline cancels it and puts the other nine
   back in line. A timeout puts the players who accepted back in line and drops the rest.
4. The thread gets a result card with **Team A won** and **Team B won** buttons. Anyone in the game
   presses the right one and uploads the final box score screenshot; nobody types a score. A game
   with no report is closed after 3 hours, so the players can queue again. The thread is archived
   24 hours after the result.

**Solo results and stats.** The score and each human player's line are read from the screenshot by
the same reader as league games, so reporting needs `OPENAI_API_KEY`. A screenshot names no teams,
which is why the reporter says who won: the side with the higher score is that team. The score goes
on `solo_matches`, the lines into `solo_box_scores` with `side` A or B. A screenshot that can't be
read is refused and the game stays open for another upload. Nothing is written to `box_scores`,
`players` or `scrim_box_scores`, and nothing shows on the site yet. Rows hold the name as read from
the screenshot, not the Discord account, because nothing links gamertags to Discord users yet.

```sql
SELECT name, COUNT(*) AS games, SUM(pts) AS pts, SUM(reb) AS reb, SUM(ast) AS ast
FROM solo_box_scores GROUP BY name ORDER BY pts DESC;
```

Teams are not balanced by skill: there are no player ratings yet. The place to do it is marked
`BALANCE HOOK` in `runMatcher`.

**Testing alone:** give yourself a position role, run `/solo testfill`, then `/solo join`. The
thread and match card appear within 30 seconds; the match cancels 5 minutes later.

## Data and backups

- Everything lives in PostgreSQL, including saved screenshots (stored in the `screenshots` table).
- `npm run db:backup` saves all league tables to `backups/`. **Download data backup** in the
  Commissioner's Desk gives the same file.
- Schema changes go in `migrations/` as numbered `.sql` files. Apply them with `npm run db:setup`
  (local runs apply them on start). Then run `npm run db:sql` to refresh `db/setup.sql`.

| Command | What it does |
| --- | --- |
| `npm run db:setup` | Creates tables and loads Season 1 on an empty database; applies new migrations on an existing one. Safe to re-run. |
| `npm run db:sql` | Regenerates `db/setup.sql`, the same setup as one script to paste into a SQL console. |
| `npm run db:backup` | Writes a JSON backup of every league table to `backups/`. |

## Layout

```
api/index.js           Vercel function: every /api/* request
server.js              local server: the API plus the static site
vercel.json            Vercel routing, headers, function timeout
src/app.js             routes and request handling (shared by both)
src/db.js, db-local.js Postgres access; embedded Postgres for local runs and tests
src/seed.js            Season 1 data as SQL
src/league.js          best-of-3 rules, box score validation, saving games
src/api.js             everything else the pages read and write
src/auth.js            commissioner login cookie, one-vote-per-browser id
src/ingest*.js         screenshot reading
src/scrim.js           scrim queue: join/leave, the matcher, accept, report, confirm
src/solo.js            solo queue: position seating, accept, report
src/discord-oauth.js   "Log in with Discord" for the site
bot/                   Discord bot: index.js (startup, routing), boxscore.js (screenshot reading), scrim.js (scrim queue), solo.js (solo queue)
migrations/            schema, applied in order
db/setup.sql           whole database in one script (generated)
scripts/               db:setup, db:sql, db:backup
public/                the site (styles.css holds the whole design; fonts/ are self-hosted, OFL licensed)
seed/schedule.json     both schedules, extracted from the original HTML
```

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
  instantly. Recorded games can be edited or deleted from the same screen.
- **Team cards** (Premier/Affiliate Teams → pick a team → Update Roster): owner, stream link,
  sponsors, affiliates and the 7 roster slots.
- **Commissioner's Desk**: the registrations inbox (approving a player adds them to the league),
  posts to Tyreek's Desk, playoff matchups ("Fill quarterfinals from standings"), All-Star details,
  and **Download data backup**.

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
migrations/            schema, applied in order
db/setup.sql           whole database in one script (generated)
scripts/               db:setup, db:sql, db:backup
public/                the site (styles.css holds the whole design; fonts/ are self-hosted, OFL licensed)
seed/schedule.json     both schedules, extracted from the original HTML
```

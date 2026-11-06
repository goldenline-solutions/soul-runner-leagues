# Putting the site online

GitHub holds the code, Neon holds the data (PostgreSQL), and Vercel serves the site and runs the
API. Total time is about 20 minutes. Commands are for PowerShell on Windows, run from this folder
(`C:\_SoulRunner\site`).

## 1. Push the code to GitHub (second account)

1. Sign in to github.com **as the second account** and create an empty repository (no README, no
   .gitignore), for example `soul-runner-leagues`. Private is fine.
2. Point this folder at that account and repository. The `config` lines only affect this repo:

   ```powershell
   git config user.name "SECOND-ACCOUNT-NAME"
   git config user.email "second-account@email.com"
   git add -A
   git commit -m "Soul Runner league site"
   git remote add origin https://SECOND-USERNAME@github.com/SECOND-USERNAME/soul-runner-leagues.git
   git push -u origin main
   ```

   Putting the username in the remote URL makes Git Credential Manager open a browser login for
   **that** account and save it separately, so your main account keeps working in other repos.
   If it pushes as the wrong account, clear the saved login and push again:

   ```powershell
   cmdkey /delete:git:https://SECOND-USERNAME@github.com
   ```

## 2. Create the Vercel project

1. vercel.com → **Add New → Project** → import the repository. Signing in to Vercel with the second
   GitHub account gives it access to the repo.
2. Leave every build setting as detected (`vercel.json` sets them) → **Deploy**. The pages load, but
   the data won't until the database exists.

## 3. Create the database

1. In the Vercel project: **Storage → Create Database → Neon (Serverless Postgres)** → pick a region
   close to the Vercel function region (default `iad1`, US East) → connect it to the project.
   Vercel adds `DATABASE_URL` to the project's environment variables automatically.
2. Load the schema and Season 1 into it. Pick one of these:
   - **From this computer:** copy `DATABASE_URL` from the Storage tab (**.env.local → Show secret**),
     then:

     ```powershell
     npm install
     $env:DATABASE_URL = "postgresql://...paste..."
     npm run db:setup
     ```

     It should end with `18 teams, 42 weeks, 199 matchups`.
   - **From the browser:** Storage → **Open in Neon → SQL Editor**, paste all of `db/setup.sql`, run it.

(Not using Vercel's Storage tab? Any Postgres works: create a project at neon.tech or supabase.com,
copy its connection string, and add it yourself as `DATABASE_URL` in step 4.)

## 4. Add the settings

Vercel project → **Settings → Environment Variables**, for Production (and Preview if you use it):

| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD` | the commissioner password |
| `SESSION_SECRET` | a long random string; make one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OPENAI_API_KEY` | your OpenAI key (screenshot reading) |
| `OPENAI_MODEL` | optional, defaults to `gpt-4o` |
| `INGEST_VALIDATE` | optional, `0` skips the "is this a 2K box score?" check |
| `DATABASE_URL` | already there if you used the Storage tab |

Then **Deployments → ⋯ on the latest → Redeploy** so the function picks them up.

## 5. Check it

1. Open the site: the Premier schedule shows 22 weekends.
2. Footer → **Commissioner login** with `ADMIN_PASSWORD`.
3. Upload Results → record a test game → check Standings → delete it.

## Later changes

- **Code:** `git push`. Vercel redeploys on every push to `main`.
- **Schema:** add `migrations/0003_something.sql`, run `npm run db:setup` against `DATABASE_URL`
  **before** pushing code that needs it, then `npm run db:sql` to refresh `db/setup.sql`.
- **Backups:** `npm run db:backup` with `DATABASE_URL` set, or **Download data backup** in the
  Commissioner's Desk. Neon also keeps point-in-time history (length depends on your plan).
- **Own domain:** Vercel project → Settings → Domains.
- Vercel's free Hobby plan is for non-commercial use. If sponsorship money flows through the site,
  check whether you need the Pro plan.

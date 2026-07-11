# Hosting the app (H1: invite-only alpha)

This repo now runs in two modes from the same code:

- **Local-first** (unchanged): `npm run dev:server` + `npm run dev:web`, everything on your machine.
- **Hosted**: browser on Vercel, control plane on Supabase (auth + Postgres + Storage + Realtime), the pipeline on a Trigger.dev worker. A build of the web app with `VITE_SUPABASE_URL` set is a hosted build; without it, it is the local app.

```
Browser (Vercel)
  -> sign in (Supabase Auth, magic link, invite-only)
  -> upload photos to Storage bucket `photos` (own folder only, RLS)
  -> POST edge function `start-run`  -> enqueues Trigger.dev task `generate-tour`
  -> subscribes to `run_events` rows (Realtime) for live progress
Worker (Trigger.dev)
  -> downloads photos to scratch disk, runs the unmodified pipeline
  -> mirrors every checkpoint to Postgres (`projects`) + Storage (`projects` bucket)
  -> final row: complete (with storage:// video keys) or run-error
Browser
  -> signs short-lived URLs for the finished MP4s, plays + downloads
```

Costs on your accounts: Higgsfield ~5 credits/clip (DoP), Anthropic vision+audit, Supabase free tier or Pro ($25/mo), Trigger.dev free tier to start, Vercel free.

## One-time setup (about 30-45 minutes)

### 1. Supabase (~10 min)

1. Create a project at [database.new](https://database.new). Note the **Project URL**, **anon key**, **service_role key** (Settings -> API), and **project ref** (the subdomain).
2. Link and push the schema from this repo:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push          # applies supabase/migrations/0001_init.sql
   ```
3. Make it invite-only: Dashboard -> Authentication -> Sign In / Providers -> Email -> turn **off** "Allow new users to sign up". Invite testers from Authentication -> Users -> "Invite user".
4. Deploy the edge functions and give them the Trigger.dev key (created in step 2, so come back for the secret):
   ```bash
   npx supabase functions deploy start-run resume-run
   npx supabase secrets set TRIGGER_SECRET_KEY=tr_prod_xxx
   ```

### 2. Trigger.dev (~10 min)

1. Create a project at [cloud.trigger.dev](https://cloud.trigger.dev). Note the **project ref** (`proj_...`) and the **prod secret key** (`tr_prod_...`, API Keys page).
2. Set the worker's environment variables in the Trigger.dev dashboard (Project -> Environment Variables, prod):
   - `ANTHROPIC_API_KEY` (vision + fidelity audit)
   - `HIGGSFIELD_API_KEY` (clips; format `keyId:secret`)
   - `HIGGSFIELD_MODEL` / `HIGGSFIELD_MOTION_STRENGTH` (optional, same as local)
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (from step 1)
3. Deploy the worker:
   ```bash
   cd apps/worker
   TRIGGER_PROJECT_REF=proj_xxx npx trigger.dev@latest deploy
   ```
   (First run may ask you to log in. `npx trigger.dev@latest dev` runs it locally against your machine for testing.)

### 3. Vercel (~5 min)

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `apps/web` and enable "Include source files outside of the Root Directory" (monorepo).
3. Add environment variables:
   - `VITE_SUPABASE_URL` = the project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon key
4. Deploy. Every push to `main` now auto-deploys the frontend.

### 4. Auto-deploy for the backend (optional, ~5 min)

`.github/workflows/deploy-hosted.yml` deploys the worker + edge functions on push, but stays **inert** until you:

1. Add repo secrets: `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`.
2. Add a repo **variable** `ENABLE_HOSTED_DEPLOY` = `true`.

Until then, deploy manually with the commands above.

## Smoke test

1. Invite yourself in Supabase, open the Vercel URL, sign in via the emailed link.
2. Drop 10+ real photos, pick 30s, Generate.
3. Watch live progress (vision -> storyboard -> clips -> fidelity -> render). A real run takes ~15-30 min.
4. The result card plays the tour and downloads both MP4s (16:9 + 9:16).
5. If a run fails midway, the error card's Resume button re-enqueues from the last checkpoint; finished clips are pulled from storage, never re-billed.

## H1 limitations (deliberate)

- **No storyboard review hosted** (runs go straight through; the review UI stays local-only for now). The review checkbox is hidden in hosted builds.
- **No billing**: your API keys pay for every run. Do not invite strangers beyond people you trust; there are no per-user quotas yet (H2).
- **No demo mode hosted**: real photos required.
- **Higgsfield concurrency**: the account allows 2 concurrent generation jobs, so two users generating at once will queue. One-customer ceiling until the plan is upgraded.

## Env var matrix

| Where | Vars |
|---|---|
| Trigger.dev (worker) | `ANTHROPIC_API_KEY`, `HIGGSFIELD_API_KEY`, `HIGGSFIELD_MODEL?`, `HIGGSFIELD_MOTION_STRENGTH?`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Supabase edge functions | `TRIGGER_SECRET_KEY` (via `supabase secrets set`; `SUPABASE_URL`/`SUPABASE_ANON_KEY` are auto-injected) |
| Vercel (web) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| GitHub Actions (optional) | `TRIGGER_ACCESS_TOKEN`, `TRIGGER_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` + variable `ENABLE_HOSTED_DEPLOY=true` |
| Local dev (unchanged) | `.env`: `ANTHROPIC_API_KEY`, `HIGGSFIELD_API_KEY`, optional tuning |

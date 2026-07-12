# Real Estate Cinematic Video Generator

> **Read this first every session.** This file is the single source of truth for vision,
> architecture, security requirements, standards, status, and roadmap. A full engineering audit
> (2026-07-11, commit `c6ec6d5`) lives in **AUDIT.md**; its priorities are mirrored in the
> roadmap below. Update both as the project evolves. Do not use em dashes in any writing here or
> elsewhere in this project (user preference).

## 1. Vision and product shape

Turn 10-40 property photos into one cinematic real-estate tour video with almost no user input:
drag photos in, pick 30/45/60s, click Generate. The pipeline classifies every photo (room type,
quality), orders a logical house tour, writes fidelity-constrained motion prompts, animates each
photo via Higgsfield image-to-video, audits every clip against its source photo so fabrications
never ship, and stitches a crossfaded, exactly-timed 1080p MP4 (plus a 9:16 vertical cut and
optional agent branding).

Two delivery modes, one codebase:

- **Local-first** (the original): browser UI + local Node server, user's own API keys, files on
  disk. This is the dev/verification environment and the future Tauri desktop product.
- **Hosted multi-user** (H1 alpha, built 2026-07): Vercel web + Supabase control plane
  (auth/Postgres/Storage/Realtime) + Trigger.dev worker running the same pipeline. Invite-only,
  owner's keys, no billing yet. Setup checklist: **HOSTING.md**. Business scoping (stacks,
  unit economics ~$4-7 COGS per 30s tour on DoP, BYOK alternative):
  claude.ai/code/artifact/fc5a4ff3-3dea-4972-9df2-5243a2067ba0.

The moat features: honest-by-construction video (fidelity audit), zero-input storyboarding, and
review-before-spend.

## 2. Current status (2026-07-11)

Working and verified end to end: upload (EXIF-normalize), Claude vision classification,
rule-based storyboard with exact pacing, fidelity-first prompts, Higgsfield DoP v2 generation at
motion strength 0.3 (Seedance native-1080p opt-in), Claude per-clip fidelity audit (drift =>
clip dropped + regenerated on resume), FFmpeg render with branding cards/watermark + lanczos
sharpening + 9:16 vertical, storyboard review screen (local), checkpointed resume that never
re-bills a finished clip, live progress (SSE local / Realtime hosted), in-app preview + download.
**67 unit tests** (node:test via tsx), typecheck clean across packages, server, worker, web.

Real artifacts produced: `projects/real-tour/tour.mp4` (first real tour), prototype clips under
`projects/prototype/`. Higgsfield credits are real money: see 6.3 before touching videogen.

Hosted H1 status: all repo-side code complete and unit-tested, **including the four P0 spend/abuse
gates** (per-user run caps, global execution serialization, worker key fail-fast, storage caps;
built 2026-07-12). **Live E2E pends account creation** (Supabase/Trigger.dev/Vercel, HOSTING.md).

## 3. Architecture

### 3.1 The pipeline

Independent engines enrich one shared `Project` document. The orchestrator reads each engine's
input slice, calls it, writes the result back, persists a checkpoint, emits progress. Engines
never call each other.

```
Upload -> Vision -> Storyboard -> Prompt -> VideoGen -> Fidelity -> Render -> MP4 (+9:16)
(sharp)   (Claude)  (rule-based)  (template) (Higgsfield) (Claude)   (FFmpeg)
```

| Engine | Input -> Output | Real impl | Notes |
|---|---|---|---|
| Upload | `UploadRequest` -> `Asset[]` | `upload:local` (sharp) | EXIF-rotate, normalize JPEG q92, true dims, 320px thumbs |
| Vision | `Asset[]` -> `VisionResult[]` | `vision:claude` | structured outputs, <=1280px, concurrency 4, per-image fallback |
| Storyboard | `{assets,vision,target}` -> `Shot[]` | `storyboard:rule-based` | quality floor, coverage-first selection, exact pacing |
| Prompt | `{shots,vision}` -> `Shot[]` | `prompt:template` | fidelity-first: no scene description, neutral moves |
| VideoGen | `{shots,assets}` -> `Shot[]` | `videogen:higgsfield` | DoP v2 + strength lever; Seedance opt-in |
| Fidelity | `{shots,assets}` -> `Shot[]` | `fidelity:claude` | frame audit vs source; drift => shot 'failed'; fail-open |
| Render | `{shots,outputPath,branding?}` -> `RenderResult` | `render:ffmpeg` | xfade chain, cards, watermark, vertical |

Fidelity runs inside the videogen checkpoint (no extra stage); render skips non-'done' shots, so
a dropped clip means a shorter honest tour, never a crash.

Engine contract (`@rev/core`):
```ts
interface Engine<TIn, TOut> { readonly name: string; process(input: TIn, ctx: EngineContext): Promise<TOut>; }
// EngineContext = { workDir, config, logger, progress(pct, msg) }
```

`Project` carries `assets`, `vision`, `shots`, `branding?`, `outputPath`, `verticalPath?`,
`stage`, `lastError?`. `stage` is a **checkpoint**: it advances only when that stage's output is
on disk. `nextStage()` maps any saved project to the first stage still to run; resume skips
finished work and, within videogen, keeps shots whose clips exist (never re-pay). Failure keeps
the stage and records `lastError`. Not resumable: stage 'created'. Upload is never re-run;
`workDir/source/` is the durable artifact.

### 3.2 Repository layout

```
packages/
  core/              Project model, Engine contract, config, logger, ids, SSE wire types (events.ts)
  engine-upload/     sharp normalize (+ MIN/MAX_PHOTOS constants)
  engine-vision/     Claude structured-output classification
  engine-storyboard/ selection + paceDurations (also used by review re-pacing)
  engine-prompt/     fidelity-first prompt composer (templates.ts)
  engine-videogen/   Higgsfield client (DoP v2 + Seedance), MOTION_IDS catalog map
  engine-fidelity/   frame audit (claude.ts, frames.ts ffmpeg sampling)
  engine-render/     ffmpeg graph builder, cards.ts (SVG->PNG branding), vertical derivation
  orchestrator/      runPipeline/resumePipeline, persistence, onCheckpoint mirror hook
  hosted/            Supabase adapters: project store (JSONB), blob store, progress sink,
                     run ledger (spend-cap bookkeeping), rebaseProjectPaths + ArtifactSync
apps/
  server/            Fastify 127.0.0.1:3001, REST + SSE, in-memory RunRegistry w/ replay
  web/               React 19 + Vite + Tailwind v4 (5173, /api proxied). Hosted mode switches on
                     via VITE_SUPABASE_URL (SignIn, storage upload, Realtime watch)
  worker/            Trigger.dev task `generate-tour` (hostedRun.ts glue); retries disabled
supabase/            migrations/ (0001 schema/RLS/buckets, 0002 runs ledger + storage caps) +
                     Deno edge functions start-run / resume-run + _shared/ (runs.ts pure gate is
                     Node-tested; enqueue.ts is Deno-only). Deno files are NOT in root tsconfig.
scripts/             demo, analyze, storyboard-preview, render, smoke/prototype/audit tools
projects/<id>/       per-run working dir: source/ thumbs/ clips/ branding/ output/ project.json (gitignored)
AUDIT.md             full 2026-07-11 engineering audit  ·  HOSTING.md hosted setup checklist
```

### 3.3 Hosted mode (H1) data flow

Browser signs in (magic link, signups disabled = invite-only) -> uploads photos directly to the
`photos` bucket under `<uid>/...` (storage RLS enforces the prefix) -> `start-run` edge function
validates counts/ownership and triggers the Trigger.dev task -> worker downloads inputs to a
scratch dir, runs the unmodified pipeline, mirrors every checkpoint (`onCheckpoint`) to the
`projects` table (whole Project as JSONB + promoted columns) and artifacts to the `projects`
bucket (`ArtifactSync.push`) -> progress rows in `run_events` (browser: select for replay +
Realtime for live tail) -> terminal `complete` event carries `storage://` keys the browser swaps
for short-lived signed URLs. Resume: `resume-run` edge fn -> worker hydrates the row, rebases all
absolute paths onto its scratch dir (`rebaseProjectPaths`), pulls sources/kept clips, resumes.
Hosted has no review flow and no demo mode yet (see roadmap #7/#8).

## 4. Engineering principles

1. **Engines are pure, narrow, swappable.** New domain logic lands in `packages/`, never directly
   in `apps/server` or `apps/worker`. The apps are transports.
2. **Checkpoints are sacred.** A stage advances only when its output is durable. Anything that
   weakens resume semantics is a regression, no matter what it improves.
3. **Money-safety invariants** (enforced in code and tests, keep them that way):
   a billed Higgsfield job is never resubmitted (submit/poll retry split); finished clips are
   never regenerated (resume keeps them); whole-task retries are disabled hosted; the fidelity
   audit fails open (an audit error never destroys a paid clip).
4. **Fidelity over spectacle.** The product must not misrepresent the property. Prompts carry no
   scene description and no directional targets; the platform prompt-enhancer stays off; motion
   strength stays low on DoP; every clip is audited. A dropped clip beats a shipped fabrication.
5. **Fail per-item, not per-run.** One bad photo/clip degrades output; it does not crash the run.
6. **Verify live before trusting a vendor claim.** The Higgsfield knowledge in 6.3 exists because
   probing found the docs wrong or silent (data-URI rejection, `prompts` array trap, fake motion
   support). Prototype one clip before any schema change ships.
7. **Two modes, one truth.** Wire types live in `@rev/core/events.ts`. Domain math (pacing,
   review) must have exactly one implementation.

## 5. Security requirements

Posture verified by the audit; keep these true:

- Local server binds `127.0.0.1` only. No CORS is configured on it (the Vite proxy makes the
  browser same-origin); do not add permissive CORS.
- All process spawning is `spawn(bin, argsArray)` with no shell. User text never enters a filter
  graph or command string. SVG card text is XML-escaped (test-covered).
- Uploads: validated by parsing (sharp re-encode), never by MIME/extension; multipart caps
  (40 files, 30 MB each); temp dirs removed in `finally`; sharp's default pixel limit stays on.
- Secrets: `.env` is gitignored (never committed; audit-verified). Keys are never logged. Hosted
  keys live on the services (Trigger.dev env, Supabase secrets, Vercel env), never in the repo.
- Hosted: every table and bucket has owner-scoped RLS; edge functions derive identity from the
  verified JWT only; the worker uses the service role but re-checks project ownership; users
  never receive service credentials; artifacts are served via short-lived signed URLs.
- Path handling: project ids validated `/^[\w-]+$/`; filenames pass `basename()` + allowlist;
  storage paths validated against the caller's own prefix.
- Hosted spend/abuse gates are DONE (roadmap P0 1-4): per-user run caps + daily cap enforced by
  the service-role `runs` ledger (users cannot forge it); global task concurrency 1; worker key
  fail-fast; photos bucket 30 MB / image-only. Still open: local CSRF hardening (#5).

## 6. Operational knowledge (hard-won, keep current)

### 6.1 External services and keys

- `ANTHROPIC_API_KEY` (.env): vision + fidelity. Claude SDK >= 0.110 for `output_config` typings.
  Model: `claude-opus-4-8` for both (cost-tiering to Sonnet/Haiku is roadmap #10 adjacent).
- `HIGGSFIELD_API_KEY` (.env): format `keyId:secret` from **cloud.higgsfield.ai** /api-keys
  (separate credit pool from the consumer MCP subscription). ~5 credits per DoP clip; plan allows
  **2 concurrent jobs** (observed live; a real multi-user ceiling).
- Optional: `HIGGSFIELD_MODEL` = dop-turbo | dop-lite | dop-preview (720p, strength lever) |
  seedance_pro | seedance_lite (native 1080p, ~3.5x cost, prompt-driven camera).
  `HIGGSFIELD_MOTION_STRENGTH` (0..1, default 0.3, DoP only). `FFMPEG_PATH` overrides
  ffmpeg-static everywhere (hosted workers get it from Trigger.dev's ffmpeg extension).
- FFmpeg via `ffmpeg-static`, spawned directly (never fluent-ffmpeg).

### 6.2 Fidelity system (why the product is trustworthy)

Root cause of hallucination (found live): i2v models synthesize pixels for any area a camera move
reveals; translational moves toward a prompt-named target fabricate that target (the invented
dining table). Levers, all live:
1. Prompts carry **no scene description** and only neutral **non-directional** moves
   (`safeMovePhrase`, hard `FIDELITY_CONSTRAINT` appended to every prompt). Vision free-text
   never reaches the prompt (it picks the motion preset only).
2. `enhance_prompt: false` on every submit (schema-validated on v2).
3. **Motion strength 0.3** on DoP (less travel = less invented geometry). Verified on the
   originally-hallucinating photo.
4. **Audit backstop** (`fidelity:claude`): 4 frames/clip (anchor near t=0 + 3 across the back
   half, <=1568px) vs the source photo; materiality rubric (people/added furniture/layout/
   contradicting reveals = drift; softness/lighting/text-morph/plausible sliver continuations =
   fine). Drift => shot 'failed' => skipped in render, regenerated on resume (`fidelityChecked`
   flag skips re-audits of kept clips; regenerated shots shed it). FAIL-OPEN on audit errors.
   Verified catching a real invented fixture and a real invented person. Auditor bias is strict;
   FP rate unmeasured (roadmap #10). A Ken Burns fallback was tried and removed (quality).

### 6.3 Higgsfield platform API (probed live 2026-07; docs are incomplete)

- Auth header: `Authorization: Key <keyId>:<secret>`.
- **Image input is never a data URI** (422 url_too_long, 2083-char cap). Flow:
  `POST /files/generate-upload-url {content_type}` -> `{upload_url, public_url}` -> `PUT` bytes
  -> submit `public_url`.
- **DoP v2**: `POST /v1/image2video/dop` `{ params: { prompt, input_images:[{type:'image_url',
  image_url}], model: dop-lite|dop-preview|dop-turbo (default turbo), motions:[{id:UUID,
  strength:0..1}], seed?, enhance_prompt } }` -> job-set `{id, jobs:[...]}`. No duration param
  (~5s clips, 1280x720@30 fixed; no resolution params exist). Motion catalog:
  `GET /v1/motions` (121 presets, stable UUIDs, mapped in `MOTION_IDS`). Poll via the legacy
  `GET /requests/{id}/status` (accepts v2 ids) -> `{status, video.url}`; also
  `GET /v1/job-sets/{id}`. Schema discovery trick: FastAPI 422 errors enumerate fields when you
  POST empty/wrong-typed bodies.
- **Seedance** (`/v1/image2video/seedance`): `{ params: { prompts: string[] (a bare `prompt` is
  SILENTLY DROPPED; the promptless clip invented a person), input_image:{...} (singular),
  model: seedance_pro|seedance_lite, resolution:'480'|'720'|'1080', duration:3..12,
  aspect_ratio:'16:9'|'9:16'|..., camera_fixed:bool (DEFAULT TRUE; false lets the camera carry
  motion), motion_id: rejected for every catalog UUID ("Motion not found"), enhance_prompt } }`.
  Output 1920x1088@24, ~69s/clip, visibly crisper. Camera move rides in the prompt text.
- Kling (`kling-v2-1[-master]`, duration 5|10) and Minimax (resolution up to 1080, duration 6|10)
  exist at `/v1/image2video/{kling,minimax}`; schemas probed, never run.
- **No video-upscale model exists on the API-key pool** (probed every plausible route);
  `upscale_video` is consumer-MCP only.
- Latency: DoP ~5 min/clip typical, ~16 min observed under load (maxPollMs 20 min); 7-photo tour
  = 13.2 min wall. Retry split: obtaining a request id is retryable; poll/download is never
  retried (billing).

### 6.4 Render facts

Normalize chain: lanczos scale + pad + `unsharp=5:5:0.30` (720p sources stay crisp at 1080p),
fps=30, settb, trim to shot duration; chained `xfade` (offset_k = sum(dur) - k*xfade); H.264
CRF19 `+faststart`. Branding: title card (address) + end card (agent/contact/logo) as sharp
SVG->PNG looped image inputs in the same chain (CARD_SEC=3 each, so a 30s tour ships 34.5s);
55%-opacity corner watermark timeline-enabled over the tour segment only; logo copied to
`workDir/branding/` at run start (`adoptBranding`) so resume never needs upload temp dirs.
Vertical 9:16 always derived from the finished master (blur-pad gblur=24 + slight darken).

### 6.5 Server API (local, stable shape)

- `GET /api/health` -> `{ok, service, engines:{vision, videogen, fidelity}}` (key-gated impls).
- `POST /api/runs`: multipart (10-40 `photos`, `targetDurationSec` 30|45|60, optional branding
  text fields + `logo` file, `review=1` flag) or JSON demo `{targetDurationSec, branding?,
  review?}`. -> `202 {runId}`. Review runs park at 'prompted' (no clip spend) and emit SSE
  `review`.
- `GET /api/runs/:id` snapshot; `GET /api/runs/:id/events` SSE (`progress`/`review`/`complete`/
  `run-error`; NEVER plain `error`, EventSource reserves it; replay buffer for late subscribers).
- `GET|PATCH /api/projects/:id/storyboard` (PATCH only while stage 'prompted'; re-paces via
  `paceDurations`); `GET .../thumb/:assetId`; `POST .../resume`; `GET .../video`
  (Range/206 support, `?variant=vertical`, `?download`).
- `complete` carries `videoUrl` (+`verticalUrl`), successful-shot count/rooms only.

### 6.6 Storyboard brain

Quality floor (`minQualityScore` 0.3) drops junk (all-drop = clear error). Selection: coverage
first (best of each room in canonical order: exterior_front -> foyer -> living_room -> kitchen ->
dining -> primary_bedroom -> bedroom -> bathroom -> office -> outdoor -> aerial), then quality
fill with per-room cap 2, then overflow. Pacing: smallest n covering the target
(n = ceil((target - xfade)/(clip - xfade)); 30/45/60s -> 7/11/14 clips), cumulative rounding sums
exactly; too few photos = full-length clips + warning, never padding.

## 7. Coding standards

- TypeScript everywhere, ESM (`"type": "module"`), run via tsx (no build step in dev).
- Cross-package imports use `@rev/*`; within a package, relative extensionless paths.
- Each engine package exports one Engine class + its I/O types, nothing else. Mocks are named
  `*:mock`; real engines get descriptive names (`render:ffmpeg`).
- **apps/web may only `import type` from workspace packages** (their runtime uses Node builtins).
  Browser-needed constants are mirrored with a "keep in sync" comment (consolidation: roadmap #16).
- Wire types shared by server/web/worker live in `@rev/core/events.ts` only.
- Tests: node:test via tsx, colocated `*.test.ts`. External APIs are tested with injected
  `fetchImpl`/client slices, never live. Every money-path change needs a test. Run
  `npm test` + `npm run typecheck` before any commit.
- The server resolves `projects/` from the repo root (`apps/server/src/paths.ts`), never cwd.
- Comments explain constraints the code can't show (billing rules, vendor traps), not narration.
- No em dashes in any prose, docs, comments, or commit messages.
- Commits: conventional-ish (`feat(scope):`, `docs:`), Co-Authored-By Claude trailer, push to
  `main` after tests pass (user-established practice).

## 8. Design constraints (locked)

- Higgsfield is the i2v vendor (engine seam makes alternatives one engine away; do not build a
  multi-vendor abstraction speculatively).
- Default model dop-turbo: **user chose cost over 1080p** (2026-07). Seedance stays one env var
  away. No music (user opted out; revisit only if asked). No video upscaling (does not exist on
  the API pool).
- Clip length (5s) and crossfade (0.75s) are config (`packages/core/src/config.ts`); duration
  math must keep summing exactly if they change.
- Per-shot failure isolation everywhere: a 5-of-6 video beats a crash.
- JSON project document is the pipeline's source of truth (file locally, JSONB row hosted);
  promoted columns exist for querying. Do not grow more JSON-blob consumers than the worker.
- Local-first stays fully functional with zero keys (mock engines + real render produce a
  playable MP4). Hosted has no mock mode (worker must fail fast, roadmap #3).

## 9. Roadmap (prioritized; reasoning in AUDIT.md section 5)

**Next implementation milestone: "Safe to invite" = HOSTING.md account wiring + one live hosted
E2E run.** The four P0 code gates are DONE (below). Then H1.5 = items 7-8 (hosted review). Then
H2 = Stripe credit packs + quotas UI + fidelity-informed pricing.

P0 (DONE 2026-07-12; code-complete, verified only by unit tests until a live account exists):
1. [x] Per-user run caps: `runs` ledger (migration 0002), service-role reserve in the edge
   functions, pure `evaluateRunGate` (max 1 active/user, 20/day, 2h stale window), worker marks
   terminal via `SupabaseRunLedger`.
2. [x] Duplicate-resume double-bill: `generate-tour` task `queue.concurrencyLimit: 1` (global
   serialization, also matches Higgsfield's 2-job ceiling) + `idempotencyKey` on resume triggers.
3. [x] Worker fails fast when either API key is missing (no hosted mock mode; spends nothing).
4. [x] Storage caps: photos bucket 30 MB + image mime types only (migration 0002, not a dashboard
   step).

P1:
5. Local CSRF/rebinding hardening: require a custom header on mutating routes + Host allowlist.
6. CI workflow: `npm ci && npm run typecheck && npm test` + `npm audit --audit-level=high` on push.
7. Extract review/pacing/`buildReviewData` domain logic out of `apps/server/routes/runs.ts` into
   a package (unblocks hosted review; deletes mirrored math in ReviewScreen).
8. Hosted review-before-spend flow (worker honors `stopAfter`, review event over run_events, edit
   + approve edge function).
9. Tests for engine-upload (EXIF, junk rejection) and vision `sanitize()`.
10. Measure fidelity-audit false-positive rate on a full real batch (`scripts/audit-clip.ts`).

P2:
11. Multipart `files: 41` boundary fix (40 photos + logo currently rejected).
12. Atomic `saveProject` (tmp + rename).
13. Unify `keyedEngines`/`hostedEngines`/`defaultEngines` into `buildEngines(mode)`.
14. Test-runner glob instead of the hand-maintained file list in package.json.
15. Worker `maxDuration` -> 10800; pass injected route `config` into review-data building.
16. Move MIN/MAX_PHOTOS + size limits into `@rev/core` (kill hand-mirroring).
17. Hosted UX table stakes: completion email, "my tours" list.

P3: RunRegistry eviction; fidelity progress sub-stage labeling; `pan` motion mapping semantics;
MockRenderEngine keep-or-delete decision; logger levels/redaction; ToS + AI-content disclosure
page; pin sharp/ffmpeg-static exact versions; tighten edge-function CORS to the Vercel origin;
full real-photo browser-UI run to shake out UX gaps; Tauri desktop packaging; beat-aware pacing.

## 10. Outstanding issues and technical debt

- **Known bugs:** roadmap #11 (40-photos+logo rejection). Cosmetic: global progress bar rewinds
  during the fidelity phase (audit A5).
- **Debt, accepted knowingly:** persistence-as-module-functions with the `onCheckpoint` mirror
  bolt-on (future `ProjectStore` port, audit A1); three engine-wiring copies (#13); constant
  mirroring (#16); `storage://` URL convention on shared event types (audit A9); RunRegistry
  unbounded growth (#P3); non-atomic project.json writes (#12).
- **Unmeasured:** fidelity FP rate (#10); Seedance/Kling quality beyond single prototypes;
  platform $/credit for the API pool (user should read it off the dashboard; consumer reference
  ~$0.10-0.15/credit).
- **Dependency watch:** `@opentelemetry/core` moderate advisory via @trigger.dev/core (worker
  telemetry only); bump when Trigger.dev updates. Everything else clean at audit time.
- **External blockers:** Higgsfield 2-concurrent-job plan ceiling (support conversation before
  multi-user load); Higgsfield ToS review for resale vs BYOK (before H2 pricing).

## 11. Dev commands

```bash
npm install            # once
npm run demo           # full mock pipeline -> playable MP4, zero keys/cost
npm run analyze [dir]  # Claude vision debug table (default test-photos/; real photos in test-photos-real/, gitignored)
npm run storyboard <projectId> [targetSec]   # replay selection/prompts on saved vision data, no API cost
npm run render <clipsDir> [out]              # stitch any folder of clips
npx tsx scripts/smoke-higgsfield.ts          # ONE-clip live smoke test (spends ~5 credits) before any full run
npx tsx scripts/audit-clip.ts <clip> <photo> # standalone fidelity audit of any clip
npm test               # 67 tests; npm run typecheck  # root + web tsconfigs
npm run dev:server     # Fastify on 127.0.0.1:3001
npm run dev:web        # Vite on 5173 (second terminal)
```

Runtime verification recipes (launch, drive, credit-safety rules: JSON demo runs never spend):
`.claude/skills/verify/SKILL.md`. Hosted setup: HOSTING.md.

## 12. History (compressed; full detail in git log and AUDIT.md)

Phases 0-8 built the mock-to-real pipeline: monorepo + engine contract; Fastify+React scaffold;
real upload; Claude vision; storyboard selection/pacing; prompt composer; Higgsfield REST client
(live-verified, first real tour `projects/real-tour/tour.mp4`); FFmpeg render; resume semantics +
preview/download; review screen. The 2026-07 fidelity arc: diagnosed live hallucination, rewrote
prompts fidelity-first, migrated to DoP v2 for motion strength 0.3, added the fidelity audit
engine (caught a real invented fixture and an invented person). Phase 10: branding cards +
watermark + 9:16 vertical; quality investigation (DoP 720p cap found, lanczos+unsharp fix,
Seedance wired opt-in, user kept DoP for cost). Phase H1: hosted multi-user skeleton (Supabase +
Trigger.dev + Vercel), full audit (AUDIT.md), this document restructure.

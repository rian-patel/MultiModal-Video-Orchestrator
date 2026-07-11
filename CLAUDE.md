# Real Estate Cinematic Video Generator

> **Read this first every session.** It is the source of truth for architecture, conventions, and current build phase. Update it as the project evolves.

## What we're building

A **local-first web app** (desktop-wrappable later via Tauri/Electron) that turns 10–40 property photos into a single cinematic real-estate tour video with almost no user input:

1. User drags in 10–40 photos.
2. User picks a length: **30 / 45 / 60 s**.
3. User clicks **Generate**.
4. The app auto-analyzes each photo (what room it is), orders them into a logical house tour, writes cinematic motion prompts, animates each photo via **Higgsfield** (image→video), stitches the clips with **FFmpeg**, and presents a downloadable MP4.

Design goal: **maximum automation, minimum input.** And **modular from day one** — every stage is an independent, swappable engine.

## Product shape & why

- **Local-first web app**: browser UI + local Node server. FFmpeg + large files need a real filesystem/process; runs on the user's machine with their own API keys → no hosting/auth/billing to build for the MVP.
- **Desktop later**: wrap the same frontend+server in **Tauri** (preferred) or Electron. No architecture change — just packaging. (That's why we did NOT start in Electron.)

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language | **TypeScript** everywhere | Vision is an API call, so no Python needed → one language. |
| Monorepo | **npm workspaces** (pnpm not installed) | Run TS via **tsx** (no build step in dev). |
| Frontend (Phase 1+) | React + Vite + Tailwind | Single-screen tool; no SSR needed. |
| Backend (Phase 1+) | Fastify | REST + SSE progress streaming. |
| Vision / room understanding | **Claude (vision)** via Anthropic API | One call → roomType + description + lighting + move + quality score. Swappable for local CLIP. |
| Video generation | **Higgsfield** image→video | MCP connector available in-session for prototyping; production REST client behind same interface. |
| Render | **FFmpeg** via `ffmpeg-static` (spawned directly; no fluent-ffmpeg) | Normalize+trim per clip, chained `xfade`, H.264 1080p CRF19. |
| Persistence | JSON per project now → **SQLite** (`better-sqlite3`) later | Resumable job state. |
| Concurrency | `p-queue` | Cap Higgsfield concurrency + retries. |

## Architecture: independent engines enriching one shared `Project`

Data flows down a pipeline. Each **engine** is a pure transform with a narrow, testable I/O. The **orchestrator** reads the needed slice of `Project`, calls the engine, writes the result back, persists, and emits progress. Engines never call each other — that's what makes them swappable.

```
Upload → Vision → Storyboard → Prompt → VideoGen → Fidelity → Render → download
```

| Engine | Input → Output | MVP impl | Swap-in later |
|---|---|---|---|
| **Upload** | `UploadRequest` → `Asset[]` | validate/persist/thumbnail | S3 adapter |
| **Vision** | `Asset[]` → `VisionResult[]` | Claude vision | local CLIP, GPT-4V |
| **Storyboard** | `{assets,vision,targetDurationSec}` → `Shot[]` | rule-based order + **select best N** + durations | LLM narrative order |
| **Prompt** | `{shots,vision}` → `Shot[]` | vision-move + room-variant composer (see Phase 4 notes) | LLM prompts |
| **VideoGen** | `{shots,assets}` → `Shot[]` | Higgsfield (submit/poll/download) | Runway/Kling/Luma |
| **Fidelity** | `{shots,assets}` → `Shot[]` | Claude audits clip frames vs source photo; drift ⇒ shot 'failed' | frame-diff heuristics |
| **Render** | `{shots,outputPath,branding?}` → `RenderResult` | FFmpeg (+cards/watermark/9:16) | Remotion |

(Fidelity runs *inside* the videogen stage checkpoint — no new `ProjectStage`; a
dropped clip is a per-shot 'failed', which render skips and resume regenerates.)

### The Engine contract (`@rev/core`)
```ts
interface Engine<TIn, TOut> {
  readonly name: string;
  process(input: TIn, ctx: EngineContext): Promise<TOut>;
}
// EngineContext = { workDir, config, logger, progress(pct, msg) }
```

### The shared spine: `Project` (`@rev/core`)
`Project` carries `assets`, `vision`, `shots`, `outputPath`, and a `stage`. `Shot` is the unit that flows through Storyboard→Render (order, roomType, durationSec, prompt, motionPreset, higgsfieldJobId, clipPath, status). See `packages/core/src/project.ts`.

### Storyboard is the "brains" of low-input UX (`storyboard:rule-based`, Phase 3 final)
Three passes, all in `packages/engine-storyboard/src/index.ts` (unit-tested in `index.test.ts`, `npm test`):
1. **Quality floor** (`config.storyboard.minQualityScore`, 0.3): junk photos are dropped, not padded in — a shorter, better video wins. All photos below floor → clear error (surfaces as SSE run-error). Drops are warned via the progress message.
2. **Selection**: coverage first (best photo of each distinct room in tour order), then quality fill with a **per-room cap** (`maxShotsPerRoom`, 2) so one photogenic room can't dominate, then uncapped overflow only if slots remain.
3. **Exact pacing**: smallest n with per-clip ≤ `clipDurationSec` covering the target — `n = ceil((target − xfade)/(clip − xfade))` — then per-clip durations via **cumulative rounding** so the cut sums to the target exactly (30/45/60 → 7/11/14 clips; render trims clips, never extends). Too few photos → full-length clips, shorter video + warning.
- **Canonical tour order**: exterior_front → foyer → living_room → kitchen → dining → primary_bedroom → bedroom → bathroom → office → outdoor → aerial (`roomPriority.ts`). Deterministic (idx tie-breaker).
- Debug: `npm run storyboard <projectId> [targetSec]` replays storyboard+prompt on a saved project's vision data — tune selection without re-paying vision API calls.

## Folder structure

```
packages/
  core/              @rev/core — Project model, Engine<> contract, config, logger, id,
                     shared SSE event types (events.ts — wire format for server+web)
  engine-upload/     @rev/engine-upload
  engine-vision/     @rev/engine-vision
  engine-storyboard/ @rev/engine-storyboard
  engine-prompt/     @rev/engine-prompt
  engine-videogen/   @rev/engine-videogen
  engine-fidelity/   @rev/engine-fidelity — post-videogen hallucination audit
  engine-render/     @rev/engine-render
  orchestrator/      @rev/orchestrator — pipeline runner + persistence + progress
apps/
  server/            @rev/server — Fastify (port 3001): REST + SSE, wired to the pipeline
                     (main.ts, app.ts, runs.ts = in-memory RunRegistry w/ replay buffer,
                      routes/health.ts, routes/runs.ts, paths.ts = repo-root resolution)
  web/               @rev/web — React 19 + Vite + Tailwind v4 (port 5173, /api proxied
                     to 3001): App.tsx, api.ts (SSE client), components/{Dropzone,
                     LengthSelector, BrandingSection (collapsible; agent identity
                     persisted in localStorage), ProgressBar, ResultCard (video preview
                     + master/vertical downloads), ReviewScreen (reorder/remove/approve)}
scripts/demo.ts      runs the full pipeline on fake data (no server needed)
projects/<id>/       per-run working dir: source/ clips/ output/ project.json  (gitignored)
```

### Server API (stable shape)
- `GET  /api/health` → `HealthData { ok, service, engines: { vision: claude|mock, videogen: higgsfield|mock, fidelity: claude|mock } }` — which impls the next run will use (key-gated); the UI header displays it.
- `POST /api/runs` — two content types (both accept a **review** flag: multipart field
  `review=1` / JSON `review: true` → run pauses at the 'prompted' checkpoint and emits
  SSE `review` instead of animating straight through — no clip spend until approval):
  - `multipart/form-data`: real photos. Fields: `targetDurationSec` (30|45|60) +
    `photos` file parts (10–40, ≤30 MB each) + optional branding text fields
    (`address`, `agentName`, `phone`, `email`) and a `logo` file part. Streamed to
    `%TMP%/rev-uploads/<id>/`, run through the real `LocalUploadEngine` (engine
    override), temp dir removed in `trackRun`'s finally (the orchestrator copies the
    logo into `workDir/branding/` first, so resumes never depend on the temp dir).
    → `202 { runId, photoCount }`. Bad count/duration → 400.
  - `application/json` `{ targetDurationSec, branding? }`: demo mode — built-in
    14-name set through the mock Upload Engine (branding = text fields only).
    → `202 { runId }`.
- `GET  /api/runs/:id` → snapshot `{ id, status, projectId, lastEvent }` (projectId set as soon as the project exists, not only on success).
- `GET  /api/runs/:id/events` → SSE. Event names: `progress`, `review`, `complete`,
  `run-error` (NOT `error` — that's reserved by EventSource). Replays buffered events
  to late subscribers, so reconnects recover the full history. `complete` carries
  `videoUrl` (+ `verticalUrl` when a 9:16 cut exists) + shot count/rooms of
  **successful** shots only; `review` carries
  `ReviewEventData` (shots w/ prompts+thumbUrls, benched photos, pacing config) and is
  terminal for that run's stream; `run-error` carries `projectId?` (what enables Resume
  in the UI). The web client also handles EventSource giving up (server restarted
  mid-run → 404 → readyState CLOSED) with a "lost connection" error.
- `GET  /api/projects/:id/storyboard` → `ReviewEventData` for the saved project (409 before Storyboard has run).
- `PATCH /api/projects/:id/storyboard` `{ assetIds: string[] }` — the new tour, in
  order (omitting = removing); subset of current shots, no dups. Re-paces durations via
  `paceDurations` (exported by engine-storyboard: exact target at the ideal clip count,
  full-length clips otherwise) and saves. Only while stage is 'prompted' (409 otherwise).
- `GET  /api/projects/:id/thumb/:assetId` → 320px JPEG thumbnail (404 for mock/demo assets).
- `POST /api/projects/:id/resume` → `202 { runId, projectId, resumeFrom }` — re-runs a
  persisted project from its last checkpoint (semantics below). 404 unknown project,
  409 if already complete or upload never finished. Same SSE contract as a normal run.
- `GET  /api/projects/:id/video` → streams the finished MP4 (default: 16:9 master;
  `?variant=vertical` = the 9:16 social cut, 409 if none, 400 for unknown variants).
  Single-range `Range:` support (206/416 — required for `<video>` seeking);
  `?download` adds `content-disposition: attachment;
  filename="tour-<len>s[-vertical].mp4"`. 409 before render.

### Resume semantics (Phase 7, in `@rev/orchestrator`)
`project.stage` is a **checkpoint**: it only advances when that stage's output is on
disk ('generating'/'rendering' are written just *before* their stage starts). On
failure the stage is left alone and the reason goes to `project.lastError` — there is
no 'error' stage anymore. `nextStage(project)` maps any saved project to the first
stage still to run; `resumePipeline({ projectId })` skips completed stages. Within
videogen, shots whose `status === 'done'` clip file still exists are kept and only the
rest go to the engine ("Resuming: N/M clips already generated") — finished Higgsfield
clips are never re-paid for. If videogen fails outright on resume but kept clips
exist, the failure downgrades to per-shot 'failed' and the partial tour still renders.
Not resumable: stage 'created' (original upload bytes are gone) and legacy 'error'
projects. Upload is never re-run — `workDir/source/` is the durable artifact.

### Vision Engine (real, `vision:claude` in packages/engine-vision/src/claude.ts)
One Claude call per photo: `claude-opus-4-8`, **structured outputs** (`output_config.format` json_schema — guaranteed-valid JSON, schema in `schema.ts`), image downscaled to ≤1280px JPEG before sending (cost), concurrency 4, SDK `maxRetries: 3`. **Per-image failure isolation**: an unanalyzable photo gets a conservative default (`other`, q=0.3) instead of failing the run; a non-property image is classified `other` with q≈0.05 by the prompt's own rules, so Storyboard benches it. Model/concurrency/dim configurable via constructor. Server uses it for multipart runs **only when `ANTHROPIC_API_KEY` is set** (loaded from `.env` via `process.loadEnvFile` in main.ts); demo/JSON runs always stay mock. NOTE: `@anthropic-ai/sdk` must be ≥0.110 for `output_config` typings.

Debug view: `npm run analyze [dir]` — runs Claude vision on any folder of photos (no server, no 10-photo minimum) and prints the room/quality/lighting/move table. Default dir: `test-photos/`. Real photos for testing live in `test-photos-real/` (gitignored).

### Upload Engine (real, `upload:local` in packages/engine-upload/src/local.ts)
Per photo: sharp `.rotate()` (applies EXIF orientation) → normalized JPEG q92 in
`workDir/source/<assetId>.jpg` → true post-rotation dims onto `Asset` → 320px thumb
in `workDir/thumbs/`. Downstream engines can assume upright, consistent JPEGs.
Non-image bytes fail the run with a per-file message.

## Fidelity: reducing property hallucination on the generative path

Real-estate video must **not invent or alter the property** (inventing furniture/rooms/
features is a legal liability). Root cause found live: an image-to-video model
synthesizes new pixels for any area a camera move reveals; a *translational* move
(dolly-in/orbit/crane) toward a prompt-named target ("dolly-in toward the dining room")
makes it fabricate that target — it invented a dining table in the dolly path even
though the real one sat off through a doorway. Prompt design amplified it (declarative
scene descriptions + directional moves).

A deterministic "Ken Burns" (pan/zoom over the real photo) engine was trialed as a
guaranteed-faithful default but **removed — the output quality was unacceptable**. The
generative Higgsfield path is the product; we harden it toward fidelity instead:

- **Fidelity-first Prompt engine** (`packages/engine-prompt`): emits NO declarative scene
  description (the image is the sole authority on contents — this is what stops the model
  inventing named furniture/rooms), only a neutral **non-directional** camera move
  (`safeMovePhrase`, never "toward X" — a named destination is what the model synthesizes
  toward) + lighting + a hard `FIDELITY_CONSTRAINT` on every prompt ("do not add, remove,
  move, or invent any furniture, objects, rooms … keep every existing object unchanged").
  Vision's photo-specific move still selects the motion *preset*, but its free-text
  (which may name a destination) never reaches the prompt.
- **`enhance_prompt: false`** in the Higgsfield submit body — disables the platform's
  prompt "enhancer" (it embellishes and invents detail). On the v2 endpoint the field is
  schema-validated (bool), so it is guaranteed honored.
- **Low motion strength (v2 endpoint, 2026-07)**: videogen now submits to
  `POST /v1/image2video/dop` with `motions: [{id, strength}]`, default **strength 0.3**
  (`HIGGSFIELD_MOTION_STRENGTH`, 0..1). Less camera travel = less occluded geometry the
  model must synthesize = less room to invent. Verified live on the living-room photo
  that caused the original hallucination: all visible content preserved (no people, no
  invented furniture/rooms); residual drift confined to door-reveal details.
- **Fidelity engine backstop** (`fidelity:claude`, `packages/engine-fidelity`): after
  videogen, Claude compares 4 sampled frames per clip (1 anchor near t=0 + 3 across the
  back half, ≤1568px) against the source photo (structured verdict faithful|drift, rubric
  tuned for materiality: people/added furniture/layout changes/contradicting reveals =
  drift; softness/lighting/text-morph/plausible sliver continuations = fine). Drift ⇒
  shot 'failed' → skipped from the cut; resume regenerates it (flag `fidelityChecked`
  skips re-audits of kept clips; regenerated shots shed the flag). FAIL-OPEN: an audit
  error keeps the paid clip, unflagged, for a later re-audit. Wired when
  `ANTHROPIC_API_KEY` is set; demo/keyless runs use the pass-through `fidelity:mock`.
  Verified live on the prototype clip: correctly caught a genuinely invented
  hearth-like fixture in a door reveal (verdict 'drift' — that clip would be
  regenerated). Known limit: it can misread nested-doorway geometry and cite a real
  object as missing, biasing strict — costs a regen, never ships a fabrication.
  Auditor false-positive rate should be watched on the next full real run.

**Residual risk** — a generative model always has latitude; strength 0.3 + the audit
make drift rare and caught, not impossible.

## External dependencies / keys

- `ANTHROPIC_API_KEY` — Claude vision. **Set in `.env` (gitignored) since Phase 2.**
- `HIGGSFIELD_API_KEY` — video generation, from **cloud.higgsfield.ai** (`/api-keys` after sign-in) — separate product/credit pool from the consumer subscription the MCP connector uses; `platform.higgsfield.ai` is an API-only host with no dashboard UI, not the signup page. Engine auto-activates when set. Format documented as `key:secret` as of Phase 5's prototyping (see below) — reverify against the dashboard's actual output before first real run, since Higgsfield's own docs describe a single bearer token. MCP connector remains usable in-session for prototyping.
- Optional videogen tuning: `HIGGSFIELD_MODEL` (dop-turbo | dop-lite | dop-preview) and
  `HIGGSFIELD_MOTION_STRENGTH` (0..1, default 0.3 — the fidelity lever).
- FFmpeg bundled via `ffmpeg-static` (Phase 6) — no system install.
- Copy `.env.example` → `.env`.

## Dev commands

```bash
npm install        # once, sets up workspace symlinks
npm run demo       # full mock pipeline in the terminal (no server needed)
npm run analyze [dir]  # Claude vision debug table on a folder of photos (default test-photos/)
npm run storyboard <projectId> [targetSec]  # replay storyboard+prompts on a saved project (no API cost)
npm test           # unit tests (node:test via tsx)
npm run dev:server # Fastify API on http://127.0.0.1:3001 (tsx watch)
npm run dev:web    # Vite UI on http://localhost:5173 (run in a second terminal)
npm run typecheck  # tsc --noEmit: root project (packages+scripts+server) AND apps/web
```

## Conventions

- ESM everywhere (`"type": "module"`). Cross-package imports use `@rev/*`; within a package use relative paths (extensionless, tsx/esbuild resolves).
- Each engine exports one class implementing `Engine<TIn,TOut>` and its I/O types. Nothing else.
- Mock engines are named `*:mock`; real ones get a descriptive name (e.g. `render:ffmpeg`). Swapping = pass a different engine into `runPipeline({ engines: {...} })`.
- Orchestrator persists `project.json` after every stage → runs are resumable.
- **apps/web may only `import type` from workspace packages** — their runtime code uses Node built-ins (e.g. `node:crypto` in core's id.ts) that don't exist in the browser. Runtime constants needed by the UI (e.g. 10–40 photo limits) are mirrored locally with a "keep in sync" comment.
- Types shared between server and web (SSE payloads etc.) live in `@rev/core` `events.ts` so the wire format can't drift.
- The server resolves `projects/` from the repo root via `apps/server/src/paths.ts` (import.meta.url), never from cwd.

## Roadmap (build incrementally, one phase per prompt)

- [x] **Phase 0** — Monorepo, `core`, mock orchestrator running all 6 engines on fake data end-to-end.
- [x] **Phase 1a — full-stack scaffold** — Fastify server (REST + SSE + RunRegistry) + React/Vite/Tailwind UI (dropzone, 30/45/60 selector, Generate, live progress bar, result card) wired to the mock pipeline end-to-end. Verified in a real browser (Playwright): Generate → SSE progress → "Tour complete". No business logic: upload sends file *names* only, engines are Phase 0 mocks.
- [x] **Phase 1b — real Upload Engine** — `LocalUploadEngine` (sharp: EXIF rotate, normalize to JPEG, true dims, thumbnails), `@fastify/multipart` streaming on the server, UI sends real File bytes as FormData. Demo mode (no files) still uses the mock engine — first real use of the engine-swap mechanism. Verified: curl multipart (12 JPEGs incl. an EXIF-orientation-6 case → correctly 1000x1600) and full browser upload via Playwright. `scripts/make-test-photos.ts` regenerates test fixtures into `test-photos/` (gitignored).
- [x] **Phase 2 — Vision Engine (Claude)** — `ClaudeVisionEngine` (opus-4-8, structured outputs, downscale, concurrency 4, per-image fallback) + `npm run analyze` debug CLI + server auto-swap when key present. Verified on real property photos: kitchen/living_room/outdoor correctly classified q≈0.9 with vivid descriptions that flow into prompts; solid-color junk correctly scored `other` q=0.05; full server E2E run mixed-quality photos correctly. `ANTHROPIC_API_KEY` now set in `.env`.
- [x] **Phase 3 — Storyboard Engine (final)** — quality floor (drops junk, warns, errors if nothing usable), coverage-first selection with per-room cap 2 + overflow, exact-duration pacing via cumulative rounding (45s target now renders 45.00s, not 43.25s). 8 unit tests (`npm test`, node:test via tsx — first tests in the repo). `npm run storyboard <projectId>` preview tool. Verified against the real-photo project proj_5e627dec: 4 good photos → clean 17.75s tour + "shorter than requested" warning instead of a junk-padded 43s one.
- [x] **Phase 4 — Prompt Engine** — **NOTE: prompt shape superseded by the fidelity-first
  rewrite (see the "Fidelity" section above).** Originally `"<Scene>. Camera: <move>.
  <Lighting> light; <mood>. <style suffix>"` with Vision's description + directional move
  in the prompt — that scene description + "toward X" move is exactly what caused the
  dining-table hallucination. Now: no scene description, neutral `safeMovePhrase`, and a
  hard `FIDELITY_CONSTRAINT`. Vision's `suggestedMove` still selects the motion preset
  (`presetFromMove`); per-room variants fall back/rotate; identical back-to-back moves
  auto-vary. Tests rewritten to assert the anti-hallucination guarantees.
- [x] **Phase 5 — VideoGen Engine (Higgsfield)** — Prototyped via MCP: kitchen photo + Phase 4 prompt → real 5s clip (`projects/prototype/kitchen-dolly-in.mp4`, model `cinematic_studio_video_v2`, 5 credits, sound off; balance was 191 credits, kling3_0=7.5cr, seedance=17.5cr). Production `HiggsfieldVideoGenEngine` (`videogen:higgsfield`) targets the platform REST API (docs.higgsfield.ai): `POST /{model}` `{image_url(data URI), prompt, duration}` w/ `Authorization: Key key:secret` → poll `GET /requests/{id}/status` (queued|in_progress|completed|failed|nsfw) → download `video.url` to `workDir/clips/`. Concurrency 3, 2 attempts/shot, per-shot failure isolation (all-fail → error). Default model `higgsfield-ai/dop/standard` (override via `HIGGSFIELD_MODEL`). 5 unit tests w/ injected fetch. Server swaps it in when `HIGGSFIELD_API_KEY` (format `key:secret`) is in `.env`. VideoGen input widened to `{shots, assets}` (engine needs source images). **REST path now verified live (2026-07)** — see the Higgsfield-integration note below; the original data-URI image assumption was wrong and has been fixed to a CDN upload. Submit endpoint since migrated to v2 for motion strength (Phase 9a).

### Higgsfield integration — verified & gotchas (2026-07)
- **Auth** `Authorization: Key <keyId>:<secret>` — the dashboard (cloud.higgsfield.ai/api-keys) issues a Key ID + Secret; join with a colon in `HIGGSFIELD_API_KEY`. Confirmed working (a bad image got 422 on the body, not 401).
- **v2 endpoint (current path, probed + verified live 2026-07):**
  `POST /v1/image2video/dop` `{ params: { prompt, input_images: [{type:'image_url',
  image_url}], model: 'dop-turbo'|'dop-lite'|'dop-preview' (default dop-turbo),
  motions: [{ id: <UUID>, strength: 0..1 }], seed?, enhance_prompt } }` → returns a
  job-set `{ id, jobs: [...] }`. **The legacy `GET /requests/{id}/status` route accepts
  the v2 id** (same `{status, video.url}` shape), so polling/download are unchanged.
  There is **no duration param** (clips are ~5s, matching `clipDurationSec`). Motion
  catalog: `GET /v1/motions` (121 presets, stable UUIDs — mapped from our motionPreset
  names in `MOTION_IDS`, engine-videogen/higgsfield.ts). Unknown/legacy model values are
  normalized to `dop-turbo`. Schema was discovered by probing FastAPI 422 validation
  errors — empty/wrong-typed bodies enumerate fields; useful trick for their other
  endpoints. dop-turbo prototype clip: 1280x720@30, ~5 min wall.
- **Image input is NOT a data URI.** The platform rejects data-URI `image_url` with **HTTP 422 `url_too_long`** (2083-char cap). Real flow (from the official SDK, `npm pack higgsfield-client`): `POST /files/generate-upload-url {content_type}` → `{upload_url, public_url}`, then `PUT` raw bytes to `upload_url` (presigned; only `Content-Type` header), then submit `public_url` as `image_url`. Implemented as `uploadImage()` in `higgsfield.ts`.
- **Latency & retry (fixed):** `dop/standard` ≈ a few min/clip, occasionally ~16 min under load. Default `maxPollMs` is 20 min. `generateShot` splits retry into two phases: obtaining a request_id (upload + submit) is retried (a failure there predates any billable job — e.g. a transient CDN 502), but poll + download is **never** retried, so a slow clip is never resubmitted/double-billed. So the default `maxAttempts: 2` is credit-safe.
- **Fidelity (`enhance_prompt: false`):** the submit body disables the platform prompt-enhancer to curb invented detail (see the "Fidelity" section). Verified accepted by the DoP endpoint.
- **Cost/timing seen:** 7-photo → 6/7 clips (one transient 502 on the upload-url step, isolated & skipped — pre-submit, so no credit), stitched to 25.83s 1080p in **13.2 min wall**. `scripts/smoke-higgsfield.ts` = one-clip live smoke test to run before any full run. First real tour: `projects/proj_99799c3f/output/tour.mp4`.
- [x] **Phase 6 — Render Engine (FFmpeg)** — `FfmpegRenderEngine` (`render:ffmpeg`): per-clip normalize (scale+pad to config.resolution, fps=30, settb) + trim to shot.durationSec, chained `xfade` transitions (offset_k = Σdur − k·xfade), H.264 CRF19 `+faststart`, progress parsed from stderr `time=`. `buildXfadeGraph` + `probeDurationSec` exported (used by tests/scripts). Spawns `ffmpeg-static` directly — NOT fluent-ffmpeg (unmaintained; direct filter_complex control). Mock videogen now emits REAL color MP4s via ffmpeg, and `defaultEngines()` uses the real render — keyless `npm run demo` produces a playable 45.03s MP4. `npm run render <clipsDir> [out]` stitches any folder of clips. 5 render tests (2 run real ffmpeg + probe duration). **First real tour shipped: `projects/real-tour/tour.mp4`** (17.93s, 1080p, 4 real Higgsfield clips of the user's photos, crossfaded). Discovered live: starter plan = max 2 concurrent Higgsfield jobs → engine default concurrency now 2. Credits: 171 left (spent 20 total on 4 clips @ 5cr). Music + branding overlays deferred to Phase 7/8 (no licensed music assets yet).
- [x] **Phase 7 — wiring, resume, preview + download** — `stage` became a resume checkpoint (`lastError` replaces the 'error' stage); `resumePipeline`/`nextStage` in orchestrator skip finished stages and, within videogen, keep shots whose clips exist on disk (never re-pay Higgsfield); videogen total-failure on resume downgrades to per-shot 'failed' when kept clips exist. New routes: `POST /api/projects/:id/resume`, `GET /api/projects/:id/video` (Range + `?download`); health reports key-gated engine wiring. UI: in-app `<video>` preview + Download MP4 button (ResultCard), "Resume from last checkpoint" button on error, engine line in header, EventSource connection-loss surfaced. 9 new tests (orchestrator resume + server routes, `buildApp({ projectsDir })` for test injection). Verified live: browser demo run → playing/seeking 1080p video; tampered project (3 of 7 clips deleted, stage='generating') resumed via API — "Resuming: 4/7 clips already generated", kept clips' mtimes untouched. Project verify recipe saved to `.claude/skills/verify/SKILL.md`.
- [x] **Phase 8 — storyboard review screen** — a run started with `review: true` stops at the 'prompted' checkpoint (SSE `review` event, run status 'review') **before any clip spend**; the UI shows the planned tour (thumbnails or room-color swatches for demo, motion preset chips, vision descriptions, benched photos) with reorder/remove/restore; "Animate" = `PATCH /api/projects/:id/storyboard` (re-paces via the newly exported `paceDurations`) + the existing resume endpoint — approval is just Phase 7's resume from 'prompted'. "Review first" checkbox in the UI, default ON. 4 new tests (37 total). Verified live over HTTP: 30s demo review run → reversed + dropped a shot → 26.25s plan → resumed → rendered MP4 probed at 26.27s in the user's custom order.
- [x] **Fidelity pass (2026-07)** — diagnosed/fixed the property-hallucination bug (model
  fabricated a dining table). Prompt engine rewritten fidelity-first (no scene description,
  neutral non-directional moves, hard `FIDELITY_CONSTRAINT`) and `enhance_prompt: false` on
  the Higgsfield submit. A guaranteed-faithful Ken Burns engine was trialed as default but
  **removed — quality was unacceptable**; Higgsfield (hardened) stays the product path.
- [x] **Phase 9a — fidelity levers (2026-07)** — both levers landed. (1) VideoGen migrated
  to the v2 endpoint (`POST /v1/image2video/dop`): motion presets mapped to catalog UUIDs
  (`MOTION_IDS`), **motion strength default 0.3** (`HIGGSFIELD_MOTION_STRENGTH`),
  schema-validated `enhance_prompt:false`, legacy status route reused for polling (v2 ids
  accepted), legacy model names normalized to `dop-turbo`. Prototype
  (`scripts/prototype-dop-v2.ts`, clip in `projects/prototype/`) verified low strength
  keeps the previously-hallucinating living-room shot faithful. (2) New
  **`@rev/engine-fidelity`** audit stage (see the Fidelity section): Claude frame audit,
  drift ⇒ per-shot 'failed', fail-open, `fidelityChecked` resume semantics; wired in
  orchestrator (`PipelineEngines.fidelity`, inside the videogen checkpoint), server
  (key-gated), health + UI header. 4 new tests (45 total); live-audit of the prototype
  clip correctly flagged its invented hearth fixture.
- [x] **Phase 10 — branded deliverable + vertical (2026-07)** — turning the silent 16:9
  clip into something an agent can post. (1) **Branding overlays**: optional `Branding`
  on `Project` (address/agentName/phone/email/logoPath); Render composes a title card
  (address headline) + end card (agent, phone·email, logo) as sharp SVG→PNG image
  inputs in the same xfade chain (each `CARD_SEC`=3s, so a 30s tour ships as 34.5s),
  plus a 55%-opacity corner logo watermark timeline-enabled over the tour segment only
  (`packages/engine-render/src/cards.ts`; user text XML-escaped). Logo is copied into
  `workDir/branding/` at run start (`adoptBranding`) so resume never depends on upload
  temp dirs. UI: collapsible BrandingSection, agent identity kept in localStorage.
  (2) **9:16 vertical** (`tour-vertical.mp4`): always derived from the finished master —
  blur-pad (gblur=24 + slight darken) behind the centered 16:9 band; zero extra credits.
  Served via `?variant=vertical`; second download button in ResultCard. (3) **Video
  upscale: NOT integrable** — probed the platform API 2026-07 (`v1/upscale/video` and
  every plausible route → "Model not found"); `upscale_video` exists only on the
  consumer MCP subscription, not the API-key pool. Revisit if Higgsfield ships it.
  8 new tests (53 total). Verified over HTTP: branded 30s demo → 34.5s master
  (cards eyeballed correct) + 1080x1920 vertical, both stream w/ Range + download names.
- [ ] **Phase 10b+** — (a) measure fidelity-audit false-positive rate on a full real run.
  (b) beat-aware pacing + music — **user opted out of music for now** (revisit only if
  asked; no licensed assets). (c) Tauri desktop packaging. (d) full real-photo run
  through the browser UI (upload→review→generate→download) to shake out UX gaps.

## Key decisions (locked for MVP)

- All-TypeScript; Vision = Claude (revisit if offline classification needed).
- Higgsfield for i2v; prototype via MCP connector, then REST client behind `Engine` interface.
- Clip length & crossfade are **config** (`packages/core/src/config.ts`) so duration math stays correct if Higgsfield options change.
- Per-shot failure isolation: a failed clip is skipped, not fatal — a 5-of-6 video beats a crash.

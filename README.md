# MultiModal Video Orchestrator

A local-first pipeline that turns 10-40 raw property photos into a single cinematic
real-estate tour video with almost no user input. It reads every photo with a vision
model to recover room type, lighting, composition quality and a suggested camera move,
orders the shots into a logical walk-through of the house, composes a fidelity-constrained
motion prompt per shot, animates each still into a live clip with Higgsfield image-to-video,
audits every generated clip against its source photo so no fabricated furniture or rooms
ever ship, and stitches the clips with FFmpeg into a crossfaded, exactly-timed 1080p MP4,
with optional agent branding (title card, end card, logo watermark) and an automatic
9:16 vertical cut for social.

The design goal is maximum automation with minimum input: the user drags in photos, picks a
length, and clicks Generate. Everything between the drop zone and the finished file is an
orchestrated sequence of independent, individually swappable engines that enrich one shared
job document as it flows down the pipeline. Every stage checkpoints to disk, so a run that
fails on clip 5 of 7 resumes from clip 5 instead of paying to regenerate the first four.

It runs entirely on the operator's machine with their own API keys, so there is no hosting,
auth, or billing surface to build for the MVP. A browser UI talks to a local Node server that
owns the filesystem, spawns FFmpeg, and streams progress back over Server-Sent Events. The
same frontend and server wrap unchanged into a Tauri or Electron desktop app later; that is a
packaging step, not an architecture change.

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [How the pipeline computes it](#how-the-pipeline-computes-it)
- [Fidelity: not inventing the property](#fidelity-not-inventing-the-property)
- [Resumability and cost safety](#resumability-and-cost-safety)
- [Data format](#data-format)
- [Server API](#server-api)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Setup](#setup)
- [Run](#run)
- [Commands](#commands)
- [Status](#status)

## Features

Each capability is a self-contained engine with a narrow, testable input/output. The
orchestrator reads the slice of the shared job each engine needs, calls it, writes the result
back, persists, and emits progress. Engines never call each other, which is what makes any one
of them swappable without touching the rest.

### Automatic room understanding

One vision call per photo returns a structured record: room type (one of thirteen categories
from `exterior_front` to `aerial`), a one-line scene description, detected features, a lighting
class, a suggested camera move, and a 0-to-1 composition quality score. The call uses guaranteed
schema-valid JSON via structured outputs, downscales each image to at most 1280px before sending
to control cost, and runs four photos concurrently. Failure is isolated per image: an
unanalyzable photo receives a conservative default instead of failing the whole run, and a
non-property image is scored near zero so it is quietly benched.

### Storyboard construction (the low-input brain)

The storyboard engine is where "drag in photos and click Generate" becomes a coherent tour. It
runs three passes over the analyzed set:

- A quality floor drops junk photos rather than padding the tour with them, because a shorter,
  stronger video beats a longer, weaker one. If nothing clears the floor, the run fails with a
  clear message instead of shipping garbage.
- Selection is coverage-first: the best photo of each distinct room in canonical tour order,
  then a quality fill with a per-room cap so one photogenic room cannot dominate, then uncapped
  overflow only if slots remain.
- Pacing is exact. The engine solves for the smallest clip count whose clips can cover the
  requested length, then distributes per-clip durations by cumulative rounding so the final cut
  lands on the target to the hundredth of a second.

### Fidelity-first prompt composition

The prompt engine emits no declarative description of the scene's contents. The source image is
the only authority on what is in the room; naming furniture or adjacent rooms in the prompt is
exactly what pushes a generative model to invent them. Each prompt carries only a neutral,
non-directional camera move (never "toward the X", which aims the model at a region it then
fabricates), the lighting, a room mood, and a hard fidelity constraint that forbids adding,
removing, moving, or inventing anything. Repeated rooms rotate through move variants, and two
identical moves in a row are automatically varied.

### Generative animation with Higgsfield

Each shot's still is animated into a five-second clip through the Higgsfield platform. The default
model is the Director-of-Photography (DoP) family, submitted with a catalog motion preset at a
deliberately **low motion strength (0.3)** (less camera travel means less occluded geometry the
model must synthesize, which is the single most effective anti-hallucination lever), and with the
platform prompt-enhancer disabled. ByteDance's Seedance is wired as an opt-in alternative
(`HIGGSFIELD_MODEL=seedance_pro`): native 1080p output and faster generation at roughly 3.5x the
per-clip cost. The engine uploads the normalized photo to the platform CDN, submits, polls to
completion, and downloads the clip. It runs two clips concurrently, isolates per-shot failures so a
single bad clip is skipped rather than fatal, and splits its retry logic so that transient
pre-submit errors are retried while a billed job is never resubmitted.

### Fidelity audit of every generated clip

After generation, a vision model compares sampled frames from each clip (one anchor near the start
plus three across the back half) against the source photo under a materiality rubric: people,
added or removed furniture, layout changes, and contradicting door-reveals are drift; softness,
lighting shifts, and plausible sliver continuations are fine. A drifted clip is marked failed,
dropped from the cut, and regenerated on resume: a shorter honest tour always beats shipping a
fabrication. The audit fails open: an audit error keeps the paid clip for a later re-check rather
than destroying it. (Verified live: a promptless test clip that invented a person walking through
a living room was correctly caught and dropped.)

### Branding and formats

Optional branding fields (property address, agent name, phone, email, logo) become a serif title
card, a contact end card, and a subtle corner logo watermark shown only during the tour. Agent
identity persists in the browser so it is typed once, not per listing. Every render also derives a
9:16 vertical cut (the master centered over a blurred fill) for Reels/TikTok/Shorts at zero extra
generation cost. Left empty, the output is a clean, unbranded video.

### Cinematic render

FFmpeg normalizes every clip to a common frame (lanczos scaling plus a light unsharp pass, so
720p source clips stay crisp on the 1080p canvas), constant frame rate and timebase, trims each
to its exact storyboard duration, and chains crossfade transitions with offsets computed so the
overall cut length is precise. Branded cards join the same crossfade chain as looped image
inputs. Output is H.264 1080p at CRF 19 with a faststart flag for instant web playback. Failed
shots are simply omitted, so a five-of-six tour still renders.

### Storyboard review screen

An optional review checkpoint pauses the run after prompting and before any paid clip generation.
The operator sees the planned tour with thumbnails, motion-preset chips, vision descriptions, and
the benched photos, and can reorder, remove, and restore shots. Approving re-paces the durations
and resumes the pipeline. No credits are spent until the plan is approved.

### In-app preview, download, and live progress

The finished tour plays inline in the browser and downloads as a single MP4. The video route
supports HTTP range requests so scrubbing works, and progress streams live over Server-Sent
Events with a replay buffer so a reconnecting client recovers the full history.

## Architecture

A monorepo of small packages with a one-way data flow. Data descends a pipeline; each engine is a
pure transform; the orchestrator owns all wiring, persistence, and progress. The server exposes the
pipeline over REST and SSE; the browser only ever drives the server.

```
                            shared job document (Project)
                    assets -> vision -> shots -> outputPath, stage
                    ______________________________________________
                   |                                              |
  Upload  ->  Vision  ->  Storyboard  ->  Prompt  ->  VideoGen  ->  Fidelity  ->  Render  ->  MP4 (+9:16)
  (sharp)    (Claude)     (rule-based)    (template)  (Higgsfield)  (Claude audit)  (FFmpeg)

  each arrow: orchestrator reads the needed slice, calls the engine,
  writes the result back, persists project.json, emits a progress event

  Browser (React/Vite/Tailwind)  <--- SSE progress / REST ---  Fastify server
        drop zone, length, review screen, live bar, player       run registry
```

Every engine implements one interface:

```ts
interface Engine<TIn, TOut> {
  readonly name: string;
  process(input: TIn, ctx: EngineContext): Promise<TOut>;
}
// EngineContext = { workDir, config, logger, progress(pct, msg) }
```

Swapping an implementation is passing a different engine into the pipeline. Mock engines exist for
every stage, so the full pipeline runs end to end with no API keys at all: the keyless demo path
produces a real, playable MP4 using color-card clips and the real FFmpeg render.

## How the pipeline computes it

The substance of the project is the discipline between the drop zone and the file. Each stage:

1. **Upload.** Each incoming photo is EXIF-rotated to upright, re-encoded to a normalized
   high-quality JPEG in the project's `source/` directory, measured for true post-rotation
   dimensions, and given a 320px thumbnail. Downstream stages can assume consistent, upright JPEGs.

2. **Vision.** Each normalized photo is downscaled and sent to the vision model under a strict JSON
   schema. The result is one record per asset: room type, description, features, lighting, suggested
   move, and quality score. Four requests run at once; per-image failures fall back rather than
   aborting the run.

3. **Storyboard.** Photos below the configured quality floor are dropped. The engine computes the
   ideal clip count `n = ceil((target - crossfade) / (clip - crossfade))`, selects that many photos
   coverage-first with a per-room cap, orders them by a canonical room priority with a stable index
   tie-break, then assigns durations by cumulative rounding so the crossfaded sum equals the target
   exactly. Thirty, forty-five, and sixty second targets resolve to seven, eleven, and fourteen clips.

4. **Prompt.** For each shot the engine derives a motion preset from the vision suggestion (or a
   rotating room variant), maps it to neutral non-directional phrasing, and composes a prompt of
   camera move plus lighting plus mood plus the fidelity constraint. No scene contents are described.

5. **VideoGen.** For each shot: request a presigned upload URL, PUT the photo bytes to the platform
   CDN, submit the returned public URL with the fidelity-first prompt, the motion preset at low
   strength (DoP) and `enhance_prompt: false`, poll the request until it completes, and download the
   clip. Two shots animate concurrently. Obtaining a request id is retried on transient errors;
   polling and download are never retried, so a slow clip is never resubmitted and never
   double-billed.

6. **Fidelity audit.** Sampled frames from each new clip are compared against the source photo.
   Material fabrications (people, invented furniture, changed layout, contradicting reveals) mark
   the shot failed so render skips it and resume regenerates it; expected generative artifacts
   pass. Audit errors fail open, keeping the paid clip for a later re-check.

7. **Render.** FFmpeg builds one `filter_complex`: normalize (lanczos + light unsharp) and trim
   every clip, plus branded title/end cards and a timeline-gated logo watermark when branding is
   set, then chain crossfades where transition `k` begins at `sum(durations[0..k-1]) - k *
   crossfade`. The graph is encoded to H.264 1080p, encode progress is parsed from FFmpeg's stderr
   time output, and a 9:16 blur-pad vertical cut is derived from the finished master.

The orchestrator persists the whole job document after every stage, so the pipeline is fully
resumable and inspectable at any point.

## Fidelity: not inventing the property

Real-estate video carries a hard constraint a generative model does not respect on its own: it must
not invent or alter the property, because inventing furniture, rooms, or features is a legal
liability. An image-to-video model synthesizes new pixels for any area a camera move reveals, and a
translational move aimed at a prompt-named target will fabricate that target. The system attacks
this on the generative path with three preventive levers plus a backstop:

- **No scene description, no directional target.** The prompt carries only a neutral move and a
  hard "do not add, remove, move, or invent anything" constraint: the image is the sole authority
  on contents.
- **Prompt-enhancer disabled.** The platform's enhancer embellishes prompts and invents detail;
  `enhance_prompt: false` is schema-validated on every submit.
- **Low motion strength (DoP).** Strength 0.3 caps camera travel, which caps how much unseen
  geometry the model must dream up. Verified live on the photo that originally produced a
  fabricated dining table: all visible content preserved.
- **The audit backstop.** Prevention cannot be total (a generative model always retains latitude),
  so every clip is audited frame-by-frame against its source photo and dropped on material drift.
  The failure mode is a regenerated clip, never a shipped fabrication.

## Resumability and cost safety

The job's `stage` is a checkpoint, not a status: it only advances once a stage's output is safely on
disk, and a failure leaves it in place with the reason recorded separately. A resume maps the saved
job to the first stage still to run and skips everything already done. Within video generation it
keeps every shot whose clip file already exists and regenerates only the missing ones, so finished
clips are never paid for twice. Upload is never re-run, because the normalized source files are the
durable artifact. The retry split and the never-resubmit-a-billed-job rule mean a single run bills at
most one clip per shot regardless of transient failures.

## Data format

One JSON document per project is the single source of truth. It carries the assets, the vision
records, the shots, the output path, and the checkpoint stage, and it is rewritten after every stage.

```json
{
  "id": "proj_99799c3f",
  "createdAt": "2026-07-10T13:12:00.000Z",
  "targetDurationSec": 30,
  "stage": "complete",
  "assets": [
    {
      "id": "asset_529ba4e8",
      "sourcePath": "projects/proj_99799c3f/source/asset_529ba4e8.jpg",
      "thumbPath": "projects/proj_99799c3f/thumbs/asset_529ba4e8.jpg",
      "originalName": "living-room.jpeg",
      "width": 2000,
      "height": 1125
    }
  ],
  "vision": [
    {
      "assetId": "asset_529ba4e8",
      "roomType": "living_room",
      "description": "bright open-concept living room with a sectional and hardwood floors",
      "features": ["hardwood flooring", "sectional sofa", "ceiling fan"],
      "lighting": "bright",
      "suggestedMove": "slow push-in",
      "qualityScore": 0.9
    }
  ],
  "shots": [
    {
      "order": 0,
      "assetId": "asset_529ba4e8",
      "roomType": "living_room",
      "durationSec": 4.93,
      "prompt": "Camera: a slow, subtle push-in with minimal travel. Bright light; ...",
      "motionPreset": "push_in",
      "higgsfieldJobId": "7e1b5932-6502-49b5-9255-4b2d8726de38",
      "clipPath": "projects/proj_99799c3f/clips/shot-00.mp4",
      "status": "done",
      "fidelityChecked": true
    }
  ],
  "branding": {
    "address": "128 Maple Grove Lane",
    "agentName": "Jane Smith",
    "phone": "(512) 555-0100",
    "email": "jane@smithrealty.com",
    "logoPath": "projects/proj_99799c3f/branding/logo.png"
  },
  "outputPath": "projects/proj_99799c3f/output/tour.mp4",
  "verticalPath": "projects/proj_99799c3f/output/tour-vertical.mp4"
}
```

## Server API

The Fastify server on port 3001 exposes the pipeline over REST plus one SSE stream.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Which engine implementations the next run will use (key-gated). |
| `POST` | `/api/runs` | Start a run. `multipart/form-data` with real photos (plus optional branding fields and a `logo` file), or `application/json` for the built-in demo set. Optional `review` flag pauses before clip spend. |
| `GET` | `/api/runs/:id` | Snapshot of a run for polling or reconnect. |
| `GET` | `/api/runs/:id/events` | SSE: `progress`, `review`, `complete`, `run-error`, with a replay buffer. |
| `GET` | `/api/projects/:id/storyboard` | The planned tour for the review screen. |
| `PATCH` | `/api/projects/:id/storyboard` | Apply review edits (new shot order or removals); re-paces durations. |
| `GET` | `/api/projects/:id/thumb/:assetId` | 320px thumbnail for the review screen. |
| `POST` | `/api/projects/:id/resume` | Resume a persisted project from its last checkpoint. |
| `GET` | `/api/projects/:id/video` | Stream the finished MP4 with range support; `?variant=vertical` for the 9:16 cut, `?download` forces an attachment. |

## Tech stack

TypeScript everywhere, because the vision step is an API call rather than a local model, so a single
language spans the whole system with no Python bridge.

### Language and workspace

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript | ESM throughout, run via `tsx` with no build step in dev. |
| Monorepo | npm workspaces | Cross-package imports via `@rev/*`. |
| Concurrency | `p-queue` style bounded map | Caps vision and video-generation fan-out. |

### Frontend

| Library | Purpose |
|---|---|
| React 19 + Vite | Single-screen tool, no SSR. |
| Tailwind v4 | Styling. |
| EventSource (SSE) | Live progress, review, completion, and error events. |

### Backend and engines

| Library | Purpose |
|---|---|
| Fastify | REST plus SSE server on port 3001. |
| `@fastify/multipart` | Streamed photo uploads to a temp dir. |
| Claude vision | Room understanding + per-clip fidelity audit, via structured JSON outputs. |
| Higgsfield image-to-video | Generative clip animation (DoP default; Seedance native-1080p opt-in). |
| `sharp` | EXIF rotate, normalize, resize, thumbnails, SVG branding cards. |
| `ffmpeg-static` | Per-clip normalize, trim, crossfade, cards/watermark, H.264 encode, 9:16 cut. |
| JSON per project | Resumable job state; a SQLite backend is the planned swap. |

## Repository layout

```
packages/
  core/              Project model, Engine contract, config, logger, ids,
                     shared SSE event types (the wire format for server and web)
  engine-upload/     sharp EXIF-rotate, normalize, thumbnail
  engine-vision/     Claude structured-output room analysis
  engine-storyboard/ quality floor, coverage-first selection, exact pacing
  engine-prompt/     fidelity-first motion-prompt composer
  engine-videogen/   Higgsfield upload, submit, poll, download (DoP + Seedance)
  engine-fidelity/   Claude frame audit: drop clips that drift from the source photo
  engine-render/     FFmpeg normalize, trim, crossfade, branding cards, encode, 9:16
  orchestrator/      pipeline runner, persistence, resume, progress
apps/
  server/            Fastify REST plus SSE, in-memory run registry with replay
  web/               React plus Vite plus Tailwind single-screen UI
scripts/             demo, analyze, storyboard preview, render, smoke tests
projects/<id>/       per-run working dir: source/ clips/ output/ project.json
```

## Setup

```bash
npm install                 # workspace symlinks
cp .env.example .env         # add ANTHROPIC_API_KEY and HIGGSFIELD_API_KEY
```

Without keys the pipeline still runs end to end on mock engines and produces a playable MP4. Add
`ANTHROPIC_API_KEY` for real Claude analysis plus the fidelity audit, and `HIGGSFIELD_API_KEY`
(format `keyId:secret`) for real generative clips. Optional: `HIGGSFIELD_MODEL=seedance_pro` for
native-1080p clips (~3.5x per-clip cost), `HIGGSFIELD_MOTION_STRENGTH` to tune the DoP fidelity
lever (default 0.3).

## Run

```bash
npm run dev:server           # Fastify API on http://127.0.0.1:3001
npm run dev:web              # Vite UI on http://localhost:5173  (second terminal)
```

Open the UI, drop in photos (or use the built-in demo set), pick a length, and Generate. Progress
streams live; the finished tour plays inline with a download button.

## Commands

```bash
npm run demo                 # full mock pipeline in the terminal, no server or keys
npm run analyze [dir]        # vision debug table on a folder of photos
npm run storyboard <id>      # replay storyboard and prompting on a saved project, no API cost
npm run render <clipsDir>    # stitch any folder of clips
npx tsx scripts/audit-clip.ts <clip> <photo>   # fidelity-audit any clip against its source
npm test                     # unit tests (node:test via tsx)
npm run typecheck            # tsc across packages, server, and web
```

## Status

The full pipeline is implemented and verified end to end: real vision analysis, storyboard
construction, fidelity-first prompting, Higgsfield generation with a low-motion-strength fidelity
lever, a per-clip fidelity audit that drops (and later regenerates) any clip that drifts from its
source photo, and an FFmpeg render with optional branding cards, logo watermark, and an automatic
9:16 vertical cut, plus a storyboard review screen, resumable runs that never re-pay for finished
clips, and in-app preview and download of both formats. Native-1080p generation via Seedance is
wired as an env-var opt-in (the default DoP model is capped at 720p, sharpened on the upscale).
Planned next: a full real-listing run to measure the audit's false-positive rate, beat-aware
pacing, and Tauri desktop packaging.

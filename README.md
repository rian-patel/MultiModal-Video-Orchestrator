# MultiModal Video Orchestrator

A **local-first web app** that turns 10–40 property photos into a single cinematic
real-estate tour video with almost no user input:

1. Drag in 10–40 photos.
2. Pick a length: **30 / 45 / 60 s**.
3. Click **Generate**.

The app auto-analyzes each photo (what room it is), orders them into a logical house
tour, writes cinematic motion prompts, animates each photo via
[Higgsfield](https://higgsfield.ai) (image→video), stitches the clips with FFmpeg, and
presents a downloadable MP4 you can preview in the browser.

Runs entirely on your machine with your own API keys — no hosting, auth, or billing.

## Architecture

A pipeline of independent, swappable **engines**, each a pure transform enriching one
shared `Project`. The orchestrator does all wiring; engines never call each other.

```
Upload → Vision → Storyboard → Prompt → VideoGen → Render → download
```

| Engine | Does | Impl |
|---|---|---|
| Upload | validate, EXIF-rotate, normalize, thumbnail | sharp |
| Vision | room type + description + lighting + quality per photo | Claude (vision) |
| Storyboard | quality floor, coverage-first selection, exact pacing | rule-based |
| Prompt | cinematic motion prompt per shot | template composer |
| VideoGen | animate each photo to a clip | Higgsfield (REST) |
| Render | trim, crossfade, encode H.264 1080p | FFmpeg |

Keyless runs use mock Upload/Vision/VideoGen but the **real** FFmpeg render, so
`npm run demo` still produces a playable MP4. See [CLAUDE.md](CLAUDE.md) for the full
design, conventions, and build phases.

## Stack

TypeScript everywhere · npm workspaces · React 19 + Vite + Tailwind (web) · Fastify
(server, REST + SSE) · FFmpeg via `ffmpeg-static`.

## Setup

```bash
npm install                 # sets up workspace symlinks
cp .env.example .env        # optional: add ANTHROPIC_API_KEY / HIGGSFIELD_API_KEY
```

Without keys the pipeline runs end-to-end on mock engines. Add `ANTHROPIC_API_KEY` for
real Claude photo analysis and `HIGGSFIELD_API_KEY` (`key:secret`) for real clips.

## Run

```bash
npm run dev:server   # Fastify API on http://127.0.0.1:3001
npm run dev:web      # Vite UI on http://localhost:5173  (second terminal)
```

Open http://localhost:5173, optionally drop in photos (or use the built-in demo set),
pick a length, and Generate. Progress streams live; the finished tour plays in-app with
a download button.

## Other commands

```bash
npm run demo         # full mock pipeline in the terminal, no server needed
npm run analyze [dir]# Claude vision debug table on a folder of photos
npm test             # unit tests (node:test via tsx)
npm run typecheck    # tsc --noEmit across packages + web
```

## Status

MVP through **Phase 7**: full pipeline, resumable runs (never re-pays for finished
Higgsfield clips), in-app preview + download. Next: storyboard review screen, video
upscaling, beat-aware pacing, Tauri desktop packaging.

---
name: verify
description: How to launch and drive this app to verify changes at runtime (server API + web UI).
---

# Verifying the Real Estate Video Generator

## Launch

Two background processes (both `tsx watch`, auto-restart on edit):

```bash
npm run dev:server   # Fastify API on http://127.0.0.1:3001
npm run dev:web      # Vite UI on http://localhost:5173 (/api proxied to 3001)
```

Ready check: `GET http://127.0.0.1:3001/api/health` →
`{ ok, service, engines: { vision, videogen } }`. `engines` tells you which
implementations the next run will use (key-gated: `claude`/`higgsfield` vs `mock`).

## IMPORTANT: never spend API credits during verification

- `.env` may contain real `ANTHROPIC_API_KEY` / `HIGGSFIELD_API_KEY`.
- **JSON demo runs are always safe** — `POST /api/runs` with
  `{"targetDurationSec":30}` uses mock engines regardless of keys, and still
  produces a real playable MP4 (mock videogen emits real color clips + real
  FFmpeg render).
- **Multipart runs with real photos hit the real APIs when keys are set.**
  Higgsfield charges ~5 credits/clip. Don't do this unless the user asked.

## Drive

- Browser (Playwright MCP): open `localhost:5173`, pick a length (30s is the
  fastest: 7 clips), click Generate. Demo run completes in ~30–60 s. The
  complete card has a `<video>` element — check `duration`, `videoWidth`, play
  and seek it (seeking exercises the server's Range handling).
- API only: `POST /api/runs` (JSON) → `202 {runId}` → poll `GET /api/runs/:id`
  until `status: complete`, or stream `GET /api/runs/:id/events` (SSE; events
  `progress`/`complete`/`run-error`, replay buffer means late subscribers get
  full history).
- Video: `GET /api/projects/:id/video` (supports `Range:`; `?download` adds
  content-disposition).
- Resume: tamper `projects/<id>/project.json` (set `stage: "generating"`, mark
  some shots `failed` + delete their `clipPath` files) then
  `POST /api/projects/:id/resume` — progress should say
  "Resuming: N/M clips already generated" and kept clips' mtimes must not change.
- Review flow: `POST /api/runs` with `{"targetDurationSec":30,"review":true}` →
  run status becomes `review` (~1 s, no clips made). `GET /api/projects/:id/storyboard`,
  `PATCH` it with a reordered/reduced `assetIds` list (totals re-pace: same count →
  exact target; fewer → n*5 − (n−1)*0.75), then `POST .../resume` to animate.
  Probe the output MP4 duration — it must match the PATCHed plan (±0.05 s).

## Gotchas

- Runs live in memory: restarting the server (any edit under `apps/server` or
  `packages` triggers tsx watch) 404s old run ids — that's the designed
  connection-loss path, not a bug. Durable state is `projects/<id>/project.json`.
- Output artifacts land in `projects/<id>/output/tour.mp4` (repo root,
  gitignored). Test tampering is safe there.
- `curl.exe` exists on Windows; use it from Git Bash for Range/SSE probes.

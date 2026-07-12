# Engineering Audit (2026-07-11)

Full security, architecture, code-quality, and product review of the repo at commit `c6ec6d5`
(post-H1 hosted skeleton, pre-launch). Every file was read for this audit; nothing was assumed
correct. Verdict up front: **the codebase is in genuinely good shape for its age**. No remote code
execution, no injection paths, no leaked secrets, and the money-safety invariants (never resubmit
a billed job, never re-pay for a finished clip) hold everywhere they were checked. The serious
findings are all about what happens when other people can reach the system: the hosted alpha has
launch blockers around spend control, and the local server has a drive-by CSRF surface because
starting a run costs real money.

Conventions: severities are per-finding; the roadmap at the end assigns priorities. "Hosted-gate"
means: must be fixed before the first outside user is invited, but nothing is exposed today
because the hosted accounts do not exist yet.

---

## 1. Security audit

### 1.1 What was checked and found clean

| Area | Result |
|---|---|
| Command injection | Clean. All FFmpeg/sharp invocations use `spawn(bin, argsArray)` with no shell (`windowsHide`, no `shell: true`). No `exec`, `execSync`, `eval`, or `new Function` anywhere. Filter graphs are built from numbers and server-generated paths; user text never enters a filter string. |
| SVG/card injection | Clean. User branding text is XML-escaped (`cards.ts esc()`, covered by a test with hostile input). |
| XSS | Clean. React escaping throughout; no `dangerouslySetInnerHTML`; user filenames and Claude output render as text nodes. |
| Path traversal | Clean. `readProject` gates ids with `/^[\w-]+$/`; multipart filenames pass through `basename()` + character allowlist; thumb/video routes serve only paths recorded in the project document, never request-supplied paths. Edge functions re-validate storage paths against the caller's own prefix. |
| Secrets | Clean. `.env` was never committed (verified against full git history); no key material in any tracked file; logs print key *presence*, never values; Higgsfield error bodies are sliced (200 chars) and contain no credentials. |
| Server exposure | Good. Fastify binds `127.0.0.1` explicitly. Vite proxies `/api` so the browser is same-origin and no CORS is configured (correct posture). |
| Upload handling | Good. Multipart limits: 40 files, 30 MB each, streamed to a per-run temp dir that is removed in a `finally`. Sharp re-encodes every image (EXIF-rotated, normalized JPEG), which also strips metadata incl. GPS EXIF from what downstream sees. Sharp's default `limitInputPixels` (~268 MP) guards decompression bombs. Content is validated by *parsing*, not by MIME/extension, which is the strong form. |
| Hosted RLS | Good design. Owner-only SELECT on `projects`/`run_events`; storage INSERT restricted to the caller's own folder prefix; artifacts bucket writable only by the service role; Realtime `postgres_changes` respects RLS. Edge functions derive the user from a verified JWT and never trust client-supplied user ids. |
| CSRF (hosted) | OK. Edge functions authenticate via `Authorization` bearer, not cookies, so cross-site request forgery has nothing to ride on. `Access-Control-Allow-Origin: *` is acceptable in that model (tighten to the Vercel origin later as polish). |
| Money invariants | Verified in code + tests. Submit/poll retry split (a billed job is never resubmitted), resume keeps clips on disk/storage, hosted task retries hard-disabled with an explanatory comment, fidelity audit fails open so an audit error can never destroy a paid clip. |

### 1.2 Findings

**S1. Local API is CSRF-reachable and spends money. Severity: Medium-High (local), fix before
long-lived daily use.**
The Fastify server has no authentication (by design, local-first) and `POST /api/runs` accepts
`multipart/form-data` and JSON. A multipart POST is a "simple request": any malicious web page the
operator visits while the dev server runs can fire a cross-origin POST at
`http://127.0.0.1:3001/api/runs` without triggering CORS preflight. It cannot read the response,
but it does not need to: the side effect (starting runs, burning Anthropic/Higgsfield credits,
filling disk) is the damage. DNS rebinding extends the same reach to the JSON endpoints.
*Fix:* require a custom header (e.g. `x-rev-client: web`) on all mutating routes and send it from
`api.ts` (custom headers force preflight, which the browser then blocks cross-origin), plus
validate the `Host` header is `127.0.0.1:3001`/`localhost:3001`. Two small changes, no UX impact.

**S2. Hosted has no per-user spend controls. Severity: Critical for hosted. Hosted-gate.**
`start-run` validates count/ownership but any invited user can start unlimited runs, including
concurrent ones. Each run bills the owner's keys (roughly $4 to $7). There is no per-user run cap,
no global concurrency cap, no cooldown. One enthusiastic (or compromised) tester can drain the
Higgsfield balance in an afternoon.
*Fix:* a `runs` table row per enqueued run (user_id, project_id, status, created_at) written by the
edge functions, with (a) max N active runs per user (check-then-insert; a partial unique index on
`(user_id) where status='active'` makes it race-proof for N=1), and (b) max M runs per user per day.
Trivially extended into the H2 credit ledger later.

**S3. Concurrent resume double-bills. Severity: High (money). Hosted-gate; Medium locally.**
Nothing stops two `resume-run` calls (or a resume racing a still-running task) on the same project.
Two workers then regenerate the same missing shots: double Higgsfield spend, interleaved
checkpoint upserts (last-write-wins on the whole JSONB document), and interleaved storage writes.
The local server has the same race on `POST /api/projects/:id/resume`, though locally the only
victim is the operator.
*Fix (hosted):* Trigger.dev queue concurrency keys: give `generate-tour` a queue keyed by
`projectId` with concurrency 1 so duplicate triggers serialize instead of racing, and have the
task exit fast when the project row shows an active run or a terminal stage. *Fix (local):* the
registry tracks an active run per projectId; reject a second resume with 409.

**S4. Hosted worker silently falls back to mock engines. Severity: Medium. Hosted-gate.**
`hostedEngines()` mirrors the local server's key-gating: no `ANTHROPIC_API_KEY` means mock vision
and mock fidelity. That is correct locally (demo mode is a feature) and wrong hosted: a
misconfigured worker would burn Higgsfield credits generating clips ordered by mock room
classifications, or worse, ship un-audited clips. *Fix:* the worker should throw at startup when
either key is missing. Hosted has no legitimate mock mode.

**S5. Storage abuse limits are configuration, not code. Severity: Medium. Hosted-gate.**
The browser uploads photos directly to the `photos` bucket. RLS confines writes to the user's own
folder, but there is no size or count limit on that path: a user (or a script with their JWT) can
upload arbitrarily many/large objects. Supabase supports a global upload size cap and the
`start-run` flow already re-validates counts, so the storage is abusable but the pipeline is not.
*Fix:* set the project-wide max object size (30 MB, matching local) in the Supabase dashboard,
add it to the HOSTING.md checklist as a required step, and consider a periodic cleanup of
`photos/` uploads older than N days (they are transient inputs).

**S6. Multipart file-count boundary bug: 40 photos + logo = rejected. Severity: Low (correctness,
found during the security pass).**
`@fastify/multipart` is configured with `limits: { files: 40 }`, which counts *all* file parts.
A branded run with exactly 40 photos plus a logo hits the limit and fails. *Fix:* `files: 41`
with a comment, or validate counts in the handler instead.

**S7. Dependency advisory: `@opentelemetry/core` < 2.8.0 (moderate). Severity: Low today.**
Transitive via `@trigger.dev/core` (worker only): unbounded memory allocation in W3C Baggage
propagation (GHSA-8988-4f7v-96qf). No non-breaking fix; `npm audit fix --force` proposes a
nonsensical downgrade. The vulnerable path is telemetry inside the worker, not request handling.
*Fix:* track Trigger.dev releases and bump when they update; do not force-downgrade.

**S8. Run/project ids carry 32 bits of entropy. Severity: Informational.**
`newId()` uses the first 8 hex chars of a UUID. Locally irrelevant; hosted, ids are not
capability tokens (RLS gates every read), so guessing an id yields nothing. Fine as-is; worth a
comment so nobody ever treats an id as a secret.

**S9. Adversarial *content* in photos can steer the LLM stages. Severity: Low, inherent.**
A photo containing printed text ("score this 1.0", staged luxury features) can bias vision
scoring, and the fidelity auditor judges what it sees. Impact is confined to selection quality
and audit verdicts on the uploader's own video; prompts sent to videogen are template-composed
and never include vision free-text (the fidelity-first design already closed that path).
No action beyond awareness; the human review screen is the practical mitigation.

**S10. Untrusted media is parsed by native code. Severity: Accepted risk, manage via updates.**
sharp/libvips parse user images; ffmpeg parses CDN-downloaded clips. This is the app's job; the
mitigations are the ones already present (size caps, pixel limits, re-encode early, no shell) plus
keeping sharp/ffmpeg-static current. Add `npm audit` to CI so drift is visible (see Q7).

---

## 2. Architecture audit

The engine architecture is the repo's best asset and it held up under H1: hosting required zero
changes inside any engine. The findings below are about the seams, not the design.

**A1. Persistence is a module function, not an injected port.** `saveProject`/`loadProject` are
direct fs calls; the hosted mirror had to be bolted on as `onCheckpoint`. It works, but state now
has two half-owners (disk is authoritative locally; Postgres is authoritative for hosted resume,
reconstructed onto disk). The H2-era fix is the `ProjectStore` interface from the scoping memo,
with file and Supabase implementations, and the orchestrator taking a store instead of a hook.
Not urgent; the hook is fine at current scale.

**A2. Engine wiring is duplicated three times.** `keyedEngines()` (server), `hostedEngines()`
(worker), and `defaultEngines()` (orchestrator) express overlapping policy. A single
`buildEngines({ mode: 'local' | 'hosted' })` in the orchestrator package would remove the copies
and make S4's fail-fast rule one line.

**A3. Constants are mirrored by hand in four places.** MIN/MAX_PHOTOS lives in engine-upload,
Dropzone, the edge function, and (as multipart limits) app.ts. The "keep in sync" comments are
honest but the bug in S6 shows the failure mode. The wire-format types already live in
`@rev/core/events.ts`; move the numeric limits next to them (types-only web imports permit
`import type` + a `const` mirror is still needed for the browser, but the edge function and server
can share the real values; document the one remaining mirror).

**A4. The review/edit domain logic lives in a route handler.** `PATCH /storyboard`'s validation +
re-pacing and `buildReviewData` are pure domain logic stranded in `apps/server/routes/runs.ts`,
which is why hosted mode had to ship without the review flow. Extract into
`@rev/orchestrator` (or a small `@rev/review` module) so the hosted edge function/worker and the
local route call the same function. This is also the P1 product gap (see p2).

**A5. Stage/progress model has a cosmetic wart.** Fidelity runs inside the videogen checkpoint
(a sound persistence decision) but reuses stage index 4 for progress, so the global bar rewinds
within the videogen band when the audit starts. Either give the progress mapper a sub-stage
weighting or label the audit phase distinctly in messages. Cosmetic; users see a jumping bar.

**A6. `buildReviewData`/`PATCH` use `defaultConfig` while routes take an injected `config`.**
Latent divergence: today only `projectsDir` differs, so re-pacing is correct, but the first
test/config that changes `clipDurationSec` will silently re-pace against stale constants. Pass
the route `config` through.

**A7. Worker time budget is under the theoretical worst case.** `maxDuration: 7200` vs the honest
worst case of 14 clips x up to 20 min poll at concurrency 2 (~8400s + render). Realistic runs are
15 to 30 min, but the budget should not be the thing that kills a slow-but-billed run: raise to
10800 and keep the per-clip `maxPollMs` as the real guard.

**A8. `RunRegistry` grows without bound.** Every run's full event buffer lives in memory for the
server's lifetime. Days-long dev sessions with many runs will creep. Cap the buffer per run
(replay only needs the last progress + terminal events... actually replay wants history; cap at a
few hundred events) and evict terminal runs after an hour. Local-only concern.

**A9. Hosted event payloads carry `storage://` URLs by convention.** The `CompleteEventData`
contract is shared, but hosted smuggles a different URL scheme through the same field, resolved
client-side. It works and is documented in code; when the review flow goes hosted, consider an
explicit `artifactKeys` field on the event instead of the scheme convention.

---

## 3. Code quality audit

**Q1. Test coverage is strong where money moves, absent where files enter.** 61 tests cover
storyboard math, prompts, videogen retry/billing semantics, fidelity verdict handling, render
graphs/cards, hosted adapters, orchestrator resume, and server routes. Zero tests cover:
engine-upload (EXIF rotation, junk-file rejection: the input boundary), engine-vision's
`sanitize()` (cheap pure function), `hostedRun` glue (fresh/resume flows against the fake
Supabase already built for adapter tests), and the edge functions (Deno; would need a separate
runner, acceptable to leave manual). Priority: upload engine and `sanitize`, then `hostedRun`.

**Q2. The test runner is a hand-maintained file list.** `npm test` enumerates seven paths;
`cards.test.ts` was forgotten when first written and only caught later (this actually happened).
Switch to a glob (`tsx --test "packages/**/src/*.test.ts" "apps/server/src/**/*.test.ts"`), or
generate the list. One-line fix that prevents silent non-running tests.

**Q3. No CI.** Tests and typecheck run only when someone remembers. A 15-line GitHub Actions
workflow (`npm ci && npm run typecheck && npm test` on push/PR) plus `npm audit --audit-level
high` would have every guarantee in this repo continuously verified. The deploy-hosted workflow
exists; the verify workflow does not. High value, near-zero cost.

**Q4. `saveProject` is not crash-atomic.** `writeFile` truncates then writes; a crash mid-write
corrupts `project.json` and severs resume for that project (the money-safety feature). Write to
`project.json.tmp` then `rename` (atomic on the same volume). Three lines.

**Q5. Race in concurrent local resumes** is S3's local face; noted here because the fix
(active-run tracking in the registry) is code-quality-sized.

**Q6. Minor smells, all deliberate-looking and low-cost:**
- `pan` maps to the *Dolly Left* motion UUID and `lateral_glide` to *Dolly Right* (semantic
  mismatch: pan is rotational). Either rename or map to a true pan preset if the catalog has one.
- `MockRenderEngine` is exported but nothing uses it (orchestrator tests build their own stub).
  Keep (it is the documented mock for the engine slot) or delete; decide once.
- `scripts/generate-real.ts` duplicates upload-engine logic to skip the 10-photo floor; fine for
  a debug script, but a `minPhotos` option on `LocalUploadEngine` would delete 40 lines.
- `estimateTotalSec` in ReviewScreen mirrors `paceDurations` by hand (flagged by comment; A4's
  extraction is the real fix).
- Logger is console-only with no levels/redaction; fine local, worth revisiting when hosted
  observability matters (Trigger.dev captures stdout, so it already works there).

**Q7. Dependency hygiene is good** (lockfile committed, one moderate transitive advisory, no
unused heavyweight deps found). `ffmpeg-static` downloads a binary at install: pin exact versions
(no `^`) for it and `sharp` if supply-chain posture tightens; CI `npm audit` covers the rest.

---

## 4. Product audit

**P1. The dual local/hosted architecture is currently justified, but hold the line.** Local-first
is the dev/verification environment and the future Tauri product; hosted is the revenue bet. The
H1 implementation kept engines 100% shared, which is the only reason both are affordable. The
discipline to enforce: new *domain* features (review parity, pacing, branding) must land in
packages, never in `apps/server` or `apps/worker` directly. A4 is the current violation to fix.

**P2. Review-before-spend is missing exactly where it matters most.** Locally, the review screen
gates credit spend and defaults ON. Hosted (where the *owner's* money is spent by *other* people)
runs go straight through. This inversion is the biggest product-shaped risk in the alpha. After
A4's extraction, hosted review is: worker honors `stopAfter: 'prompted'` + emits the existing
`review` event + one edge function to accept edited storyboards + resume. Ship it in H1.5, before
or immediately after first invites.

**P3. Fidelity audit false-positive rate is still unmeasured.** Every FP costs a clip
regeneration; hosted, that is real margin. Before pricing (H2), run the planned full real-photo
batch and record verdicts vs human judgment. The `audit-clip.ts` tool makes this a one-afternoon
task.

**P4. Missing table stakes for actual users, correctly deferred but list them:** project history
("my tours") backed by the `projects` table that already exists, delete-my-data (storage + rows),
terms of service + AI-generated-content disclosure (real-estate marketing has truth-in-advertising
exposure; the fidelity audit is a genuine differentiator here, market it), and an email on run
completion (runs take 20+ minutes; nobody watches a progress bar that long).

**P5. Challenge on assumptions, as requested:**
- *Is 32 bits of id entropy + RLS enough hosted?* Yes, because ids are not capabilities. Revisit
  only if any route ever serves by id without RLS.
- *Is JSONB-document-in-Postgres a real store or a shortcut?* It is the right H1 call (identical
  semantics to project.json, trivial resume) and will be wrong once queries need shot-level data
  (H2 analytics, credit refunds per shot). The promoted-columns pattern gives an escape hatch;
  do not add more JSON-blob consumers than the worker.
- *Should the local demo mode survive?* Yes: it is the zero-cost E2E test and the reason the
  test suite can exercise the full pipeline. Keep it out of hosted (already done).
- *Is Higgsfield single-vendor risk?* Yes, and accepted for now. The engine seam plus the
  documented Seedance/Kling/Minimax probes mean a second vendor is an engine away. Do not build
  the abstraction until a second vendor is actually wanted (YAGNI).

---

## 5. Prioritized roadmap

P0 = do before the next milestone advances (for hosted items: hard gate on the first invite).
P1 = high, schedule next. P2 = medium, batch opportunistically. P3 = nice to have.

| # | Priority | Item | Source | Why this priority |
|---|---|---|---|---|
| 1 | **P0 (hosted gate)** | Per-user run caps + active-run limit in edge functions | S2 | Uncapped third-party spend of owner money; cheapest possible abuse |
| 2 | **P0 (hosted gate)** | Project-keyed concurrency (Trigger.dev queue key) + reject duplicate resume | S3 | Double-billing race; silent money loss |
| 3 | **P0 (hosted gate)** | Worker fails fast without API keys | S4 | Mock output for real users / unaudited clips |
| 4 | **P0 (hosted gate)** | Supabase max-object-size config + HOSTING.md step | S5 | Storage abuse; one dashboard setting |
| 5 | **P1** | CSRF/rebinding hardening on local server (custom header + Host check) | S1 | Drive-by page can spend credits while dev server runs; two small changes |
| 6 | **P1** | CI workflow: typecheck + tests + audit on push | Q3 | Every other guarantee depends on these actually running |
| 7 | **P1** | Extract review/pacing domain logic from server routes | A4/P2 | Unblocks hosted review; removes the mirrored math |
| 8 | **P1** | Hosted review-before-spend flow (H1.5) | P2 | Cost-safety inversion in the alpha |
| 9 | **P1** | Upload-engine + vision-sanitize tests | Q1 | The untested input boundary |
| 10 | **P1** | Fidelity FP-rate measurement on a real batch | P3 | Blocks honest pricing; one afternoon |
| 11 | **P2** | Multipart `files: 41` boundary fix | S6 | Real but rare (exactly 40 photos + logo) |
| 12 | **P2** | Atomic `saveProject` (tmp + rename) | Q4 | Protects the resume guarantee against crashes |
| 13 | **P2** | Unify engine wiring (`buildEngines(mode)`) | A2 | Deletes duplication; carries fix #3 structurally |
| 14 | **P2** | Test-runner glob instead of file list | Q2 | Prevents silently-skipped tests (has already happened once) |
| 15 | **P2** | Worker `maxDuration` 10800; pass route `config` into review data | A7/A6 | Cheap correctness margins |
| 16 | **P2** | Shared limits in `@rev/core` (photo counts/sizes) | A3 | Kills the hand-mirroring class of bug |
| 17 | **P2** | Completion email + "my tours" list (hosted) | P4 | First-user experience; runs take 20+ min |
| 18 | **P3** | RunRegistry eviction; progress sub-stages; `pan` motion mapping; MockRenderEngine decision; logger levels; ToS/disclosure page; pin sharp/ffmpeg-static exact; tighten edge CORS to the Vercel origin | A8/A5/Q6/S7/P4 | Real but none block anything |

Explicitly **not** recommended now: swapping persistence to a full relational schema (A1 escape
hatch exists), multi-vendor videogen abstraction (P5), Temporal-class orchestration, or any
rewrite. The architecture is carrying its weight.

---

## 6. What was fixed during this audit

The audit itself changed no code. **The four P0 hosted gates were then implemented in a
follow-up (2026-07-12, before any hosted account exists), items 1-4 above:**

- **#1 (S2) per-user spend caps:** `runs` ledger table (migration `0002`), reserved by the edge
  functions via the service role (users cannot forge it), gated by the pure `evaluateRunGate`
  policy (`supabase/functions/_shared/runs.ts`, unit-tested): max 1 active run/user, 20/day, with
  a 2h stale window so a crashed worker never wedges a user. The worker marks the row terminal
  (`SupabaseRunLedger`).
- **#2 (S3) duplicate-resume double-bill:** the `generate-tour` task now has
  `queue.concurrencyLimit: 1` (global serialization: two triggers for the same project can never
  execute at once), plus an `idempotencyKey` on resume triggers as belt-and-suspenders. Chosen
  over a per-user concurrency key so total in-flight Higgsfield jobs stay at the account's 2-job
  ceiling.
- **#3 (S4) worker mock fallback:** `hostedRun` fails fast when either API key is missing,
  reporting a clean run-error and spending nothing.
- **#4 (S5) storage caps:** migration `0002` sets the photos bucket to 30 MB / image mime types
  only (code, not a dashboard step).

67 tests pass (6 new). Remaining findings (S1, S6-S10, all architecture/quality/product items)
stay in the roadmap; none were changed. The next milestone is now unblocked on code and waits
only on account creation + one live E2E run.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { defaultConfig, newId } from '@rev/core';
import type { Branding, Project, ReviewEventData, ReviewShot, Shot } from '@rev/core';
import {
  loadProject,
  nextStage,
  resumePipeline,
  runPipeline,
  saveProject,
  type PipelineEngines,
  type RunResult,
} from '@rev/orchestrator';
import { paceDurations } from '@rev/engine-storyboard';
import {
  LocalUploadEngine,
  MAX_PHOTOS,
  MIN_PHOTOS,
  type SourceFile,
  type UploadRequest,
} from '@rev/engine-upload';
import { ClaudeVisionEngine } from '@rev/engine-vision';
import { ClaudeFidelityEngine } from '@rev/engine-fidelity';
import { HiggsfieldVideoGenEngine } from '@rev/engine-videogen';
import { PROJECTS_DIR } from '../paths';
import type { Run, RunEvent, RunRegistry } from '../runs';

interface StartRunJsonBody {
  targetDurationSec?: number;
  /** Demo mode: names only, runs through the mock Upload Engine. */
  sourceNames?: string[];
  /** Pause at the storyboard review checkpoint instead of animating straight through. */
  review?: boolean;
  /** Agent/property branding (text fields only in JSON mode — no logo). */
  branding?: { address?: string; agentName?: string; phone?: string; email?: string };
}

/** Multipart text fields that map straight onto Branding. */
const BRANDING_FIELDS = ['address', 'agentName', 'phone', 'email'] as const;

const DEMO_SOURCES = Array.from({ length: 14 }, (_, i) => `DEMO_${String(i + 1).padStart(2, '0')}.jpg`);

/** Custom SSE event names. 'error' is reserved by EventSource itself. */
const SSE_NAME: Record<RunEvent['type'], string> = {
  progress: 'progress',
  review: 'review',
  complete: 'complete',
  error: 'run-error',
};

type TourLength = 30 | 45 | 60;

function parseTarget(value: unknown): TourLength | null {
  const n = Number(value);
  return n === 30 || n === 45 || n === 60 ? n : null;
}

/** Engines unlocked by API keys in .env; everything else stays mock. */
function keyedEngines(): Partial<PipelineEngines> {
  const engines: Partial<PipelineEngines> = {};
  if (process.env.ANTHROPIC_API_KEY) {
    engines.vision = new ClaudeVisionEngine();
    engines.fidelity = new ClaudeFidelityEngine();
  }
  if (process.env.HIGGSFIELD_API_KEY) engines.videogen = new HiggsfieldVideoGenEngine();
  return engines;
}

/** Load a project by id, or null for bad ids / unknown projects. */
async function readProject(projectsDir: string, id: string): Promise<Project | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return await loadProject(join(projectsDir, id));
  } catch {
    return null;
  }
}

/**
 * Byte range for a single-range Range header (what <video> seeking sends).
 * null = no/ignorable header (serve full file); 'invalid' = 416.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix form "bytes=-N": the final N bytes
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function registerRunRoutes(
  app: FastifyInstance,
  registry: RunRegistry,
  projectsDir: string = PROJECTS_DIR,
): void {
  const config = { ...defaultConfig, projectsDir };

  // Start a pipeline run. Two content types:
  //  - multipart/form-data: real photos ("photos" file parts + "targetDurationSec"
  //    field) -> streamed to a temp dir -> real LocalUploadEngine.
  //  - application/json: demo mode (names only) -> mock Upload Engine.
  // Returns immediately; progress streams over SSE.
  app.post('/api/runs', async (req, reply) => {
    if (req.isMultipart()) {
      const uploadDir = join(tmpdir(), 'rev-uploads', newId('up'));
      await mkdir(uploadDir, { recursive: true });
      const cleanup = () => rm(uploadDir, { recursive: true, force: true }).catch(() => {});

      let target: TourLength | null = null;
      let review = false;
      const sources: SourceFile[] = [];
      const branding: Branding = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'logo') {
              const ext = (part.filename?.match(/\.(png|jpe?g|webp)$/i)?.[0] ?? '.png').toLowerCase();
              const tmpPath = join(uploadDir, `logo${ext}`);
              await pipeline(part.file, createWriteStream(tmpPath));
              branding.logoPath = tmpPath;
              continue;
            }
            if (part.fieldname !== 'photos') {
              part.file.resume(); // drain unknown file fields
              continue;
            }
            const originalName = part.filename || `photo-${sources.length + 1}.jpg`;
            const safe = basename(originalName).replace(/[^\w.\- ]/g, '_');
            const tmpPath = join(uploadDir, `${sources.length}-${safe}`);
            await pipeline(part.file, createWriteStream(tmpPath));
            sources.push({ originalName, tmpPath });
          } else if (part.fieldname === 'targetDurationSec') {
            target = parseTarget(part.value);
          } else if (part.fieldname === 'review') {
            review = ['1', 'true', 'on'].includes(String(part.value).toLowerCase());
          } else if ((BRANDING_FIELDS as readonly string[]).includes(part.fieldname)) {
            const v = String(part.value).trim();
            if (v) branding[part.fieldname as (typeof BRANDING_FIELDS)[number]] = v;
          }
        }
      } catch (err) {
        await cleanup();
        throw err;
      }

      if (target === null) {
        await cleanup();
        return reply.code(400).send({ error: 'targetDurationSec must be 30, 45 or 60' });
      }
      if (sources.length < MIN_PHOTOS || sources.length > MAX_PHOTOS) {
        await cleanup();
        return reply.code(400).send({
          error: `Expected ${MIN_PHOTOS}-${MAX_PHOTOS} photos, received ${sources.length}.`,
        });
      }

      // Real photos -> real engines (each one only when its key is present).
      const run = registry.create();
      void trackRun(
        registry,
        run,
        () =>
          runPipeline({
            request: { sources },
            targetDurationSec: target,
            engines: { upload: new LocalUploadEngine(), ...keyedEngines() },
            config,
            branding: Object.keys(branding).length > 0 ? branding : undefined,
            stopAfter: review ? 'prompted' : undefined,
            onProject: (projectId) => { run.projectId = projectId; },
            onProgress: (pct, stage, msg) =>
              registry.emit(run.id, { type: 'progress', data: { pct, stage, msg } }),
          }),
        cleanup,
      );
      return reply.code(202).send({ runId: run.id, photoCount: sources.length });
    }

    // JSON demo branch
    const body = (req.body ?? {}) as StartRunJsonBody;
    const target = parseTarget(body.targetDurationSec);
    if (target === null) {
      return reply.code(400).send({ error: 'targetDurationSec must be 30, 45 or 60' });
    }
    const names = body.sourceNames?.length ? body.sourceNames : DEMO_SOURCES;
    const request: UploadRequest = {
      sources: names.map((originalName) => ({ originalName })),
    };

    const run = registry.create();
    void trackRun(registry, run, () =>
      runPipeline({
        request,
        targetDurationSec: target,
        config,
        branding: body.branding,
        stopAfter: body.review ? 'prompted' : undefined,
        onProject: (projectId) => { run.projectId = projectId; },
        onProgress: (pct, stage, msg) =>
          registry.emit(run.id, { type: 'progress', data: { pct, stage, msg } }),
      }),
    );
    return reply.code(202).send({ runId: run.id });
  });

  // Snapshot of a run (for polling / reconnect).
  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = registry.get(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const last = run.events[run.events.length - 1];
    return {
      id: run.id,
      status: run.status,
      projectId: run.projectId,
      createdAt: run.createdAt,
      lastEvent: last ?? null,
    };
  });

  // Live progress stream: replays buffered events, then follows.
  app.get('/api/runs/:id/events', (req, reply) => {
    const { id } = req.params as { id: string };
    const run = registry.get(id);
    if (!run) {
      void reply.code(404).send({ error: 'run not found' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const write = (e: RunEvent) =>
      reply.raw.write(`event: ${SSE_NAME[e.type]}\ndata: ${JSON.stringify(e.data)}\n\n`);

    for (const e of run.events) write(e);
    const unsubscribe = registry.subscribe(id, write);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // Resume a failed/interrupted project from its last checkpoint. Completed
  // stages are skipped; clips already on disk are never regenerated.
  app.post('/api/projects/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const from = nextStage(project);
    if (from === 'complete') {
      return reply.code(409).send({ error: 'Project is already complete.' });
    }
    if (from === 'upload' || from === null) {
      return reply.code(409).send({ error: 'This project cannot be resumed — start a new run.' });
    }

    const run = registry.create();
    run.projectId = id;
    void trackRun(registry, run, () =>
      resumePipeline({
        projectId: id,
        engines: keyedEngines(),
        config,
        onProgress: (pct, stage, msg) =>
          registry.emit(run.id, { type: 'progress', data: { pct, stage, msg } }),
      }),
    );
    return reply.code(202).send({ runId: run.id, projectId: id, resumeFrom: from });
  });

  // The storyboard as the review screen shows it (shots + benched photos).
  app.get('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.shots.length === 0) {
      return reply.code(409).send({ error: 'no storyboard yet — the run has not reached that stage' });
    }
    return buildReviewData(project);
  });

  // Apply review edits: `assetIds` is the new tour (a subset of the current
  // shots, in order). Durations are re-paced to the target. Only valid while
  // the project is paused at the 'prompted' checkpoint.
  app.patch('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.stage !== 'prompted') {
      return reply.code(409).send({
        error: `storyboard can only be edited while awaiting review (stage is "${project.stage}")`,
      });
    }
    const { assetIds } = (req.body ?? {}) as { assetIds?: unknown };
    if (
      !Array.isArray(assetIds) ||
      assetIds.length === 0 ||
      !assetIds.every((x): x is string => typeof x === 'string')
    ) {
      return reply.code(400).send({ error: 'assetIds must be a non-empty array of shot asset ids' });
    }
    if (new Set(assetIds).size !== assetIds.length) {
      return reply.code(400).send({ error: 'assetIds contains duplicates' });
    }
    const byAsset = new Map(project.shots.map((s) => [s.assetId, s]));
    const unknown = assetIds.filter((a) => !byAsset.has(a));
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `unknown shot asset ids: ${unknown.join(', ')}` });
    }

    const durations = paceDurations(
      assetIds.length,
      project.targetDurationSec,
      defaultConfig.clipDurationSec,
      defaultConfig.crossfadeSec,
    );
    project.shots = assetIds.map((assetId, i) => ({
      ...(byAsset.get(assetId) as Shot),
      order: i,
      durationSec: durations[i],
    }));
    await saveProject(join(projectsDir, id), project);
    return buildReviewData(project);
  });

  // Photo thumbnail for the review screen (real Upload Engine writes these).
  app.get('/api/projects/:id/thumb/:assetId', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset?.thumbPath) return reply.code(404).send({ error: 'no thumbnail for this asset' });
    const info = await stat(asset.thumbPath).catch(() => null);
    if (!info) return reply.code(404).send({ error: 'thumbnail file is missing on disk' });
    reply
      .type('image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .header('content-length', info.size);
    return reply.send(createReadStream(asset.thumbPath));
  });

  // Stream a finished MP4 (default: the 16:9 master; `?variant=vertical` =
  // the 9:16 social cut). Supports Range requests (required for <video>
  // seeking); `?download` adds a content-disposition attachment.
  app.get('/api/projects/:id/video', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const { download, variant } = req.query as { download?: string; variant?: string };
    if (variant !== undefined && variant !== 'vertical') {
      return reply.code(400).send({ error: 'unknown variant — only "vertical" exists' });
    }
    const filePath = variant === 'vertical' ? project.verticalPath : project.outputPath;
    if (!filePath) {
      return reply.code(409).send({
        error: variant === 'vertical' ? 'no vertical cut for this project' : 'video not rendered yet',
      });
    }
    const info = await stat(filePath).catch(() => null);
    if (!info) return reply.code(404).send({ error: 'video file is missing on disk' });

    reply.header('accept-ranges', 'bytes');
    reply.type('video/mp4');
    if (download !== undefined) {
      const suffix = variant === 'vertical' ? '-vertical' : '';
      reply.header(
        'content-disposition',
        `attachment; filename="tour-${project.targetDurationSec}s${suffix}.mp4"`,
      );
    }

    const range = parseByteRange(req.headers.range, info.size);
    if (range === 'invalid') {
      return reply.code(416).header('content-range', `bytes */${info.size}`).send();
    }
    if (range) {
      reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
        .header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(filePath, { start: range.start, end: range.end }));
    }
    reply.header('content-length', info.size);
    return reply.send(createReadStream(filePath));
  });
}

/**
 * Storyboard as the review screen sees it: tour shots in order plus benched
 * photos (analyzed but not selected), with thumbnail URLs where they exist.
 */
function buildReviewData(project: Project): ReviewEventData {
  const visionById = new Map(project.vision.map((v) => [v.assetId, v]));
  const assetById = new Map(project.assets.map((a) => [a.id, a]));
  const toReview = (shot: Shot): ReviewShot => {
    const v = visionById.get(shot.assetId);
    return {
      assetId: shot.assetId,
      order: shot.order,
      roomType: shot.roomType,
      durationSec: shot.durationSec,
      prompt: shot.prompt,
      motionPreset: shot.motionPreset,
      description: v?.description,
      qualityScore: v?.qualityScore,
      thumbUrl: assetById.get(shot.assetId)?.thumbPath
        ? `/api/projects/${project.id}/thumb/${shot.assetId}`
        : undefined,
    };
  };

  const shots = [...project.shots].sort((a, b) => a.order - b.order).map(toReview);
  const inTour = new Set(project.shots.map((s) => s.assetId));
  const bench = project.vision
    .filter((v) => !inTour.has(v.assetId))
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .map((v, i) =>
      toReview({ order: i, assetId: v.assetId, roomType: v.roomType, durationSec: 0, status: 'pending' }),
    );

  const sum = project.shots.reduce((a, s) => a + s.durationSec, 0);
  const totalDurationSec =
    project.shots.length === 0
      ? 0
      : Math.round((sum - (project.shots.length - 1) * defaultConfig.crossfadeSec) * 100) / 100;

  return {
    projectId: project.id,
    stage: project.stage,
    targetDurationSec: project.targetDurationSec,
    totalDurationSec,
    clipDurationSec: defaultConfig.clipDurationSec,
    crossfadeSec: defaultConfig.crossfadeSec,
    shots,
    bench,
  };
}

/** Runs one pipeline promise, mapping its lifecycle onto run events. */
async function trackRun(
  registry: RunRegistry,
  run: Run,
  work: () => Promise<RunResult>,
  cleanup?: () => Promise<void> | void,
): Promise<void> {
  try {
    const { project, render } = await work();
    run.projectId = project.id;
    // No render result = the run paused at the review checkpoint.
    if (!render) {
      registry.emit(run.id, { type: 'review', data: buildReviewData(project) });
      return;
    }
    const done = project.shots.filter((s) => s.status === 'done');
    registry.emit(run.id, {
      type: 'complete',
      data: {
        projectId: project.id,
        videoUrl: `/api/projects/${project.id}/video`,
        verticalUrl: render.verticalPath
          ? `/api/projects/${project.id}/video?variant=vertical`
          : undefined,
        outputPath: render.outputPath,
        totalDurationSec: render.totalDurationSec,
        shotCount: done.length,
        rooms: done.map((s) => s.roomType),
      },
    });
  } catch (err) {
    registry.emit(run.id, {
      type: 'error',
      data: {
        message: err instanceof Error ? err.message : String(err),
        projectId: run.projectId,
      },
    });
  } finally {
    await cleanup?.();
  }
}

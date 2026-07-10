import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { defaultConfig, newId } from '@rev/core';
import type { Project } from '@rev/core';
import {
  loadProject,
  nextStage,
  resumePipeline,
  runPipeline,
  type PipelineEngines,
  type RunResult,
} from '@rev/orchestrator';
import {
  LocalUploadEngine,
  MAX_PHOTOS,
  MIN_PHOTOS,
  type SourceFile,
  type UploadRequest,
} from '@rev/engine-upload';
import { ClaudeVisionEngine } from '@rev/engine-vision';
import { HiggsfieldVideoGenEngine } from '@rev/engine-videogen';
import { PROJECTS_DIR } from '../paths';
import type { Run, RunEvent, RunRegistry } from '../runs';

interface StartRunJsonBody {
  targetDurationSec?: number;
  /** Demo mode: names only, runs through the mock Upload Engine. */
  sourceNames?: string[];
}

const DEMO_SOURCES = Array.from({ length: 14 }, (_, i) => `DEMO_${String(i + 1).padStart(2, '0')}.jpg`);

/** Custom SSE event names. 'error' is reserved by EventSource itself. */
const SSE_NAME: Record<RunEvent['type'], string> = {
  progress: 'progress',
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
  if (process.env.ANTHROPIC_API_KEY) engines.vision = new ClaudeVisionEngine();
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
      const sources: SourceFile[] = [];
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
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

  // Stream the finished MP4. Supports Range requests (required for <video>
  // seeking); `?download` adds a content-disposition attachment.
  app.get('/api/projects/:id/video', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await readProject(projectsDir, id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!project.outputPath) {
      return reply.code(409).send({ error: 'video not rendered yet' });
    }
    const info = await stat(project.outputPath).catch(() => null);
    if (!info) return reply.code(404).send({ error: 'video file is missing on disk' });

    reply.header('accept-ranges', 'bytes');
    reply.type('video/mp4');
    const { download } = req.query as { download?: string };
    if (download !== undefined) {
      reply.header(
        'content-disposition',
        `attachment; filename="tour-${project.targetDurationSec}s.mp4"`,
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
      return reply.send(createReadStream(project.outputPath, { start: range.start, end: range.end }));
    }
    reply.header('content-length', info.size);
    return reply.send(createReadStream(project.outputPath));
  });
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
    const done = project.shots.filter((s) => s.status === 'done');
    registry.emit(run.id, {
      type: 'complete',
      data: {
        projectId: project.id,
        videoUrl: `/api/projects/${project.id}/video`,
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

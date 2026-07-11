import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultConfig } from '@rev/core';
import type { CompleteEventData, Project } from '@rev/core';
import {
  ArtifactSync,
  createServiceClient,
  rebaseProjectPaths,
  SupabaseBlobStore,
  SupabaseProgressSink,
  SupabaseProjectStore,
  type SupabaseLike,
} from '@rev/hosted';
import { LocalUploadEngine, type SourceFile } from '@rev/engine-upload';
import { ClaudeVisionEngine } from '@rev/engine-vision';
import { ClaudeFidelityEngine } from '@rev/engine-fidelity';
import { HiggsfieldVideoGenEngine } from '@rev/engine-videogen';
import {
  resumePipeline,
  runPipeline,
  saveProject,
  type PipelineEngines,
  type RunResult,
} from '@rev/orchestrator';

/** Payload of the generate-tour task (set by the start-run/resume-run edge functions). */
export interface GenerateTourPayload {
  runId: string;
  userId: string;
  /** Fresh run: raw photos already sit in the `photos` bucket. */
  fresh?: {
    targetDurationSec: 30 | 45 | 60;
    /** Storage paths in the `photos` bucket, in upload order. */
    photos: { path: string; name: string }[];
    branding?: {
      address?: string;
      agentName?: string;
      phone?: string;
      email?: string;
      /** Logo's storage path in the `photos` bucket. */
      logoPath?: string;
    };
  };
  /** Resume run: hydrate this project from the DB + artifact bucket. */
  resume?: { projectId: string };
}

/** Real engines when their keys are present, exactly like the local server. */
function hostedEngines(): Partial<PipelineEngines> {
  const engines: Partial<PipelineEngines> = { upload: new LocalUploadEngine() };
  if (process.env.ANTHROPIC_API_KEY) {
    engines.vision = new ClaudeVisionEngine();
    engines.fidelity = new ClaudeFidelityEngine();
  }
  if (process.env.HIGGSFIELD_API_KEY) engines.videogen = new HiggsfieldVideoGenEngine();
  return engines;
}

/**
 * One hosted pipeline run, end to end: pull inputs from storage onto scratch
 * disk, execute the unmodified orchestrator, mirror every checkpoint to
 * Postgres + the artifact bucket, and finish with a terminal run_events row
 * (complete or run-error) that the browser is watching for.
 */
export async function hostedRun(payload: GenerateTourPayload, client?: SupabaseLike): Promise<void> {
  const supabase = client ?? createServiceClient();
  const store = new SupabaseProjectStore(supabase);
  const photosBucket = new SupabaseBlobStore(supabase, 'photos');
  const artifacts = new SupabaseBlobStore(supabase, 'projects');
  const sink = new SupabaseProgressSink(supabase);
  const sync = new ArtifactSync(artifacts, payload.userId);

  const scratch = await mkdtemp(join(tmpdir(), 'rev-worker-'));
  const config = { ...defaultConfig, projectsDir: scratch };
  let projectId = payload.resume?.projectId ?? '';
  const ids = () => ({ runId: payload.runId, projectId, userId: payload.userId });

  try {
    const shared = {
      config,
      engines: hostedEngines(),
      onProgress: (pct: number, stage: string, msg: string) =>
        sink.emitSoft(ids(), { type: 'progress', data: { pct, stage, msg } }),
      onCheckpoint: async (project: Project) => {
        await store.upsert(project, payload.userId);
        await sync.push(project);
      },
    };

    let result: RunResult;
    if (payload.resume) {
      // Hydrate: DB row -> project.json on scratch disk -> normal resume.
      const row = await store.load(payload.resume.projectId);
      if (!row) throw new Error(`project ${payload.resume.projectId} not found`);
      if (row.userId !== payload.userId) throw new Error('project belongs to a different user');
      const project = rebaseProjectPaths(row.project, join(scratch, row.project.id));
      await sync.pull(project);
      await saveProject(join(scratch, project.id), project);
      result = await resumePipeline({ projectId: project.id, ...shared });
    } else if (payload.fresh) {
      // Pull raw photos (and logo) from the uploads bucket onto scratch disk.
      const incoming = join(scratch, 'incoming');
      const sources: SourceFile[] = [];
      for (const [i, photo] of payload.fresh.photos.entries()) {
        const tmpPath = join(incoming, `${i}-${basename(photo.path)}`);
        await photosBucket.downloadToFile(photo.path, tmpPath);
        sources.push({ originalName: photo.name, tmpPath });
      }
      let branding = payload.fresh.branding;
      if (branding?.logoPath) {
        const logoTmp = join(incoming, `logo-${basename(branding.logoPath)}`);
        await photosBucket.downloadToFile(branding.logoPath, logoTmp);
        branding = { ...branding, logoPath: logoTmp };
      }
      result = await runPipeline({
        request: { sources },
        targetDurationSec: payload.fresh.targetDurationSec,
        branding,
        onProject: (id) => {
          projectId = id;
        },
        ...shared,
      });
    } else {
      throw new Error('payload must be either fresh or resume');
    }

    const { project, render } = result;
    projectId = project.id;
    if (!render) throw new Error('hosted runs do not pause for review yet');

    // Terminal event. Storage keys travel as storage:// URLs; the web client
    // swaps them for short-lived signed URLs it mints with the user's own
    // session (RLS lets owners read their artifacts).
    const done = project.shots.filter((s) => s.status === 'done');
    const key = (sub: string, p: string) =>
      `storage://projects/${payload.userId}/${project.id}/${sub}/${basename(p)}`;
    const complete: CompleteEventData = {
      projectId: project.id,
      videoUrl: key('output', render.outputPath),
      verticalUrl: render.verticalPath ? key('output', render.verticalPath) : undefined,
      outputPath: key('output', render.outputPath),
      totalDurationSec: render.totalDurationSec,
      shotCount: done.length,
      rooms: done.map((s) => s.roomType),
    };
    await sink.emit(ids(), { type: 'complete', data: complete });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sink
      .emit(ids(), { type: 'run-error', data: { message, projectId: projectId || undefined } })
      .catch(() => {});
    throw err;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

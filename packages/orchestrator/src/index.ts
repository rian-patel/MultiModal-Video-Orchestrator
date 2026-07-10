import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  defaultConfig,
  newId,
} from '@rev/core';
import type {
  Asset,
  Engine,
  EngineContext,
  PipelineConfig,
  Project,
  Shot,
  VideoMode,
  VisionResult,
} from '@rev/core';
import { MockUploadEngine, type UploadRequest } from '@rev/engine-upload';
import { MockVisionEngine } from '@rev/engine-vision';
import { RuleBasedStoryboardEngine, type StoryboardInput } from '@rev/engine-storyboard';
import { TemplatePromptEngine, type PromptInput } from '@rev/engine-prompt';
import { MockVideoGenEngine, type VideoGenInput } from '@rev/engine-videogen';
import { FfmpegRenderEngine, type RenderInput, type RenderResult } from '@rev/engine-render';
import { ensureProjectDirs, loadProject, saveProject } from './persistence';

export * from './persistence';

/** The set of engines the pipeline runs. Any one can be swapped independently. */
export interface PipelineEngines {
  upload: Engine<UploadRequest, Asset[]>;
  vision: Engine<Asset[], VisionResult[]>;
  storyboard: Engine<StoryboardInput, Shot[]>;
  prompt: Engine<PromptInput, Shot[]>;
  videogen: Engine<VideoGenInput, Shot[]>;
  render: Engine<RenderInput, RenderResult>;
}

/**
 * Defaults: mock upload/vision/videogen (no keys, no cost), but the real
 * storyboard, prompt, and FFmpeg render — so even a keyless run produces a
 * playable MP4 (the mock videogen emits real color clips).
 */
export function defaultEngines(): PipelineEngines {
  return {
    upload: new MockUploadEngine(),
    vision: new MockVisionEngine(),
    storyboard: new RuleBasedStoryboardEngine(),
    prompt: new TemplatePromptEngine(),
    videogen: new MockVideoGenEngine(),
    render: new FfmpegRenderEngine(),
  };
}

export interface RunOptions {
  request: UploadRequest;
  targetDurationSec: 30 | 45 | 60;
  /** Recorded on the Project for the run's provenance. Defaults to 'faithful'. */
  mode?: VideoMode;
  config?: PipelineConfig;
  /** Override any subset of engines to swap implementations. */
  engines?: Partial<PipelineEngines>;
  /** Global 0..100 progress across all stages. */
  onProgress?: (globalPct: number, stage: string, msg: string) => void;
  /** Fires as soon as the project exists on disk — lets callers attach the
   * projectId to failure reports so the run can be resumed. */
  onProject?: (projectId: string) => void;
  /** Stop at the 'prompted' checkpoint (before any paid clip generation) so
   * the user can review/edit the storyboard; continue via resumePipeline. */
  stopAfter?: 'prompted';
}

export interface ResumeOptions {
  projectId: string;
  config?: PipelineConfig;
  engines?: Partial<PipelineEngines>;
  onProgress?: (globalPct: number, stage: string, msg: string) => void;
}

export interface RunResult {
  project: Project;
  /** Absent when the run stopped at a review checkpoint (`stopAfter`). */
  render?: RenderResult;
}

const STAGES = ['upload', 'vision', 'storyboard', 'prompt', 'videogen', 'render'] as const;
export type PipelineStage = (typeof STAGES)[number];

/**
 * Maps a persisted project's checkpoint to the first stage that still needs
 * to run. Returns 'complete' when there is nothing left, and null for
 * unknown/legacy stage values (not resumable).
 */
export function nextStage(project: Project): PipelineStage | 'complete' | null {
  switch (project.stage) {
    case 'created': return 'upload';
    case 'uploaded': return 'vision';
    case 'analyzed': return 'storyboard';
    case 'storyboarded': return 'prompt';
    case 'prompted': return 'videogen';
    case 'generating': return 'videogen';
    case 'rendering': return 'render';
    case 'complete': return 'complete';
    default: return null;
  }
}

/**
 * Runs the full pipeline on a fresh project. The orchestrator owns all
 * wiring: it reads the slice of Project each engine needs, calls the engine,
 * writes the result back, persists, and maps per-stage progress onto a
 * global 0..100.
 */
export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const config = opts.config ?? defaultConfig;
  const project: Project = {
    id: newId('proj'),
    createdAt: new Date().toISOString(),
    targetDurationSec: opts.targetDurationSec,
    mode: opts.mode ?? 'faithful',
    stage: 'created',
    assets: [],
    vision: [],
    shots: [],
  };
  const workDir = join(config.projectsDir, project.id);
  await ensureProjectDirs(workDir);
  await saveProject(workDir, project);
  opts.onProject?.(project.id);
  return executeFrom(project, workDir, 'upload', config, opts, opts.request);
}

/**
 * Re-runs a persisted project from its last checkpoint. Completed stages are
 * skipped entirely; within videogen, shots whose clips are already on disk
 * are kept as-is — only missing/failed clips are regenerated (never re-pay
 * for a finished clip).
 */
export async function resumePipeline(opts: ResumeOptions): Promise<RunResult> {
  const config = opts.config ?? defaultConfig;
  const workDir = join(config.projectsDir, opts.projectId);
  const project = await loadProject(workDir);
  const from = nextStage(project);
  if (from === 'complete') {
    throw new Error(`Project ${opts.projectId} is already complete — nothing to resume.`);
  }
  if (from === 'upload' || from === null) {
    throw new Error(
      `Project ${opts.projectId} cannot be resumed (stage "${project.stage}") — start a new run.`,
    );
  }
  delete project.lastError;
  await ensureProjectDirs(workDir);
  return executeFrom(project, workDir, from, config, opts);
}

async function executeFrom(
  project: Project,
  workDir: string,
  from: PipelineStage,
  config: PipelineConfig,
  opts: Pick<RunOptions, 'engines' | 'onProgress' | 'stopAfter'>,
  request?: UploadRequest,
): Promise<RunResult> {
  const engines = { ...defaultEngines(), ...opts.engines };
  const logger = createLogger('orchestrator');
  const start = STAGES.indexOf(from);
  logger.info(
    start === 0
      ? `Project ${project.id} -> ${workDir}`
      : `Project ${project.id}: resuming from ${from}`,
  );

  const ctxFor = (stageIndex: number, name: string): EngineContext => ({
    workDir,
    config,
    logger: logger.child(name),
    progress: (pct, msg) => {
      const global = Math.round(((stageIndex + pct / 100) / STAGES.length) * 100);
      opts.onProgress?.(global, name, msg);
    },
  });

  try {
    // 1. Upload (never part of a resume — the original bytes are gone; the
    //    normalized copies in workDir/source are the durable artifact).
    if (start <= 0) {
      if (!request) throw new Error('upload stage requires the original upload request');
      project.assets = await engines.upload.process(request, ctxFor(0, 'upload'));
      project.stage = 'uploaded';
      await saveProject(workDir, project);
    }

    // 2. Vision
    if (start <= 1) {
      project.vision = await engines.vision.process(project.assets, ctxFor(1, 'vision'));
      project.stage = 'analyzed';
      await saveProject(workDir, project);
    }

    // 3. Storyboard
    if (start <= 2) {
      project.shots = await engines.storyboard.process(
        { assets: project.assets, vision: project.vision, targetDurationSec: project.targetDurationSec },
        ctxFor(2, 'storyboard'),
      );
      project.stage = 'storyboarded';
      await saveProject(workDir, project);
    }

    // 4. Prompt
    if (start <= 3) {
      project.shots = await engines.prompt.process(
        { shots: project.shots, vision: project.vision },
        ctxFor(3, 'prompt'),
      );
      project.stage = 'prompted';
      await saveProject(workDir, project);
    }

    // Review pause: hand the storyboard back to the user before spending on
    // clip generation. 'prompted' is a normal checkpoint, so continuing is
    // just resumePipeline (which is also how edits get animated).
    if (opts.stopAfter === 'prompted') {
      logger.info(`Project ${project.id}: paused at '${project.stage}' for storyboard review`);
      return { project };
    }

    // 5. Video generation — checkpoint *before* the expensive stage so a
    //    crash mid-generation resumes here, not at prompt.
    if (start <= 4) {
      project.stage = 'generating';
      await saveProject(workDir, project);
      project.shots = await generateClips(project, engines.videogen, ctxFor(4, 'videogen'));
      await saveProject(workDir, project);
    }

    // 6. Render (always runs — cheap, local, idempotent)
    project.stage = 'rendering';
    await saveProject(workDir, project);
    const outputPath = join(workDir, 'output', 'tour.mp4');
    const render = await engines.render.process(
      { shots: project.shots, outputPath },
      ctxFor(5, 'render'),
    );
    project.outputPath = render.outputPath;
    project.stage = 'complete';
    await saveProject(workDir, project);

    logger.info(`Complete -> ${render.outputPath} (~${render.totalDurationSec}s)`);
    return { project, render };
  } catch (err) {
    // Keep `stage` at the last checkpoint (that IS the resume point) and
    // record why the run stopped.
    project.lastError = err instanceof Error ? err.message : String(err);
    await saveProject(workDir, project);
    throw err;
  }
}

/**
 * Videogen with resume-awareness: shots whose clip already exists on disk
 * are kept; only the rest go to the engine. If the engine fails outright but
 * finished clips exist, the failure is downgraded to per-shot 'failed' —
 * rendering a partial tour beats losing clips that were already paid for.
 */
async function generateClips(
  project: Project,
  videogen: Engine<VideoGenInput, Shot[]>,
  ctx: EngineContext,
): Promise<Shot[]> {
  const keep: Shot[] = [];
  const todo: Shot[] = [];
  for (const shot of project.shots) {
    if (shot.status === 'done' && shot.clipPath && (await fileExists(shot.clipPath))) {
      keep.push(shot);
    } else {
      todo.push({ ...shot, status: 'pending', clipPath: undefined });
    }
  }

  if (todo.length === 0) {
    ctx.progress(100, `All ${keep.length} clips already generated — skipping to render`);
    return keep;
  }
  if (keep.length > 0) {
    ctx.progress(0, `Resuming: ${keep.length}/${project.shots.length} clips already generated`);
  }

  let generated: Shot[];
  try {
    generated = await videogen.process({ shots: todo, assets: project.assets }, ctx);
  } catch (err) {
    if (keep.length === 0) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      `videogen failed for the remaining ${todo.length} shots (${reason}) — rendering the ${keep.length} finished clips`,
    );
    generated = todo.map((s) => ({ ...s, status: 'failed' as const }));
  }
  return [...keep, ...generated].sort((a, b) => a.order - b.order);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

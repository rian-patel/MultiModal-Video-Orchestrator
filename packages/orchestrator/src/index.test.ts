import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '@rev/core';
import type { Engine, PipelineConfig, Project, Shot } from '@rev/core';
import type { UploadRequest } from '@rev/engine-upload';
import type { VideoGenInput } from '@rev/engine-videogen';
import type { RenderInput, RenderResult } from '@rev/engine-render';
import {
  loadProject,
  nextStage,
  resumePipeline,
  runPipeline,
  saveProject,
} from './index';

// ---------- fixtures ----------

const REQUEST: UploadRequest = {
  sources: Array.from({ length: 12 }, (_, i) => ({ originalName: `photo_${i + 1}.jpg` })),
};

async function tempConfig(): Promise<PipelineConfig> {
  const projectsDir = await mkdtemp(join(tmpdir(), 'rev-orch-'));
  return { ...defaultConfig, projectsDir };
}

/** Videogen stub: instantly "generates" every shot by writing a tiny file. */
function stubVideogen(calls: VideoGenInput[] = []): Engine<VideoGenInput, Shot[]> {
  return {
    name: 'videogen:stub',
    async process(input, ctx) {
      calls.push(input);
      const out: Shot[] = [];
      for (const s of input.shots) {
        const clipPath = join(ctx.workDir, 'clips', `shot-${String(s.order).padStart(2, '0')}.mp4`);
        await writeFile(clipPath, 'clip-bytes');
        out.push({ ...s, clipPath, status: 'done' });
      }
      return out;
    },
  };
}

function failingVideogen(message = 'higgsfield down'): Engine<VideoGenInput, Shot[]> {
  return {
    name: 'videogen:fail',
    async process() {
      throw new Error(message);
    },
  };
}

/** Render stub: writes a placeholder output instead of running ffmpeg. */
function stubRender(): Engine<RenderInput, RenderResult> {
  return {
    name: 'render:stub',
    async process(input) {
      const usable = input.shots.filter((s) => s.status === 'done' && s.clipPath);
      if (usable.length === 0) throw new Error('No rendered clips available');
      await writeFile(input.outputPath, 'mp4-bytes');
      return { outputPath: input.outputPath, planPath: '', totalDurationSec: 42 };
    },
  };
}

function project(stage: Project['stage']): Project {
  return {
    id: 'proj_x',
    createdAt: new Date().toISOString(),
    targetDurationSec: 30,
    stage,
    assets: [],
    vision: [],
    shots: [],
  };
}

// ---------- nextStage ----------

test('nextStage maps every checkpoint to the first stage still to run', () => {
  assert.equal(nextStage(project('created')), 'upload');
  assert.equal(nextStage(project('uploaded')), 'vision');
  assert.equal(nextStage(project('analyzed')), 'storyboard');
  assert.equal(nextStage(project('storyboarded')), 'prompt');
  assert.equal(nextStage(project('prompted')), 'videogen');
  assert.equal(nextStage(project('generating')), 'videogen');
  assert.equal(nextStage(project('rendering')), 'render');
  assert.equal(nextStage(project('complete')), 'complete');
  // legacy pre-Phase-7 value: unknown -> not resumable
  assert.equal(nextStage({ ...project('complete'), stage: 'error' as Project['stage'] }), null);
});

// ---------- failure -> checkpoint -> resume ----------

test('a videogen failure leaves a resumable checkpoint; resume finishes the run', async () => {
  const config = await tempConfig();
  let projectId = '';

  await assert.rejects(
    runPipeline({
      request: REQUEST,
      targetDurationSec: 30,
      config,
      engines: { videogen: failingVideogen(), render: stubRender() },
      onProject: (id) => { projectId = id; },
    }),
    /higgsfield down/,
  );

  assert.ok(projectId, 'onProject fired before the failure');
  const workDir = join(config.projectsDir, projectId);
  const saved = await loadProject(workDir);
  assert.equal(saved.stage, 'generating', 'stage stays at the checkpoint, not "error"');
  assert.match(saved.lastError ?? '', /higgsfield down/);
  assert.equal(nextStage(saved), 'videogen');

  const calls: VideoGenInput[] = [];
  const { project: done } = await resumePipeline({
    projectId,
    config,
    engines: { videogen: stubVideogen(calls), render: stubRender() },
  });

  assert.equal(done.stage, 'complete');
  assert.equal(done.lastError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shots.length, done.shots.length, 'no clips existed, so all were generated');
  assert.ok(done.shots.every((s) => s.status === 'done'));
  assert.ok(done.outputPath && existsSync(done.outputPath));
});

test('resume regenerates only the shots whose clips are missing', async () => {
  const config = await tempConfig();
  const { project: first } = await runPipeline({
    request: REQUEST,
    targetDurationSec: 30,
    config,
    engines: { videogen: stubVideogen(), render: stubRender() },
  });

  // Pretend the run died after the first two clips finished.
  const workDir = join(config.projectsDir, first.id);
  const tampered = await loadProject(workDir);
  tampered.stage = 'generating';
  for (const s of tampered.shots.slice(2)) {
    s.status = 'failed';
    delete s.clipPath;
  }
  await saveProject(workDir, tampered);

  const calls: VideoGenInput[] = [];
  const { project: resumed } = await resumePipeline({
    projectId: first.id,
    config,
    engines: { videogen: stubVideogen(calls), render: stubRender() },
  });

  assert.equal(calls[0].shots.length, tampered.shots.length - 2, 'finished clips were not regenerated');
  assert.equal(resumed.shots.length, tampered.shots.length);
  assert.ok(resumed.shots.every((s) => s.status === 'done'));
  assert.deepEqual(
    resumed.shots.map((s) => s.order),
    tampered.shots.map((s) => s.order),
    'shot order preserved after the keep/regenerate merge',
  );
});

test('resume renders the finished clips even if videogen fails again', async () => {
  const config = await tempConfig();
  const { project: first } = await runPipeline({
    request: REQUEST,
    targetDurationSec: 30,
    config,
    engines: { videogen: stubVideogen(), render: stubRender() },
  });

  const workDir = join(config.projectsDir, first.id);
  const tampered = await loadProject(workDir);
  tampered.stage = 'generating';
  for (const s of tampered.shots.slice(2)) {
    s.status = 'failed';
    delete s.clipPath;
  }
  await saveProject(workDir, tampered);

  const { project: resumed } = await resumePipeline({
    projectId: first.id,
    config,
    engines: { videogen: failingVideogen(), render: stubRender() },
  });

  assert.equal(resumed.stage, 'complete', 'partial tour beats a crash');
  assert.equal(resumed.shots.filter((s) => s.status === 'done').length, 2);
  assert.equal(resumed.shots.filter((s) => s.status === 'failed').length, tampered.shots.length - 2);
});

test("resume from 'rendering' never touches videogen", async () => {
  const config = await tempConfig();
  const { project: first } = await runPipeline({
    request: REQUEST,
    targetDurationSec: 30,
    config,
    engines: { videogen: stubVideogen(), render: stubRender() },
  });

  const workDir = join(config.projectsDir, first.id);
  const tampered = await loadProject(workDir);
  tampered.stage = 'rendering';
  await saveProject(workDir, tampered);

  // A videogen that throws on contact proves the stage was skipped.
  const { project: resumed } = await resumePipeline({
    projectId: first.id,
    config,
    engines: { videogen: failingVideogen('videogen must not run'), render: stubRender() },
  });
  assert.equal(resumed.stage, 'complete');
});

test('unresumable states are rejected with a clear error', async () => {
  const config = await tempConfig();

  // complete -> nothing to resume
  const { project: done } = await runPipeline({
    request: REQUEST,
    targetDurationSec: 30,
    config,
    engines: { videogen: stubVideogen(), render: stubRender() },
  });
  await assert.rejects(resumePipeline({ projectId: done.id, config }), /already complete/);

  // created -> the original upload bytes are gone
  const fresh = project('created');
  await saveProject(join(config.projectsDir, fresh.id), fresh);
  await assert.rejects(resumePipeline({ projectId: fresh.id, config }), /cannot be resumed/);

  // unknown project id
  await assert.rejects(resumePipeline({ projectId: 'proj_nope', config }));
});

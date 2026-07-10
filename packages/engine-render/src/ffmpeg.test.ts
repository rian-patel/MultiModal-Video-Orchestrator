import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { defaultConfig } from '@rev/core';
import type { EngineContext, Shot } from '@rev/core';
import { buildXfadeGraph, FfmpegRenderEngine, probeDurationSec } from './ffmpeg';

const SMALL = {
  ...defaultConfig,
  resolution: { width: 320, height: 180 },
  crossfadeSec: 0.5,
  clipDurationSec: 2,
};

function makeCtx(workDir: string): EngineContext {
  const noop = () => {};
  return {
    workDir,
    config: SMALL,
    logger: { info: noop, warn: noop, error: noop, child: () => makeCtx(workDir).logger },
    progress: noop,
  };
}

function makeClip(path: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath as string,
      ['-f', 'lavfi', '-i', `testsrc2=s=320x180:d=${seconds}:r=30`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', path],
      { windowsHide: true },
    );
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

function shot(order: number, clipPath: string | undefined, durationSec: number, status: Shot['status'] = 'done'): Shot {
  return { order, assetId: `a${order}`, roomType: 'kitchen', durationSec, clipPath, status };
}

// --- pure graph math (no ffmpeg run) -----------------------------------

test('xfade graph: offsets, labels, and total duration', () => {
  const g = buildXfadeGraph([5, 5, 5], 0.75, 1920, 1080);
  // offsets: 5-0.75=4.25, then 10-1.5=8.5
  assert.match(g.filter, /xfade=transition=fade:duration=0\.750:offset=4\.250\[x1\]/);
  assert.match(g.filter, /\[x1\]\[v2\]xfade=transition=fade:duration=0\.750:offset=8\.500\[out\]/);
  assert.equal(g.totalDurationSec, 13.5);
  // every input normalized to the same frame/timebase
  assert.equal((g.filter.match(/settb=AVTB/g) ?? []).length, 3);
});

test('xfade graph: single clip needs no transition', () => {
  const g = buildXfadeGraph([4.5], 0.75, 1920, 1080);
  assert.doesNotMatch(g.filter, /xfade/);
  assert.match(g.filter, /\[out\]/);
  assert.equal(g.totalDurationSec, 4.5);
});

// --- real ffmpeg renders ------------------------------------------------

test('renders 3 clips with crossfades to the exact target duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rev-render-'));
  const clips = [join(dir, 'c0.mp4'), join(dir, 'c1.mp4'), join(dir, 'c2.mp4')];
  await Promise.all(clips.map((p) => makeClip(p, 2)));

  const shots = clips.map((p, i) => shot(i, p, 1.5)); // trim 2s clips to 1.5s
  const out = join(dir, 'tour.mp4');
  const result = await new FfmpegRenderEngine().process({ shots, outputPath: out }, makeCtx(dir));

  // 3*1.5 - 2*0.5 = 3.5s
  assert.equal(result.totalDurationSec, 3.5);
  const probed = await probeDurationSec(out);
  assert.ok(Math.abs(probed - 3.5) < 0.25, `probed ${probed}s, expected ~3.5s`);
  assert.ok((await stat(out)).size > 5_000, 'output has real video bytes');
  assert.ok((await stat(result.planPath)).size > 0, 'render plan written');
});

test('failed shots are skipped, render still succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rev-render-'));
  const good = join(dir, 'good.mp4');
  await makeClip(good, 2);

  const shots = [shot(0, good, 1.5), shot(1, undefined, 1.5, 'failed'), shot(2, good, 1.5)];
  const out = join(dir, 'tour.mp4');
  const result = await new FfmpegRenderEngine().process({ shots, outputPath: out }, makeCtx(dir));

  assert.equal(result.totalDurationSec, 2.5); // 2 clips * 1.5 - 0.5
  const probed = await probeDurationSec(out);
  assert.ok(Math.abs(probed - 2.5) < 0.25, `probed ${probed}s`);
});

test('no usable clips rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rev-render-'));
  const shots = [shot(0, undefined, 5, 'failed')];
  await assert.rejects(
    new FfmpegRenderEngine().process({ shots, outputPath: join(dir, 'x.mp4') }, makeCtx(dir)),
    /every shot failed/,
  );
});

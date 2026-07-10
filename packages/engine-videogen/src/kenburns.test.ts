import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { KenBurnsVideoGenEngine, kenBurnsMove } from './kenburns';

function makeCtx(workDir: string): EngineContext {
  const noop = () => {};
  return {
    workDir,
    config: defaultConfig,
    logger: { info: noop, warn: noop, error: noop, child: () => makeCtx(workDir).logger },
    progress: noop,
  };
}

/** A tiny real JPEG so ffmpeg has actual pixels to pan over. */
async function writeTestJpeg(path: string): Promise<void> {
  if (!ffmpegPath) throw new Error('no ffmpeg');
  await new Promise<void>((res, rej) => {
    const p = spawn(
      ffmpegPath as string,
      ['-f', 'lavfi', '-i', 'testsrc=size=1600x900:duration=1', '-frames:v', '1', '-y', path],
      { windowsHide: true },
    );
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg testsrc exit ${c}`))));
  });
}

function probeDurationSec(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = '';
    const p = spawn(ffmpegPath as string, ['-i', file], { windowsHide: true });
    p.stderr.on('data', (c: Buffer) => (out += c.toString()));
    p.on('close', () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      m ? resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : reject(new Error('no duration'));
    });
  });
}

test('kenBurnsMove maps translational i2v presets onto safe pan/zoom moves', () => {
  assert.equal(kenBurnsMove('push_in'), 'zoom_in');
  assert.equal(kenBurnsMove('dolly_in'), 'zoom_in');
  assert.equal(kenBurnsMove('orbit'), 'zoom_in', 'orbit degrades to a faithful zoom');
  assert.equal(kenBurnsMove('crane_up'), 'tilt_up');
  assert.equal(kenBurnsMove('pullback'), 'zoom_out');
  assert.equal(kenBurnsMove('lateral_glide'), 'pan_right');
  assert.equal(kenBurnsMove(undefined), 'zoom_in');
});

test('renders a real clip from the source photo at the shot duration', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'rev-kb-'));
  const src = join(workDir, 'room.jpg');
  await writeTestJpeg(src);

  const assets: Asset[] = [{ id: 'a0', sourcePath: src, originalName: 'room.jpg', width: 1600, height: 900 }];
  const shots: Shot[] = [
    { order: 0, assetId: 'a0', roomType: 'living_room', durationSec: 3, motionPreset: 'dolly_in', status: 'pending' },
  ];

  const out = await new KenBurnsVideoGenEngine().process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done');
  assert.ok(out[0].clipPath && existsSync(out[0].clipPath));
  assert.match(out[0].higgsfieldJobId ?? '', /^kenburns:zoom_in:/, 'provenance is tagged, no external job');
  const dur = await probeDurationSec(out[0].clipPath!);
  assert.ok(Math.abs(dur - 3) < 0.15, `clip ~3s, got ${dur}`);
});

test('a shot with no source asset fails in isolation, not fatally', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'rev-kb-'));
  const src = join(workDir, 'ok.jpg');
  await writeTestJpeg(src);

  const assets: Asset[] = [{ id: 'a0', sourcePath: src, originalName: 'ok.jpg', width: 1600, height: 900 }];
  const shots: Shot[] = [
    { order: 0, assetId: 'a0', roomType: 'kitchen', durationSec: 2, motionPreset: 'lateral_glide', status: 'pending' },
    { order: 1, assetId: 'missing', roomType: 'bedroom', durationSec: 2, motionPreset: 'pan', status: 'pending' },
  ];
  const out = await new KenBurnsVideoGenEngine().process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done');
  assert.equal(out[1].status, 'failed', 'missing-source shot is isolated');
});

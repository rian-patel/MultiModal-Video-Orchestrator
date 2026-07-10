import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '@rev/core';
import type { EngineContext, RoomType, Shot, VisionResult } from '@rev/core';
import { TemplatePromptEngine } from './index';
import { presetFromMove, STYLE_SUFFIX } from './templates';

function makeCtx(): EngineContext {
  const noop = () => {};
  return {
    workDir: '',
    config: defaultConfig,
    logger: { info: noop, warn: noop, error: noop, child: () => makeCtx().logger },
    progress: noop,
  };
}

let seq = 0;
function shotWithVision(
  roomType: RoomType,
  overrides: Partial<VisionResult> = {},
): { shot: Shot; vision: VisionResult } {
  const assetId = `asset_${String(seq++).padStart(3, '0')}`;
  return {
    shot: { order: 0, assetId, roomType, durationSec: 5, status: 'pending' },
    vision: {
      assetId,
      roomType,
      description: `spacious ${roomType.replace(/_/g, ' ')} with large windows`,
      features: [],
      lighting: 'bright',
      suggestedMove: 'slow dolly-in toward the windows',
      qualityScore: 0.9,
      ...overrides,
    },
  };
}

function build(entries: { shot: Shot; vision?: VisionResult }[]) {
  entries.forEach((e, i) => (e.shot.order = i));
  return {
    shots: entries.map((e) => e.shot),
    vision: entries.flatMap((e) => (e.vision ? [e.vision] : [])),
  };
}

const engine = new TemplatePromptEngine();

test("vision's photo-specific move is used and mapped to a preset", async () => {
  const a = shotWithVision('kitchen', {
    description: 'spacious open-plan kitchen with a white quartz island',
    suggestedMove: 'slow dolly-in past the island toward the blue backsplash',
  });
  const [s] = await engine.process(build([a]), makeCtx());
  assert.match(s.prompt!, /Camera: slow dolly-in past the island toward the blue backsplash\./);
  assert.equal(s.motionPreset, 'dolly_in');
});

test('descriptions get a correct leading article (no "the a ..." bug)', async () => {
  const withA = shotWithVision('other', { description: 'a blank pale gray frame' });
  const bare = shotWithVision('kitchen', { description: 'spacious open-plan kitchen' });
  const vowel = shotWithVision('living_room', { description: 'airy open-plan living room' });
  const [s1, s2, s3] = await engine.process(build([withA, bare, vowel]), makeCtx());
  assert.match(s1.prompt!, /^A blank pale gray frame\./);
  assert.match(s2.prompt!, /^A spacious open-plan kitchen\./);
  assert.match(s3.prompt!, /^An airy open-plan living room\./);
  assert.doesNotMatch(s1.prompt!, /the a /i);
});

test('missing vision falls back to room variants and rotates on repeats', async () => {
  const b1 = shotWithVision('bedroom');
  const b2 = shotWithVision('bedroom');
  const input = build([{ shot: b1.shot }, { shot: b2.shot }]); // no vision at all
  const [s1, s2] = await engine.process(input, makeCtx());
  assert.equal(s1.motionPreset, 'dolly_in');
  assert.equal(s2.motionPreset, 'pan', 'second bedroom rotates to a different variant');
  assert.notEqual(s1.prompt, s2.prompt);
  assert.match(s1.prompt!, /^A bedroom\./);
});

test('identical back-to-back moves on the same room are varied', async () => {
  const o1 = shotWithVision('outdoor', { suggestedMove: 'rising crane move over the backyard' });
  const o2 = shotWithVision('outdoor', { suggestedMove: 'slow crane-up revealing the pool' });
  const [s1, s2] = await engine.process(build([o1, o2]), makeCtx());
  assert.equal(s1.motionPreset, 'crane_up');
  assert.notEqual(s2.motionPreset, 'crane_up', 'second consecutive crane is replaced');
});

test('every prompt carries the style suffix and lighting', async () => {
  const entries = [shotWithVision('foyer'), shotWithVision('bathroom', { lighting: 'warm' })];
  const shots = await engine.process(build(entries), makeCtx());
  for (const s of shots) assert.ok(s.prompt!.endsWith(STYLE_SUFFIX));
  assert.match(shots[1].prompt!, /Warm light;/);
});

test('presetFromMove keyword mapping', () => {
  const cases: Array<[string, string]> = [
    ['slow aerial pull-back revealing the lot', 'aerial_pullback'],
    ['slow pull-back revealing the grounds', 'pullback'],
    ['sweeping crane-up revealing the pool area', 'crane_up'],
    ['gentle arc around the seating area', 'orbit'],
    ['elegant tilt-up revealing the staircase', 'tilt_up'],
    ['slow glide along the countertops', 'lateral_glide'],
    ['soft pan across the vanity', 'pan'],
    ['macro slow push on the fixture', 'macro_push'],
    ['steady push-in over the island', 'push_in'],
    ['slow dolly-in toward the fireplace', 'dolly_in'],
    ['static hold', 'static'],
  ];
  for (const [move, expected] of cases) {
    assert.equal(presetFromMove(move, 'other'), expected, move);
  }
  // unknown phrase -> room default
  assert.equal(presetFromMove('something unrecognizable', 'kitchen'), 'lateral_glide');
});

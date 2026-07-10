import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '@rev/core';
import type { EngineContext, RoomType, Shot, VisionResult } from '@rev/core';
import { TemplatePromptEngine } from './index';
import { FIDELITY_CONSTRAINT, presetFromMove, safeMovePhrase } from './templates';

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

// --- the anti-hallucination guarantee -----------------------------------

test('prompt carries NO scene description and NO directional target', async () => {
  // Exactly the shape that produced the dining-table hallucination.
  const a = shotWithVision('living_room', {
    description:
      'bright open-concept living room with a sectional sofa flowing into an adjacent dining area',
    suggestedMove: 'slow dolly-in through the seating area toward the dining room',
  });
  const [s] = await engine.process(build([a]), makeCtx());

  assert.doesNotMatch(s.prompt!, /dining/i, 'no room/furniture content leaks into the prompt');
  assert.doesNotMatch(s.prompt!, /sectional|sofa/i, 'no furniture named');
  assert.doesNotMatch(s.prompt!, /\btoward\b/i, 'no directional destination for the camera');
  assert.ok(s.prompt!.includes(FIDELITY_CONSTRAINT), 'prompt asserts the preserve-the-scene constraint');
  assert.match(s.prompt!, /do not add, remove, move, or invent/i);
});

test('every prompt is motion + lighting + the fidelity constraint only', async () => {
  const entries = [shotWithVision('foyer'), shotWithVision('bathroom', { lighting: 'warm' })];
  const shots = await engine.process(build(entries), makeCtx());
  for (const s of shots) {
    assert.match(s.prompt!, /^Camera: /, 'starts with the camera move, not a scene description');
    assert.ok(s.prompt!.endsWith(FIDELITY_CONSTRAINT), 'ends with the fidelity constraint');
  }
  assert.match(shots[1].prompt!, /Warm light;/);
});

// --- motion selection (unchanged behaviour, safe phrasing) --------------

test("vision's move selects the preset but its raw directional text never reaches the prompt", async () => {
  const a = shotWithVision('kitchen', {
    suggestedMove: 'slow dolly-in past the island toward the blue backsplash',
  });
  const [s] = await engine.process(build([a]), makeCtx());
  assert.equal(s.motionPreset, 'dolly_in', 'preset still derived from vision');
  assert.ok(s.prompt!.includes(safeMovePhrase('dolly_in')), 'prompt uses the neutral safe phrasing');
  assert.doesNotMatch(s.prompt!, /island|backsplash|toward/i);
});

test('missing vision falls back to room variants and rotates on repeats', async () => {
  const b1 = shotWithVision('bedroom');
  const b2 = shotWithVision('bedroom');
  const input = build([{ shot: b1.shot }, { shot: b2.shot }]); // no vision at all
  const [s1, s2] = await engine.process(input, makeCtx());
  assert.equal(s1.motionPreset, 'dolly_in');
  assert.equal(s2.motionPreset, 'pan', 'second bedroom rotates to a different variant');
  assert.notEqual(s1.prompt, s2.prompt);
});

test('identical back-to-back moves on the same room are varied', async () => {
  const o1 = shotWithVision('outdoor', { suggestedMove: 'rising crane move over the backyard' });
  const o2 = shotWithVision('outdoor', { suggestedMove: 'slow crane-up revealing the pool' });
  const [s1, s2] = await engine.process(build([o1, o2]), makeCtx());
  assert.equal(s1.motionPreset, 'crane_up');
  assert.notEqual(s2.motionPreset, 'crane_up', 'second consecutive crane is replaced');
});

test('safe move phrases are non-directional (no "toward"/"into" targets)', () => {
  for (const preset of ['push_in', 'dolly_in', 'orbit', 'crane_up', 'lateral_glide', 'pan', 'static']) {
    const phrase = safeMovePhrase(preset);
    assert.doesNotMatch(phrase, /toward|into|through/i, `${preset} phrase must not name a destination`);
  }
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '@rev/core';
import type { Asset, EngineContext, RoomType, VisionResult } from '@rev/core';
import { paceDurations, ROOM_PRIORITY, RuleBasedStoryboardEngine } from './index';

// --- helpers -----------------------------------------------------------

function makeCtx(): EngineContext & { messages: string[] } {
  const messages: string[] = [];
  const noop = () => {};
  return {
    workDir: '',
    config: defaultConfig, // clip 5s, xfade 0.75s, floor 0.3, cap 2
    logger: { info: noop, warn: noop, error: noop, child: () => makeCtx().logger },
    progress: (_pct, msg) => messages.push(msg),
    messages,
  };
}

let seq = 0;
function photo(roomType: RoomType, qualityScore: number): { asset: Asset; vision: VisionResult } {
  const id = `asset_${String(seq++).padStart(3, '0')}`;
  return {
    asset: { id, sourcePath: `/x/${id}.jpg`, originalName: `${id}.jpg`, width: 1920, height: 1080 },
    vision: {
      assetId: id,
      roomType,
      description: `a ${roomType.replace(/_/g, ' ')}`,
      features: [],
      lighting: 'bright',
      suggestedMove: 'slow dolly-in',
      qualityScore,
    },
  };
}

function input(photos: { asset: Asset; vision: VisionResult }[], targetDurationSec: number) {
  return {
    assets: photos.map((p) => p.asset),
    vision: photos.map((p) => p.vision),
    targetDurationSec,
  };
}

const engine = new RuleBasedStoryboardEngine();
const totalOf = (shots: { durationSec: number }[]) =>
  Math.round((shots.reduce((a, s) => a + s.durationSec, 0) - (shots.length - 1) * 0.75) * 100) / 100;

// --- duration math -----------------------------------------------------

test('exact duration fit for 30/45/60s targets with plenty of photos', async () => {
  for (const [target, expectedN] of [[30, 7], [45, 11], [60, 14]] as const) {
    const photos = Array.from({ length: 20 }, (_, i) =>
      photo((['kitchen', 'living_room', 'bedroom', 'bathroom', 'outdoor'] as RoomType[])[i % 5], 0.9 - i * 0.01),
    );
    const shots = await engine.process(input(photos, target), makeCtx());
    assert.equal(shots.length, expectedN, `${target}s should use ${expectedN} clips`);
    assert.ok(Math.abs(totalOf(shots) - target) < 0.02, `${target}s target, got ${totalOf(shots)}s`);
    for (const s of shots) assert.ok(s.durationSec <= 5 && s.durationSec >= 3, `clip duration ${s.durationSec} out of range`);
  }
});

test('too few photos -> full-length clips and a shorter video', async () => {
  const photos = [photo('kitchen', 0.9), photo('living_room', 0.8), photo('bedroom', 0.7), photo('outdoor', 0.85)];
  const ctx = makeCtx();
  const shots = await engine.process(input(photos, 45), ctx);
  assert.equal(shots.length, 4);
  for (const s of shots) assert.equal(s.durationSec, 5);
  assert.equal(totalOf(shots), 17.75);
  assert.match(ctx.messages.at(-1) ?? '', /shorter than the requested 45s/);
});

// --- quality floor -----------------------------------------------------

test('quality floor drops junk instead of padding the tour', async () => {
  const good = [photo('kitchen', 0.92), photo('living_room', 0.88), photo('outdoor', 0.94), photo('outdoor', 0.92)];
  const junk = Array.from({ length: 8 }, () => photo('other', 0.05));
  const ctx = makeCtx();
  const shots = await engine.process(input([...good, ...junk], 45), ctx);
  assert.equal(shots.length, 4, 'only the 4 good photos make the cut');
  const junkIds = new Set(junk.map((j) => j.asset.id));
  for (const s of shots) assert.ok(!junkIds.has(s.assetId), 'no junk photo selected');
  assert.match(ctx.messages.at(-1) ?? '', /8 dropped below quality floor/);
});

test('all photos below the floor -> clear error', async () => {
  const junk = Array.from({ length: 10 }, () => photo('other', 0.05));
  await assert.rejects(
    engine.process(input(junk, 30), makeCtx()),
    /No photos passed the quality floor/,
  );
});

// --- selection ---------------------------------------------------------

test('coverage first: every distinct room appears before any room repeats', async () => {
  const photos = [
    ...Array.from({ length: 8 }, (_, i) => photo('kitchen', 0.9 - i * 0.01)),
    photo('bedroom', 0.5),
    photo('bathroom', 0.5),
  ];
  const shots = await engine.process(input(photos, 30), makeCtx()); // n=7
  const rooms = shots.map((s) => s.roomType);
  assert.ok(rooms.includes('bedroom'), 'low-quality bedroom still included for coverage');
  assert.ok(rooms.includes('bathroom'), 'low-quality bathroom still included for coverage');
});

test('per-room cap: variety beats one photogenic room, overflow only when needed', async () => {
  const photos = [
    ...Array.from({ length: 8 }, (_, i) => photo('kitchen', 0.9 - i * 0.01)),
    photo('bedroom', 0.5),
    photo('bedroom', 0.45),
    photo('bathroom', 0.5),
    photo('bathroom', 0.45),
  ];
  const shots = await engine.process(input(photos, 30), makeCtx()); // n=7
  const count = (r: string) => shots.filter((s) => s.roomType === r).length;
  assert.equal(count('bedroom'), 2, 'second bedroom beats third kitchen despite lower quality');
  assert.equal(count('bathroom'), 2);
  assert.equal(count('kitchen'), 3, 'kitchen overflows the cap only to fill remaining slots');
});

// --- ordering ----------------------------------------------------------

test('shots follow the canonical tour order', async () => {
  const photos = [
    photo('outdoor', 0.9),
    photo('kitchen', 0.9),
    photo('exterior_front', 0.9),
    photo('bedroom', 0.9),
    photo('living_room', 0.9),
    photo('aerial', 0.9),
    photo('foyer', 0.9),
  ];
  const shots = await engine.process(input(photos, 30), makeCtx());
  for (let i = 1; i < shots.length; i++) {
    assert.ok(
      ROOM_PRIORITY[shots[i - 1].roomType] <= ROOM_PRIORITY[shots[i].roomType],
      `order violated at ${shots[i - 1].roomType} -> ${shots[i].roomType}`,
    );
  }
  assert.equal(shots[0].roomType, 'exterior_front', 'tour opens on the exterior');
  assert.equal(shots.at(-1)?.roomType, 'aerial', 'tour closes wide');
});

test('selection is deterministic', async () => {
  const photos = Array.from({ length: 15 }, (_, i) =>
    photo((['kitchen', 'bedroom', 'outdoor'] as RoomType[])[i % 3], 0.8),
  );
  const a = await engine.process(input(photos, 45), makeCtx());
  const b = await engine.process(input(photos, 45), makeCtx());
  assert.deepEqual(a, b);
});

test('paceDurations: exact fit at the ideal clip count, full-length otherwise', () => {
  const cutLen = (d: number[], xfade: number) =>
    Math.round((d.reduce((a, b) => a + b, 0) - (d.length - 1) * xfade) * 100) / 100;

  // 30/45/60s at clip 5s, xfade 0.75s -> 7/11/14 clips, each cut sums exactly
  for (const [target, n] of [[30, 7], [45, 11], [60, 14]] as const) {
    const d = paceDurations(n, target, 5, 0.75);
    assert.equal(d.length, n);
    assert.equal(cutLen(d, 0.75), target, `${target}s cut must be exact`);
    assert.ok(d.every((x) => x <= 5 + 1e-9), 'no clip may exceed the clip max');
  }

  // fewer clips than ideal (review removals / too few photos) -> full length
  assert.deepEqual(paceDurations(4, 45, 5, 0.75), [5, 5, 5, 5]);
});

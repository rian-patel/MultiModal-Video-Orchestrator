import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { ClaudeFidelityEngine, type MessagesClient } from './claude';
import type { FidelityVerdict } from './schema';

function makeCtx(workDir: string, warnings: string[] = []): EngineContext {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    error: noop,
    child: () => logger,
  };
  return { workDir, config: defaultConfig, logger, progress: noop };
}

/** A real (tiny) JPEG so sharp can read the "source photo". */
async function makeSetup(shotCount: number) {
  const workDir = await mkdtemp(join(tmpdir(), 'rev-fidelity-'));
  const jpeg = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 180, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  const assets: Asset[] = [];
  const shots: Shot[] = [];
  for (let i = 0; i < shotCount; i++) {
    const id = `asset_${i}`;
    const sourcePath = join(workDir, `${id}.jpg`);
    await writeFile(sourcePath, jpeg);
    const clipPath = join(workDir, `shot-${i}.mp4`);
    await writeFile(clipPath, Buffer.from('fake-mp4'));
    assets.push({ id, sourcePath, originalName: `${id}.jpg`, width: 32, height: 32 });
    shots.push({
      order: i,
      assetId: id,
      roomType: 'living_room',
      durationSec: 5,
      prompt: `prompt ${i}`,
      clipPath,
      status: 'done',
    });
  }
  return { workDir, assets, shots };
}

const FAKE_FRAMES = [Buffer.from('f1'), Buffer.from('f2'), Buffer.from('f3')];

/** Client returning a fixed verdict per call order; records what it was sent. */
function fakeClient(verdicts: Array<FidelityVerdict | Error>) {
  let call = 0;
  const requests: Array<Record<string, unknown>> = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        requests.push(params);
        const v = verdicts[Math.min(call++, verdicts.length - 1)];
        if (v instanceof Error) throw v;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(v) }] };
      },
    },
  };
  return { client, requests };
}

function makeEngine(client: MessagesClient) {
  return new ClaudeFidelityEngine({
    clientImpl: client,
    extractFramesImpl: async () => FAKE_FRAMES,
  });
}

test('faithful clips stay done and are flagged as audited', async () => {
  const { workDir, assets, shots } = await makeSetup(2);
  const { client, requests } = fakeClient([{ verdict: 'faithful', problems: [] }]);
  const out = await makeEngine(client).process({ shots, assets }, makeCtx(workDir));

  assert.equal(out.length, 2);
  for (const s of out) {
    assert.equal(s.status, 'done');
    assert.equal(s.fidelityChecked, true);
  }
  assert.equal(requests.length, 2, 'one audit per clip');
  // Each audit sends the source photo + all sampled frames.
  const content = (requests[0].messages as Array<{ content: unknown[] }>)[0].content;
  assert.equal(content.filter((b) => (b as { type: string }).type === 'image').length, 1 + FAKE_FRAMES.length);
});

test('a drifted clip is failed (and left unflagged so resume re-audits the regen)', async () => {
  const { workDir, assets, shots } = await makeSetup(2);
  const warnings: string[] = [];
  const { client } = fakeClient([
    { verdict: 'drift', problems: ['a dining table appears that is not in the source'] },
    { verdict: 'faithful', problems: [] },
  ]);
  const out = await makeEngine(client).process({ shots, assets }, makeCtx(workDir, warnings));

  const failed = out.find((s) => s.status === 'failed');
  const ok = out.find((s) => s.status === 'done');
  assert.ok(failed, 'the drifted clip is dropped');
  assert.equal(failed!.fidelityChecked, undefined);
  assert.equal(ok!.fidelityChecked, true);
  assert.ok(
    warnings.some((w) => w.includes('dining table')),
    'the fabrication is logged',
  );
});

test('an audit error is fail-open: clip kept, unflagged', async () => {
  const { workDir, assets, shots } = await makeSetup(1);
  const { client } = fakeClient([new Error('api down')]);
  const out = await makeEngine(client).process({ shots, assets }, makeCtx(workDir));

  assert.equal(out[0].status, 'done', 'a paid clip is never failed by the audit itself');
  assert.equal(out[0].fidelityChecked, undefined, 'left unflagged for a later re-audit');
});

test('only new done clips are audited; failed and already-audited shots are skipped', async () => {
  const { workDir, assets, shots } = await makeSetup(3);
  shots[0].status = 'failed';
  shots[0].clipPath = undefined;
  shots[1].fidelityChecked = true;
  const { client, requests } = fakeClient([{ verdict: 'faithful', problems: [] }]);
  const out = await makeEngine(client).process({ shots, assets }, makeCtx(workDir));

  assert.equal(requests.length, 1, 'only the one unaudited done clip hits the API');
  assert.equal(out.find((s) => s.order === 0)!.status, 'failed');
  assert.equal(out.find((s) => s.order === 1)!.status, 'done');
  assert.equal(out.find((s) => s.order === 2)!.fidelityChecked, true);
});

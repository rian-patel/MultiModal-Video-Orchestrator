import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { HiggsfieldVideoGenEngine } from './higgsfield';

function makeCtx(workDir: string): EngineContext {
  const noop = () => {};
  return {
    workDir,
    config: defaultConfig,
    logger: { info: noop, warn: noop, error: noop, child: () => makeCtx(workDir).logger },
    progress: noop,
  };
}

async function setup(shotCount: number) {
  const workDir = await mkdtemp(join(tmpdir(), 'rev-videogen-'));
  const assets: Asset[] = [];
  const shots: Shot[] = [];
  for (let i = 0; i < shotCount; i++) {
    const id = `asset_${i}`;
    const sourcePath = join(workDir, `${id}.jpg`);
    await writeFile(sourcePath, Buffer.from(`fake-jpeg-${i}`));
    assets.push({ id, sourcePath, originalName: `${id}.jpg`, width: 100, height: 100 });
    shots.push({
      order: i,
      assetId: id,
      roomType: 'kitchen',
      durationSec: 5,
      prompt: `prompt ${i}`,
      motionPreset: 'dolly_in',
      status: 'pending',
    });
  }
  return { workDir, assets, shots };
}

const CLIP_BYTES = Buffer.from('fake-mp4-bytes');

/**
 * Fake platform API: submit -> request_id, one in_progress poll, then
 * completed with a download URL. `failSubmits` makes the first N submit
 * calls return HTTP 500; `alwaysFail` marks specific request ids failed.
 */
function fakeApi(opts: { failSubmits?: number; failRooms?: Set<string> } = {}) {
  let submitCount = 0;
  let failSubmitsLeft = opts.failSubmits ?? 0;
  const polls = new Map<string, number>();
  const submittedPrompts: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { prompt: string; image_url: string };
      assert.match(body.image_url, /^data:image\/jpeg;base64,/, 'image sent as data URI');
      if (failSubmitsLeft > 0) {
        failSubmitsLeft--;
        return new Response('boom', { status: 500 });
      }
      const id = `req_${submitCount++}_${body.prompt.replace(/\W/g, '_')}`;
      submittedPrompts.push(body.prompt);
      return Response.json({ request_id: id });
    }
    if (u.includes('/requests/')) {
      const id = u.split('/requests/')[1].split('/')[0];
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (opts.failRooms && [...opts.failRooms].some((r) => id.includes(r))) {
        return Response.json({ status: 'failed' });
      }
      if (n === 1) return Response.json({ status: 'in_progress' });
      return Response.json({ status: 'completed', video: { url: `https://cdn.example/${id}.mp4` } });
    }
    // clip download
    return new Response(CLIP_BYTES, { status: 200 });
  }) as typeof fetch;

  return { fetchImpl, submittedPrompts };
}

function makeEngine(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new HiggsfieldVideoGenEngine({
    apiKey: 'k:s',
    pollIntervalMs: 1,
    maxPollMs: 1000,
    fetchImpl,
    ...extra,
  });
}

test('happy path: submits prompt, polls to completion, downloads clip', async () => {
  const { workDir, assets, shots } = await setup(3);
  const api = fakeApi();
  const out = await makeEngine(api.fetchImpl).process({ shots, assets }, makeCtx(workDir));

  assert.equal(out.length, 3);
  for (const s of out) {
    assert.equal(s.status, 'done');
    assert.ok(s.clipPath?.endsWith(`shot-0${s.order}.mp4`));
    assert.ok(s.higgsfieldJobId);
    const bytes = await readFile(s.clipPath!);
    assert.deepEqual(bytes, CLIP_BYTES, 'clip bytes written to disk');
  }
  assert.deepEqual(api.submittedPrompts.sort(), ['prompt 0', 'prompt 1', 'prompt 2']);
});

test('transient submit failure is retried within the shot', async () => {
  const { workDir, assets, shots } = await setup(1);
  const api = fakeApi({ failSubmits: 1 }); // first submit 500s, retry succeeds
  const out = await makeEngine(api.fetchImpl).process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done');
});

test('a persistently failing shot is isolated, not fatal', async () => {
  const { workDir, assets, shots } = await setup(3);
  const api = fakeApi({ failRooms: new Set(['prompt_1']) }); // shot 1 always fails
  const out = await makeEngine(api.fetchImpl).process({ shots, assets }, makeCtx(workDir));
  assert.equal(out.filter((s) => s.status === 'done').length, 2);
  assert.equal(out.find((s) => s.order === 1)?.status, 'failed');
});

test('all shots failing rejects the run', async () => {
  const { workDir, assets, shots } = await setup(2);
  const api = fakeApi({ failSubmits: 999 });
  await assert.rejects(
    makeEngine(api.fetchImpl).process({ shots, assets }, makeCtx(workDir)),
    /All 2 clip generations failed/,
  );
});

test('missing API key rejects immediately', async () => {
  const { workDir, assets, shots } = await setup(1);
  const engine = new HiggsfieldVideoGenEngine({ apiKey: '', fetchImpl: fakeApi().fetchImpl });
  await assert.rejects(engine.process({ shots, assets }, makeCtx(workDir)), /HIGGSFIELD_API_KEY/);
});

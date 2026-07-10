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
 * Fake platform API modelling the real flow: image upload (get presigned URL,
 * PUT bytes) -> submit -> request_id -> one in_progress poll -> completed with
 * a download URL. `failSubmits` makes the first N submit calls return HTTP 500;
 * `failRooms` marks matching request ids failed.
 */
function fakeApi(opts: { failSubmits?: number; failRooms?: Set<string> } = {}) {
  let submitCount = 0;
  let uploadCount = 0;
  let failSubmitsLeft = opts.failSubmits ?? 0;
  const polls = new Map<string, number>();
  const submittedPrompts: string[] = [];
  const putUploads: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    // 1. presigned upload URL
    if (u.endsWith('/files/generate-upload-url')) {
      const n = uploadCount++;
      return Response.json({
        upload_url: `https://uploads.example/put/${n}`,
        public_url: `https://cdn.example/img/${n}.jpg`,
      });
    }
    // 2. PUT the raw bytes to the presigned URL
    if (init?.method === 'PUT') {
      assert.equal(
        (init.headers as Record<string, string>)['content-type'],
        'image/jpeg',
        'image PUT uses image/jpeg',
      );
      putUploads.push(u);
      return new Response(null, { status: 200 });
    }
    // 3. submit generation
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { prompt: string; image_url: string };
      assert.match(body.image_url, /^https:\/\/cdn\.example\/img\//, 'image_url is the hosted URL');
      assert.ok(body.image_url.length <= 2083, 'image_url within the platform URL limit');
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

  return { fetchImpl, submittedPrompts, putUploads };
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
  assert.equal(api.putUploads.length, 3, 'each shot uploaded its image before submit');
});

test('transient submit failure is retried within the shot', async () => {
  const { workDir, assets, shots } = await setup(1);
  const api = fakeApi({ failSubmits: 1 }); // first submit 500s, retry succeeds
  const out = await makeEngine(api.fetchImpl).process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done');
});

test('a transient upload-url failure is retried before a job is created', async () => {
  const { workDir, assets, shots } = await setup(1);
  let uploadLinkCalls = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/files/generate-upload-url')) {
      uploadLinkCalls++;
      if (uploadLinkCalls === 1) return new Response('<html>502</html>', { status: 502 });
      return Response.json({ upload_url: 'https://uploads.example/put/0', public_url: 'https://cdn.example/img/0.jpg' });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    if (init?.method === 'POST') return Response.json({ request_id: 'req_ok' });
    if (u.includes('/requests/')) return Response.json({ status: 'completed', video: { url: 'https://cdn.example/x.mp4' } });
    return new Response(CLIP_BYTES, { status: 200 });
  }) as typeof fetch;

  const out = await makeEngine(fetchImpl).process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done', 'retry after the 502 succeeds');
  assert.equal(uploadLinkCalls, 2, 'upload-url was retried exactly once');
});

test('a poll timeout is NEVER resubmitted (no double-billing)', async () => {
  const { workDir, assets, shots } = await setup(1);
  let submits = 0;
  // Submit always succeeds; polling always says in_progress -> forces a timeout.
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/files/generate-upload-url')) {
      return Response.json({ upload_url: 'https://uploads.example/put/0', public_url: 'https://cdn.example/img/0.jpg' });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    if (init?.method === 'POST') { submits++; return Response.json({ request_id: `req_${submits}` }); }
    if (u.includes('/requests/')) return Response.json({ status: 'in_progress' });
    return new Response(CLIP_BYTES, { status: 200 });
  }) as typeof fetch;

  // maxAttempts 3 would resubmit thrice under the old logic; the split must
  // submit exactly once because the failure is in the (billable) poll phase.
  // The lone shot fails, so process() rejects (all clips failed) — that's fine;
  // the point under test is that only ONE billable job was ever created.
  const engine = new HiggsfieldVideoGenEngine({
    apiKey: 'k:s', pollIntervalMs: 1, maxPollMs: 20, maxAttempts: 3, fetchImpl,
  });
  await assert.rejects(engine.process({ shots, assets }, makeCtx(workDir)), /All 1 clip generations failed/);
  assert.equal(submits, 1, 'exactly one billable job created despite maxAttempts=3');
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

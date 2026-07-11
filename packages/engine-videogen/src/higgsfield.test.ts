import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { HiggsfieldVideoGenEngine, MOTION_IDS } from './higgsfield';

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

/** The v2 submit body shape (POST /v1/image2video/dop). */
interface SubmitParams {
  prompt: string;
  input_images: Array<{ type: string; image_url: string }>;
  model: string;
  motions: Array<{ id: string; strength: number }>;
  enhance_prompt: boolean;
}

/**
 * Fake platform v2 API modelling the real flow: image upload (get presigned
 * URL, PUT bytes) -> submit to /v1/image2video/dop -> job-set id -> one
 * in_progress poll -> completed with a download URL. `failSubmits` makes the
 * first N submit calls return HTTP 500; `failRooms` marks matching ids failed.
 */
function fakeApi(opts: { failSubmits?: number; failRooms?: Set<string> } = {}) {
  let submitCount = 0;
  let uploadCount = 0;
  let failSubmitsLeft = opts.failSubmits ?? 0;
  const polls = new Map<string, number>();
  const submittedPrompts: string[] = [];
  const submittedParams: SubmitParams[] = [];
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
    // 3. submit generation (v2 endpoint, {params:{...}} envelope)
    if (init?.method === 'POST') {
      assert.ok(u.endsWith('/v1/image2video/dop'), `submit goes to the v2 endpoint, got ${u}`);
      const { params } = JSON.parse(String(init.body)) as { params: SubmitParams };
      const imageUrl = params.input_images[0]?.image_url ?? '';
      assert.match(imageUrl, /^https:\/\/cdn\.example\/img\//, 'image_url is the hosted URL');
      assert.ok(imageUrl.length <= 2083, 'image_url within the platform URL limit');
      assert.equal(params.enhance_prompt, false, 'prompt enhancer is always disabled');
      assert.equal(params.motions.length, 1, 'exactly one motion preset per shot');
      assert.ok(
        params.motions[0].strength >= 0 && params.motions[0].strength <= 1,
        'motion strength within the API bounds 0..1',
      );
      assert.ok(
        ['dop-turbo', 'dop-lite', 'dop-preview'].includes(params.model),
        `model within the v2 enum, got ${params.model}`,
      );
      if (failSubmitsLeft > 0) {
        failSubmitsLeft--;
        return new Response('boom', { status: 500 });
      }
      const id = `req_${submitCount++}_${params.prompt.replace(/\W/g, '_')}`;
      submittedPrompts.push(params.prompt);
      submittedParams.push(params);
      return Response.json({ id });
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

  return { fetchImpl, submittedPrompts, submittedParams, putUploads };
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

test('fidelity knobs: motion preset maps to catalog UUID, strength + model are applied', async () => {
  const { workDir, assets, shots } = await setup(2);
  shots[0].motionPreset = 'lateral_glide';
  shots[1].motionPreset = 'no_such_preset';
  const api = fakeApi();
  // Legacy model value must be normalized into the v2 enum, not sent verbatim.
  const engine = makeEngine(api.fetchImpl, { motionStrength: 0.22, model: 'higgsfield-ai/dop/standard' });
  const out = await engine.process({ shots, assets }, makeCtx(workDir));

  assert.equal(out.filter((s) => s.status === 'done').length, 2);
  const byPrompt = new Map(api.submittedParams.map((p) => [p.prompt, p]));
  const glide = byPrompt.get('prompt 0')!;
  assert.equal(glide.motions[0].id, MOTION_IDS.lateral_glide, 'preset mapped to its catalog UUID');
  assert.equal(glide.motions[0].strength, 0.22, 'configured low strength is sent');
  assert.equal(glide.model, 'dop-turbo', 'legacy model name normalized to the v2 default');
  const unknown = byPrompt.get('prompt 1')!;
  assert.equal(unknown.motions[0].id, MOTION_IDS.dolly_in, 'unknown preset falls back to Dolly In');
});

test('seedance models hit the seedance endpoint with its own body shape', async () => {
  const { workDir, assets, shots } = await setup(1);
  const submitted: { url: string; params: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/files/generate-upload-url')) {
      return Response.json({ upload_url: 'https://uploads.example/put/0', public_url: 'https://cdn.example/img/0.jpg' });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    if (init?.method === 'POST') {
      submitted.push({ url: u, params: (JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params });
      return Response.json({ id: 'jobset_1' });
    }
    if (u.includes('/requests/')) return Response.json({ status: 'completed', video: { url: 'https://cdn.example/x.mp4' } });
    return new Response(CLIP_BYTES, { status: 200 });
  }) as typeof fetch;

  const out = await makeEngine(fetchImpl, { model: 'seedance_pro' }).process({ shots, assets }, makeCtx(workDir));
  assert.equal(out[0].status, 'done');
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].url, /\/v1\/image2video\/seedance$/);
  const p = submitted[0].params;
  // Seedance traps (verified live): `prompts` must be an ARRAY (a bare
  // `prompt` is silently dropped -> a promptless clip invented a person), and
  // there is no motion catalog — so no `motions` and no bare `prompt` here.
  assert.deepEqual(p.prompts, ['prompt 0'], 'prompt travels in the prompts array');
  assert.equal(p.prompt, undefined);
  assert.equal(p.motions, undefined);
  assert.deepEqual(p.input_image, { type: 'image_url', image_url: 'https://cdn.example/img/0.jpg' });
  assert.equal(p.resolution, '1080', 'native 1080p from config resolution');
  assert.equal(p.duration, 5, 'config clipDurationSec');
  assert.equal(p.aspect_ratio, '16:9');
  assert.equal(p.camera_fixed, false, 'camera carries the motion, not scene animation');
  assert.equal(p.enhance_prompt, false, 'platform prompt-enhancer stays off');
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

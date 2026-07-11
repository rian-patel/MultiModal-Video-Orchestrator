// One-clip prototype against the Higgsfield v2 endpoint (/v1/image2video/dop).
// Purpose: test whether a LOW motion strength keeps the generative clip faithful
// to the source photo (the fidelity lever the legacy /{model} path cannot set).
// Spends ~1 clip of credits. Usage:
//   tsx scripts/prototype-dop-v2.ts [imagePath] [strength] [motionName]
//
// Schema (probed live via 422 validation errors, 2026-07):
//   POST /v1/image2video/dop
//   { params: { prompt, input_images: [{type:'image_url', image_url}],
//               model?: 'dop-lite'|'dop-preview'|'dop-turbo',
//               motions?: [{ id: <UUID from GET /v1/motions>, strength: 0..1 }],
//               seed?: int, enhance_prompt?: bool } }
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIDELITY_CONSTRAINT } from '@rev/engine-prompt';

try {
  process.loadEnvFile('.env');
} catch {
  /* checked below */
}

const BASE = 'https://platform.higgsfield.ai';
const KEY = process.env.HIGGSFIELD_API_KEY ?? '';

// From GET /v1/motions (121 presets). The low-travel ones we care about:
const MOTIONS: Record<string, string> = {
  'dolly-in': '81ca2cd2-05db-4222-9ba0-a32e5185adfb',
  'zoom-in': 'fbcbec5b-30f8-4b17-ba6e-8e8d5b265562',
  static: 'fa3ddb7c-53ee-4383-aa17-97ae65f180e5',
  'dolly-out': '12ac8798-5370-4801-91a6-f1acb425fc4a',
  'crane-up': '68af9add-43ea-4261-a706-16b640fdcff9',
  'tilt-up': '2c9af101-fe7a-4299-91f3-e44431a0576f',
};

const imgPath = process.argv[2] ?? 'test-photos-real/EFwHKWl866cce87ba3f9d.jpeg';
const strength = Number(process.argv[3] ?? 0.3);
const motionName = process.argv[4] ?? 'dolly-in';
const motionId = MOTIONS[motionName];
if (!motionId) throw new Error(`unknown motion "${motionName}" — one of ${Object.keys(MOTIONS).join(', ')}`);

// The exact fidelity-first prompt the pipeline writes for this living-room shot.
const prompt = `Camera: a slow, subtle push-in with minimal travel. Bright light; warm, inviting and airy. ${FIDELITY_CONSTRAINT}`;

async function uploadImage(path: string): Promise<string> {
  const bytes = await readFile(path);
  const linkRes = await fetch(`${BASE}/files/generate-upload-url`, {
    method: 'POST',
    headers: { authorization: `Key ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content_type: 'image/jpeg' }),
  });
  if (!linkRes.ok) throw new Error(`upload-url failed: HTTP ${linkRes.status}`);
  const { upload_url, public_url } = (await linkRes.json()) as { upload_url: string; public_url: string };
  const putRes = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: bytes });
  if (!putRes.ok) throw new Error(`image PUT failed: HTTP ${putRes.status}`);
  return public_url;
}

async function main() {
  if (!KEY) throw new Error('HIGGSFIELD_API_KEY not set');
  console.log(`image:    ${imgPath}`);
  console.log(`motion:   ${motionName} (${motionId}) @ strength ${strength}`);
  console.log(`prompt:   ${prompt}\n`);

  const imageUrl = await uploadImage(imgPath);
  console.log(`uploaded: ${imageUrl}`);

  const submitRes = await fetch(`${BASE}/v1/image2video/dop`, {
    method: 'POST',
    headers: { authorization: `Key ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      params: {
        prompt,
        input_images: [{ type: 'image_url', image_url: imageUrl }],
        motions: [{ id: motionId, strength }],
        enhance_prompt: false,
      },
    }),
  });
  const submitBody = await submitRes.text();
  console.log(`\nsubmit:   HTTP ${submitRes.status}`);
  console.log(submitBody.slice(0, 2000));
  if (!submitRes.ok) process.exit(1);

  // v2 submit returns a job-set: { id, jobs: [{id, status}], input_params }.
  // Both GET /v1/job-sets/{id} (rich) and the legacy GET /requests/{id}/status
  // (fal-style {status, video.url}) accept this id — we poll the legacy route
  // since it's the shape the engine already understands.
  const parsed = JSON.parse(submitBody) as Record<string, unknown>;
  const requestId = (parsed.request_id ?? parsed.id) as string | undefined;
  const statusUrl = requestId ? `${BASE}/requests/${requestId}/status` : undefined;
  if (!statusUrl) throw new Error('no id in submit response');
  console.log(`\npolling:  ${statusUrl}`);

  const t0 = Date.now();
  const deadline = t0 + 20 * 60_000;
  let last = '';
  while (true) {
    const res = await fetch(statusUrl, { headers: { authorization: `Key ${KEY}` } });
    if (!res.ok) throw new Error(`poll failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { status: string; video?: { url?: string }; video_url?: string };
    if (body.status !== last) {
      last = body.status;
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${body.status}`);
    }
    if (body.status === 'completed') {
      const url = body.video?.url ?? body.video_url;
      if (!url) throw new Error(`completed but no video url: ${JSON.stringify(body).slice(0, 500)}`);
      const outDir = join('projects', 'prototype');
      await mkdir(outDir, { recursive: true });
      const out = join(outDir, `living-room-v2-${motionName}-s${String(strength).replace('.', '')}.mp4`);
      const dl = await fetch(url);
      if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
      await writeFile(out, Buffer.from(await dl.arrayBuffer()));
      console.log(`\nDONE in ${Math.round((Date.now() - t0) / 1000)}s -> ${out}`);
      return;
    }
    if (body.status === 'failed' || body.status === 'nsfw') {
      throw new Error(`generation ${body.status}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    if (Date.now() > deadline) throw new Error('timed out after 20 min');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error('\nPROTOTYPE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

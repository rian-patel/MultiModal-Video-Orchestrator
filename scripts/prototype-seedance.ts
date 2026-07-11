// One-clip prototype against /v1/image2video/seedance (probed 2026-07):
//   { params: { prompts: string[]   <- NOT `prompt`; a bare `prompt` field is
//               SILENTLY IGNORED (learned the expensive way: the promptless
//               clip invented a person walking through the living room),
//               input_image: {type:'image_url', image_url},
//               model: 'seedance_pro'|'seedance_lite', resolution: '480'|'720'|'1080',
//               duration: 3..12, aspect_ratio: 'auto'|'16:9'|'9:16'|'21:9'|...,
//               camera_fixed: bool (default true), motion_id: UUID (same
//               catalog as DoP's GET /v1/motions — no strength though),
//               enhance_prompt, input_image_end?: end-frame control } }
// Purpose: does native-1080p Seedance beat DoP's fixed 720p on crispness while
// staying faithful (no motion-strength lever here — prompt + enhance_prompt:false
// + the fidelity audit are the only controls)? Spends ~1 premium clip.
// Usage: tsx scripts/prototype-seedance.ts [imagePath] [model] [resolution]
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

const imgPath = process.argv[2] ?? 'test-photos-real/EFwHKWl866cce87ba3f9d.jpeg';
const model = process.argv[3] ?? 'seedance_pro';
const resolution = process.argv[4] ?? '1080';

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
  console.log(`image:      ${imgPath}`);
  console.log(`model:      ${model} @ ${resolution}p 16:9, 5s`);
  console.log(`prompt:     ${prompt}\n`);

  const imageUrl = await uploadImage(imgPath);
  console.log(`uploaded:   ${imageUrl}`);

  const submitRes = await fetch(`${BASE}/v1/image2video/seedance`, {
    method: 'POST',
    headers: { authorization: `Key ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      params: {
        prompts: [prompt],
        input_image: { type: 'image_url', image_url: imageUrl },
        model,
        resolution,
        duration: 5,
        aspect_ratio: '16:9',
        // The camera does the moving; a fixed camera makes Seedance animate
        // the scene instead (it invented a person on the promptless test).
        // NOTE: motion_id is rejected with "Motion not found" for every
        // catalog UUID tried — Seedance takes its camera move from the
        // prompt text instead (the DoP motion catalog is DoP-only).
        camera_fixed: false,
        enhance_prompt: false,
      },
    }),
  });
  const submitBody = await submitRes.text();
  console.log(`\nsubmit:     HTTP ${submitRes.status}`);
  console.log(submitBody.slice(0, 1500));
  if (!submitRes.ok) process.exit(1);

  const parsed = JSON.parse(submitBody) as Record<string, unknown>;
  const requestId = (parsed.request_id ?? parsed.id) as string | undefined;
  if (!requestId) throw new Error('no id in submit response');
  const statusUrl = `${BASE}/requests/${requestId}/status`;
  console.log(`\npolling:    ${statusUrl}`);

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
      const out = join(outDir, `living-room-${model}-${resolution}p-dolly.mp4`);
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

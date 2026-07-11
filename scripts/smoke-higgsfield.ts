// One-clip smoke test for the real Higgsfield platform API. Spends ~1 clip of
// credits. Validates the whole real path end-to-end: auth header, CDN image
// upload, v2 submit (motion strength + enhance_prompt off), status polling,
// and download — before committing to a full multi-clip run.
// Usage: tsx scripts/smoke-higgsfield.ts [imagePath]
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { HiggsfieldVideoGenEngine } from '@rev/engine-videogen';

// Load <repo>/.env so HIGGSFIELD_API_KEY is present before the engine reads it.
try {
  process.loadEnvFile('.env');
} catch {
  // fall through — the explicit check below reports a missing key
}

const DEFAULT_IMG = 'test-photos-real/rJA9N5nZ66cce88459dce.jpeg'; // smallest of the 7
const imgPath = process.argv[2] ?? DEFAULT_IMG;

const workDir = join(defaultConfig.projectsDir, 'smoke-higgsfield');

const asset: Asset = {
  id: 'asset_smoke',
  sourcePath: imgPath,
  originalName: imgPath,
  width: 0,
  height: 0,
};

const shot: Shot = {
  order: 0,
  assetId: asset.id,
  roomType: 'living_room',
  durationSec: defaultConfig.clipDurationSec,
  prompt:
    'Slow cinematic dolly-in through the room. Smooth, steady camera; photoreal; ' +
    'no people, no text.',
  status: 'pending',
};

const logger = createLogger('smoke');
const ctx: EngineContext = {
  workDir,
  config: defaultConfig,
  logger,
  progress: (pct, msg) => logger.info(`[${pct}%] ${msg}`),
};

async function main() {
  await mkdir(workDir, { recursive: true });
  if (!process.env.HIGGSFIELD_API_KEY) {
    throw new Error('HIGGSFIELD_API_KEY not in env — run via a shell that loaded .env');
  }
  console.log(`\nSmoke test: 1 clip from ${imgPath}`);
  console.log(`Model: ${process.env.HIGGSFIELD_MODEL ?? 'dop-turbo'}, motion strength ${process.env.HIGGSFIELD_MOTION_STRENGTH ?? '0.3'} (engine defaults)\n`);

  const t0 = Date.now();
  const engine = new HiggsfieldVideoGenEngine();
  const [out] = await engine.process({ shots: [shot], assets: [asset] }, ctx);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log('\n--- result ---');
  console.log('status:      ', out.status);
  console.log('jobId:       ', out.higgsfieldJobId ?? '(none)');
  console.log('clipPath:    ', out.clipPath ?? '(none)');
  console.log('elapsed:     ', `${secs}s`);
  if (out.status !== 'done') {
    console.error('\nSMOKE TEST FAILED — see the warning above for the reason.');
    process.exit(1);
  }
  console.log('\nSMOKE TEST PASSED — the real Higgsfield path works.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST ERROR:', err instanceof Error ? err.message : err);
  process.exit(1);
});

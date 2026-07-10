// One-off: generate a real cinematic tour from the photos in test-photos-real/
// using the real Higgsfield API. Spends credits (one clip per selected photo).
//
// Credit-safety for this run:
//   - maxAttempts: 1  -> a shot is NEVER resubmitted, so at most ONE clip is
//     billed per photo (a failed shot is skipped; the tour still renders).
//   - maxPollMs: 25min -> well above the ~16min/clip observed for dop/standard,
//     so a slow-but-fine clip is never falsely timed out (which would waste it).
//
// The real LocalUploadEngine enforces a 10-photo minimum; this inline upload
// step does the same sharp EXIF-normalize without the count gate so a small
// set (the user's 7 photos) can be used.
import { readdir, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import sharp from 'sharp';
import { createLogger, defaultConfig, newId } from '@rev/core';
import type { Asset, Engine, EngineContext } from '@rev/core';
import type { UploadRequest } from '@rev/engine-upload';
import type { VideoMode } from '@rev/core';
import { ClaudeVisionEngine } from '@rev/engine-vision';
import { HiggsfieldVideoGenEngine, KenBurnsVideoGenEngine } from '@rev/engine-videogen';
import { runPipeline } from '@rev/orchestrator';

try {
  process.loadEnvFile('.env');
} catch {
  /* keys checked below */
}

const PHOTO_DIR = process.argv[2] ?? 'test-photos-real';
const TARGET = Number(process.argv[3] ?? 30) as 30 | 45 | 60;
// 'faithful' (default) = Ken Burns, no credits, guaranteed faithful.
// 'cinematic' = generative Higgsfield (spends credits, can drift).
const MODE: VideoMode = process.argv[4] === 'cinematic' ? 'cinematic' : 'faithful';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Upload without the 10-photo minimum: EXIF-rotate + normalize to JPEG. */
class SmallSetUploadEngine implements Engine<UploadRequest, Asset[]> {
  readonly name = 'upload:small-set';
  async process(input: UploadRequest, ctx: EngineContext): Promise<Asset[]> {
    const sourceDir = join(ctx.workDir, 'source');
    const thumbsDir = join(ctx.workDir, 'thumbs');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(thumbsDir, { recursive: true });
    const assets: Asset[] = [];
    for (let i = 0; i < input.sources.length; i++) {
      const s = input.sources[i];
      const id = newId('asset');
      const sourcePath = join(sourceDir, `${id}.jpg`);
      const thumbPath = join(thumbsDir, `${id}.jpg`);
      const info = await sharp(s.tmpPath).rotate().jpeg({ quality: 92 }).toFile(sourcePath);
      await sharp(sourcePath).resize({ width: 320, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbPath);
      assets.push({ id, sourcePath, thumbPath, originalName: s.originalName, width: info.width, height: info.height });
      ctx.progress(Math.round(((i + 1) / input.sources.length) * 100), `Normalized ${s.originalName}`);
    }
    return assets;
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env');
  if (MODE === 'cinematic' && !process.env.HIGGSFIELD_API_KEY) {
    throw new Error('cinematic mode needs HIGGSFIELD_API_KEY in .env');
  }

  const files = (await readdir(PHOTO_DIR))
    .filter((f) => IMG_EXT.has(extname(f).toLowerCase()))
    .sort();
  if (files.length === 0) throw new Error(`No images in ${PHOTO_DIR}`);

  const request: UploadRequest = {
    sources: files.map((f) => ({ originalName: f, tmpPath: join(PHOTO_DIR, f) })),
  };

  const videogen =
    MODE === 'cinematic'
      ? new HiggsfieldVideoGenEngine({
          maxAttempts: 1, // never resubmit -> at most one billed clip per shot
          maxPollMs: 25 * 60_000, // safely above observed dop/standard latency
          pollIntervalMs: 10_000,
        })
      : new KenBurnsVideoGenEngine();

  const logger = createLogger('generate-real');
  logger.info(`${files.length} photos from ${PHOTO_DIR} -> ${TARGET}s ${MODE} tour`);
  console.log(
    MODE === 'cinematic'
      ? 'NOTE: generative i2v — spends credits, a few min per clip.\n'
      : 'NOTE: faithful Ken Burns — no credits, real pan/zoom over your photos, seconds.\n',
  );

  const t0 = Date.now();
  const { project, render } = await runPipeline({
    request,
    targetDurationSec: TARGET,
    mode: MODE,
    engines: {
      upload: new SmallSetUploadEngine(),
      vision: new ClaudeVisionEngine(),
      videogen,
    },
    onProgress: (pct, stage, msg) => logger.info(`[${String(pct).padStart(3)}%] ${stage.padEnd(11)} ${msg}`),
  });
  if (!render) throw new Error('no render result');

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const done = project.shots.filter((s) => s.status === 'done').length;
  console.log('\n===== DONE =====');
  console.log(`clips generated: ${done}/${project.shots.length}`);
  console.log(`rooms:           ${project.shots.map((s) => s.roomType).join(' -> ')}`);
  console.log(`output:          ${render.outputPath}`);
  console.log(`duration:        ~${render.totalDurationSec}s`);
  console.log(`project:         ${project.id}`);
  console.log(`wall time:       ${mins} min`);
}

main().catch((err) => {
  console.error('\nGENERATE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

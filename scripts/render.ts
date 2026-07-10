// Stitch a folder of MP4 clips into one crossfaded tour — debug tool for the
// Render Engine. Clips are used in alphabetical order at full length.
//
// Usage: npx tsx scripts/render.ts <clipsDir> [outputPath]
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger, defaultConfig } from '@rev/core';
import type { EngineContext, Shot } from '@rev/core';
import { FfmpegRenderEngine, probeDurationSec } from '@rev/engine-render';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npx tsx scripts/render.ts <clipsDir> [outputPath]');
    process.exit(1);
  }
  const outputPath = resolve(process.argv[3] ?? join(dir, 'tour.mp4'));

  const files = (await readdir(dir))
    .filter((f) => f.toLowerCase().endsWith('.mp4') && resolve(join(dir, f)) !== outputPath)
    .sort();
  if (files.length === 0) {
    console.error(`No .mp4 clips in ${dir}`);
    process.exit(1);
  }

  const shots: Shot[] = [];
  for (let i = 0; i < files.length; i++) {
    const clipPath = join(dir, files[i]);
    const durationSec = await probeDurationSec(clipPath);
    shots.push({
      order: i,
      assetId: `clip_${i}`,
      roomType: 'other',
      durationSec: Math.round(durationSec * 100) / 100,
      clipPath,
      status: 'done',
    });
    console.log(`${i + 1}. ${files[i]} (${durationSec.toFixed(2)}s)`);
  }

  const logger = createLogger('render');
  const ctx: EngineContext = {
    workDir: dir,
    config: defaultConfig,
    logger,
    progress: (pct, msg) => process.stdout.write(`\r[${String(pct).padStart(3)}%] ${msg.padEnd(50)}`),
  };

  const result = await new FfmpegRenderEngine().process({ shots, outputPath }, ctx);
  process.stdout.write('\n');
  console.log(`\nDone: ${result.outputPath} (~${result.totalDurationSec}s, plan: ${result.planPath})\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

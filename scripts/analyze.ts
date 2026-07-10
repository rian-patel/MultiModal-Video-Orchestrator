// Phase 2 debug view: run the Claude Vision Engine on a folder of photos and
// print the analysis table — no server, no UI, no 10-photo minimum.
//
// Usage: npx tsx scripts/analyze.ts [photosDir]     (default: test-photos/)
// Needs ANTHROPIC_API_KEY in .env or the environment.
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import { createLogger, defaultConfig, newId } from '@rev/core';
import type { Asset, EngineContext } from '@rev/core';
import { ClaudeVisionEngine } from '@rev/engine-vision';

try {
  process.loadEnvFile(join(import.meta.dirname, '..', '.env'));
} catch {
  // .env optional if the key is already in the environment
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Add it to .env (see .env.example).');
    process.exit(1);
  }

  const dir = process.argv[2] ?? join(import.meta.dirname, '..', 'test-photos');
  const names = (await readdir(dir)).filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase()));
  if (names.length === 0) {
    console.error(`No images found in ${dir}`);
    process.exit(1);
  }

  // Build Assets directly from the folder (bypasses the Upload Engine so any
  // number of photos works for debugging).
  const assets: Asset[] = [];
  for (const name of names) {
    const sourcePath = join(dir, name);
    await stat(sourcePath);
    const meta = await sharp(sourcePath).metadata();
    assets.push({
      id: newId('asset'),
      sourcePath,
      originalName: name,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    });
  }

  console.log(`\nAnalyzing ${assets.length} photos in ${dir} with Claude vision...\n`);
  const started = Date.now();

  const logger = createLogger('analyze');
  const ctx: EngineContext = {
    workDir: dir,
    config: defaultConfig,
    logger,
    progress: (pct, msg) => process.stdout.write(`\r[${String(pct).padStart(3)}%] ${msg.slice(0, 76).padEnd(76)}`),
  };

  const engine = new ClaudeVisionEngine();
  const results = await engine.process(assets, ctx);
  process.stdout.write('\n\n');

  const byId = new Map(assets.map((a) => [a.id, a]));
  const col = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));

  console.log(
    col('photo', 22) + col('room', 16) + col('q', 6) + col('light', 7) + col('suggested move', 34) + 'description',
  );
  console.log('-'.repeat(130));
  for (const r of results) {
    const a = byId.get(r.assetId)!;
    console.log(
      col(a.originalName, 22) +
        col(r.roomType, 16) +
        col(r.qualityScore.toFixed(2), 6) +
        col(r.lighting, 7) +
        col(r.suggestedMove, 34) +
        r.description,
    );
    if (r.features.length) console.log(' '.repeat(22) + `features: ${r.features.join(', ')}`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s (concurrency 4, model claude-opus-4-8)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Run the Claude fidelity audit on ONE clip against ONE source photo — the
// same audit the pipeline runs after videogen, usable standalone on prototype
// clips. Costs a few vision calls. Usage:
//   tsx scripts/audit-clip.ts <clipPath> <sourceImagePath> [durationSec]
import { createLogger, defaultConfig } from '@rev/core';
import type { Asset, EngineContext, Shot } from '@rev/core';
import { ClaudeFidelityEngine } from '@rev/engine-fidelity';

try {
  process.loadEnvFile('.env');
} catch {
  /* checked below */
}

const [clipPath, sourcePath, durationArg] = process.argv.slice(2);
if (!clipPath || !sourcePath) {
  console.error('usage: tsx scripts/audit-clip.ts <clipPath> <sourceImagePath> [durationSec]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

const asset: Asset = { id: 'a0', sourcePath, originalName: sourcePath, width: 0, height: 0 };
const shot: Shot = {
  order: 0,
  assetId: 'a0',
  roomType: 'living_room',
  durationSec: Number(durationArg ?? defaultConfig.clipDurationSec),
  clipPath,
  status: 'done',
};

const logger = createLogger('audit');
const ctx: EngineContext = {
  workDir: '.',
  config: defaultConfig,
  logger,
  progress: (pct, msg) => logger.info(`[${pct}%] ${msg}`),
};

const engine = new ClaudeFidelityEngine();
const [out] = await engine.process({ shots: [shot], assets: [asset] }, ctx);
console.log('\nverdict:', out.status === 'done' ? 'FAITHFUL' : 'DRIFT (would be dropped + regenerated)');
process.exit(out.status === 'done' ? 0 : 2);

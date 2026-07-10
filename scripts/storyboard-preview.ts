// Replay the Storyboard + Prompt engines against a saved project's vision
// data — tune selection/pacing without re-paying for vision API calls.
//
// Usage: npx tsx scripts/storyboard-preview.ts <projectId> [targetSec]
//   e.g. npx tsx scripts/storyboard-preview.ts proj_5e627dec 30
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, defaultConfig } from '@rev/core';
import type { EngineContext, Project } from '@rev/core';
import { RuleBasedStoryboardEngine } from '@rev/engine-storyboard';
import { TemplatePromptEngine } from '@rev/engine-prompt';

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error('Usage: npx tsx scripts/storyboard-preview.ts <projectId> [targetSec]');
    console.error('Project IDs are the folder names under projects/.');
    process.exit(1);
  }

  const path = join(import.meta.dirname, '..', 'projects', projectId, 'project.json');
  const project = JSON.parse(await readFile(path, 'utf8')) as Project;
  if (!project.vision?.length) {
    console.error(`${projectId} has no vision results (stage=${project.stage}).`);
    process.exit(1);
  }

  const target = process.argv[3] ? Number(process.argv[3]) : project.targetDurationSec;
  const logger = createLogger('preview');
  const ctx: EngineContext = {
    workDir: join('projects', projectId),
    config: defaultConfig,
    logger,
    progress: () => {},
  };

  console.log(`\nStoryboard preview: ${projectId} — ${project.assets.length} photos, target ${target}s`);
  console.log(
    `(floor=${defaultConfig.storyboard.minQualityScore}, cap=${defaultConfig.storyboard.maxShotsPerRoom}/room, clip<=${defaultConfig.clipDurationSec}s, xfade=${defaultConfig.crossfadeSec}s)\n`,
  );

  const storyboard = new RuleBasedStoryboardEngine();
  const prompt = new TemplatePromptEngine();

  let shots = await storyboard.process(
    { assets: project.assets, vision: project.vision, targetDurationSec: target },
    ctx,
  );
  shots = await prompt.process({ shots, vision: project.vision }, ctx);

  const byId = new Map(project.assets.map((a) => [a.id, a]));
  const visionById = new Map(project.vision.map((v) => [v.assetId, v]));
  for (const s of shots) {
    const a = byId.get(s.assetId);
    const v = visionById.get(s.assetId);
    console.log(
      `${String(s.order + 1).padStart(2)}. ${s.roomType.padEnd(15)} ${s.durationSec.toFixed(2)}s  q=${v?.qualityScore.toFixed(2)}  [${s.motionPreset}]  (${a?.originalName})`,
    );
    console.log(`      ${s.prompt}`);
  }

  const total = shots.reduce((sum, s) => sum + s.durationSec, 0) - (shots.length - 1) * defaultConfig.crossfadeSec;
  const skipped = project.vision.filter((v) => v.qualityScore < defaultConfig.storyboard.minQualityScore);
  console.log(`\nTotal: ${shots.length} shots -> ${total.toFixed(2)}s (target ${target}s)`);
  if (skipped.length) {
    console.log(`Dropped below quality floor: ${skipped.map((v) => byId.get(v.assetId)?.originalName).join(', ')}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

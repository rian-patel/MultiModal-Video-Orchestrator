import { runPipeline } from '@rev/orchestrator';
import type { UploadRequest } from '@rev/engine-upload';

// Fake "uploaded" photos. The mock Upload/Vision engines turn these into a
// realistic room spread so we can watch the whole pipeline run with no APIs.
const PHOTO_NAMES = Array.from({ length: 14 }, (_, i) => `IMG_${2001 + i}.jpg`);

const request: UploadRequest = {
  sources: PHOTO_NAMES.map((originalName) => ({ originalName })),
};

async function main() {
  console.log('\n=== Real Estate Video Generator — Phase 0 mock pipeline ===\n');

  const { project, render } = await runPipeline({
    request,
    targetDurationSec: 45,
    onProgress: (pct, stage, msg) => {
      const bar = '#'.repeat(Math.floor(pct / 5)).padEnd(20, '.');
      process.stdout.write(
        `\r[${bar}] ${String(pct).padStart(3)}%  ${stage.padEnd(11)} ${msg.slice(0, 46).padEnd(46)}`,
      );
      if (pct === 100 && stage === 'render') process.stdout.write('\n');
    },
  });

  console.log('\n--- Storyboard --------------------------------------------');
  for (const s of project.shots) {
    console.log(`  ${String(s.order + 1).padStart(2)}. ${s.roomType.padEnd(16)} ${s.durationSec}s  [${s.motionPreset}]`);
    console.log(`      ${s.prompt}`);
  }
  console.log('-----------------------------------------------------------');
  console.log(`\nProject:      ${project.id}`);
  console.log(`Photos in:    ${project.assets.length}   ->   Shots used: ${project.shots.length}`);
  console.log(`Target:       ${project.targetDurationSec}s   ->   Rendered: ~${render.totalDurationSec}s`);
  console.log(`Output:       ${render.outputPath}`);
  console.log(`Render plan:  ${render.planPath}`);
  console.log(`State:        projects/${project.id}/project.json  (stage=${project.stage})\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

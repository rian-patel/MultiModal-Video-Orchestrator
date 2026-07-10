// Resume a real project from its videogen checkpoint, regenerating only the
// clips it's missing (Phase 7 resume keeps clips already on disk). Used to
// complete a tour after a transient per-shot failure. Spends ~1 clip per
// missing shot. Usage: tsx scripts/resume-real.ts <projectId>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, defaultConfig } from '@rev/core';
import type { Project } from '@rev/core';
import { HiggsfieldVideoGenEngine } from '@rev/engine-videogen';
import { resumePipeline } from '@rev/orchestrator';

try {
  process.loadEnvFile('.env');
} catch {
  /* checked below */
}

const projectId = process.argv[2];
if (!projectId) throw new Error('usage: tsx scripts/resume-real.ts <projectId>');
if (!process.env.HIGGSFIELD_API_KEY) throw new Error('HIGGSFIELD_API_KEY not set in .env');

async function main() {
  const workDir = join(defaultConfig.projectsDir, projectId!);
  const jsonPath = join(workDir, 'project.json');
  const project = JSON.parse(await readFile(jsonPath, 'utf8')) as Project;

  const missing = project.shots.filter((s) => s.status !== 'done' || !s.clipPath);
  if (missing.length === 0) {
    console.log('Nothing to regenerate — every shot already has a clip.');
    return;
  }
  console.log(`Resuming ${projectId}: ${missing.length} missing clip(s) to regenerate`);
  console.log(`  ${missing.map((s) => `#${s.order} ${s.roomType}`).join(', ')}`);

  // Reopen the videogen checkpoint so resume re-enters at that stage. Resume
  // keeps the shots whose clip file still exists; only the rest are generated.
  if (project.stage === 'complete') {
    project.stage = 'generating';
    delete project.lastError;
    await writeFile(jsonPath, JSON.stringify(project, null, 2), 'utf8');
  }

  const logger = createLogger('resume-real');
  const { project: done, render } = await resumePipeline({
    projectId: projectId!,
    engines: {
      // Default retry is now credit-safe (poll timeouts don't resubmit), so a
      // transient pre-submit error like the earlier 502 gets a free retry.
      videogen: new HiggsfieldVideoGenEngine({ maxPollMs: 25 * 60_000, pollIntervalMs: 10_000 }),
    },
    onProgress: (pct, stage, msg) => logger.info(`[${String(pct).padStart(3)}%] ${stage.padEnd(11)} ${msg}`),
  });
  if (!render) throw new Error('no render result');

  const ok = done.shots.filter((s) => s.status === 'done').length;
  console.log('\n===== DONE =====');
  console.log(`clips: ${ok}/${done.shots.length}`);
  console.log(`output: ${render.outputPath}  (~${render.totalDurationSec}s)`);
}

main().catch((err) => {
  console.error('\nRESUME FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

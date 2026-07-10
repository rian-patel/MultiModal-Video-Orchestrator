import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Project } from '@rev/core';

/** Create the per-project working subdirectories. */
export async function ensureProjectDirs(workDir: string): Promise<void> {
  for (const sub of ['source', 'clips', 'output']) {
    await mkdir(`${workDir}/${sub}`, { recursive: true });
  }
}

/**
 * Persist the whole Project after each stage so a run is resumable and
 * inspectable. Phase 0 uses a JSON file; swap for SQLite later behind this API.
 */
export async function saveProject(workDir: string, project: Project): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await writeFile(`${workDir}/project.json`, JSON.stringify(project, null, 2), 'utf8');
}

/** Load a persisted Project. Rejects if the project doesn't exist. */
export async function loadProject(workDir: string): Promise<Project> {
  const raw = await readFile(`${workDir}/project.json`, 'utf8');
  return JSON.parse(raw) as Project;
}

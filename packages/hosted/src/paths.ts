import { basename, join } from 'node:path';
import type { Project } from '@rev/core';

/**
 * A persisted Project carries absolute paths from the machine that ran it.
 * Hosted workers use a fresh scratch dir per run, so on hydrate every path is
 * rebased onto the new workDir. The per-project layout is stable
 * (source/ thumbs/ clips/ branding/ output/), which makes rebasing a pure
 * basename remap. Returns a new Project; the input is not mutated.
 */
export function rebaseProjectPaths(project: Project, workDir: string): Project {
  const to = (sub: string, p?: string) => (p ? join(workDir, sub, basename(p)) : undefined);
  return {
    ...project,
    assets: project.assets.map((a) => ({
      ...a,
      sourcePath: to('source', a.sourcePath) as string,
      thumbPath: to('thumbs', a.thumbPath),
    })),
    shots: project.shots.map((s) => ({ ...s, clipPath: to('clips', s.clipPath) })),
    branding: project.branding
      ? { ...project.branding, logoPath: to('branding', project.branding.logoPath) }
      : undefined,
    outputPath: to('output', project.outputPath),
    verticalPath: to('output', project.verticalPath),
  };
}

/** Storage key for a project artifact: `<userId>/<projectId>/<sub>/<file>`. */
export function artifactKey(userId: string, projectId: string, localPath: string, sub: string): string {
  return `${userId}/${projectId}/${sub}/${basename(localPath)}`;
}

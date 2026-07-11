import { access } from 'node:fs/promises';
import type { Project } from '@rev/core';
import type { SupabaseBlobStore } from './blobStore';
import { artifactKey } from './paths';

interface ArtifactRef {
  local: string;
  sub: 'source' | 'thumbs' | 'clips' | 'branding' | 'output';
  /** Required by the pipeline on resume (missing = real error), vs nice-to-have. */
  essential: boolean;
}

/** Every artifact a project currently references, with its storage subdir. */
function artifacts(project: Project): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const a of project.assets) {
    refs.push({ local: a.sourcePath, sub: 'source', essential: true });
    if (a.thumbPath) refs.push({ local: a.thumbPath, sub: 'thumbs', essential: false });
  }
  for (const s of project.shots) {
    if (s.status === 'done' && s.clipPath) refs.push({ local: s.clipPath, sub: 'clips', essential: true });
  }
  if (project.branding?.logoPath) {
    refs.push({ local: project.branding.logoPath, sub: 'branding', essential: true });
  }
  if (project.outputPath) refs.push({ local: project.outputPath, sub: 'output', essential: false });
  if (project.verticalPath) refs.push({ local: project.verticalPath, sub: 'output', essential: false });
  return refs;
}

/**
 * Moves project artifacts between the worker's scratch disk and the storage
 * bucket. `push` runs at every checkpoint (uploads whatever is new; an
 * already-uploaded or not-yet-existing file is skipped, so it is cheap to
 * call repeatedly). `pull` runs once on hydrate before a resume (downloads
 * what the pipeline needs: sources, kept clips, the logo).
 */
export class ArtifactSync {
  private pushed = new Set<string>();

  constructor(
    private blob: SupabaseBlobStore,
    private userId: string,
  ) {}

  async push(project: Project): Promise<void> {
    for (const ref of artifacts(project)) {
      const key = artifactKey(this.userId, project.id, ref.local, ref.sub);
      if (this.pushed.has(key)) continue;
      if (!(await exists(ref.local))) continue; // stage hasn't produced it yet
      await this.blob.uploadFile(key, ref.local);
      this.pushed.add(key);
    }
  }

  async pull(project: Project): Promise<void> {
    for (const ref of artifacts(project)) {
      if (ref.sub === 'output' || ref.sub === 'thumbs') continue; // outputs are re-rendered; thumbs unused by the pipeline
      if (await exists(ref.local)) continue;
      const key = artifactKey(this.userId, project.id, ref.local, ref.sub);
      try {
        await this.blob.downloadToFile(key, ref.local);
        this.pushed.add(key); // it's in storage already; don't re-upload
      } catch (err) {
        if (ref.essential) throw err;
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

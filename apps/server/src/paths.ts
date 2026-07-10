import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file's location (apps/server/src -> root)
// so the server writes to <root>/projects regardless of the cwd it was
// started from.
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const PROJECTS_DIR = join(REPO_ROOT, 'projects');

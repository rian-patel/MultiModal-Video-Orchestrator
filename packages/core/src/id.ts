import { randomUUID } from 'node:crypto';

/** Short, human-scannable id, e.g. proj_1a2b3c4d. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

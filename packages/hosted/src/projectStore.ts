import type { Project } from '@rev/core';
import type { SupabaseLike } from './types';

/**
 * Mirrors the pipeline's Project checkpoints into a Postgres `projects` table
 * and loads them back for resume. The whole Project document is stored as
 * JSONB (`data`) with a few promoted columns for querying and RLS; the JSON
 * stays the source of truth for the pipeline, exactly like project.json does
 * locally, so resume semantics carry over unchanged.
 */
export class SupabaseProjectStore {
  constructor(
    private client: SupabaseLike,
    private table = 'projects',
  ) {}

  /** Insert-or-update the project row at a checkpoint. */
  async upsert(project: Project, userId: string): Promise<void> {
    const { error } = await this.client.from(this.table).upsert({
      id: project.id,
      user_id: userId,
      stage: project.stage,
      target_duration_sec: project.targetDurationSec,
      last_error: project.lastError ?? null,
      data: project,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`project upsert failed: ${error.message}`);
  }

  /** Load a project document (null if the row doesn't exist). */
  async load(projectId: string): Promise<{ project: Project; userId: string } | null> {
    const { data, error } = await this.client
      .from(this.table)
      .select('data, user_id')
      .eq('id', projectId)
      .maybeSingle();
    if (error) throw new Error(`project load failed: ${error.message}`);
    if (!data) return null;
    return { project: data.data as Project, userId: data.user_id as string };
  }
}

import type { SupabaseLike } from './types';

/**
 * The worker's end of the run ledger: the edge functions reserve an 'active'
 * row (which the per-user caps count against), and the worker marks it
 * terminal when the pipeline finishes. A stale 'active' row (crashed worker)
 * ages out via the gate's staleHours window, so a missed update never wedges
 * a user permanently.
 */
export class SupabaseRunLedger {
  constructor(
    private client: SupabaseLike,
    private table = 'runs',
  ) {}

  async finish(runId: string, status: 'complete' | 'error', projectId?: string): Promise<void> {
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (projectId) patch.project_id = projectId;
    const { error } = await this.client.from(this.table).update(patch).eq('id', runId);
    if (error) throw new Error(`run ledger update failed: ${error.message}`);
  }
}

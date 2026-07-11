import type { CompleteEventData, ErrorEventData, ProgressEventData } from '@rev/core';
import type { SupabaseLike } from './types';

/** One row per SSE-equivalent event; the browser replays + subscribes. */
export type HostedRunEvent =
  | { type: 'progress'; data: ProgressEventData }
  | { type: 'complete'; data: CompleteEventData }
  | { type: 'run-error'; data: ErrorEventData };

/**
 * The hosted replacement for the in-memory RunRegistry: the worker inserts
 * one row per event into `run_events`; the browser selects existing rows
 * (replay, same recovery property the SSE buffer gives today) and subscribes
 * to inserts via Supabase Realtime for the live tail.
 */
export class SupabaseProgressSink {
  constructor(
    private client: SupabaseLike,
    private table = 'run_events',
  ) {}

  async emit(
    ids: { runId: string; projectId: string; userId: string },
    event: HostedRunEvent,
  ): Promise<void> {
    const { error } = await this.client.from(this.table).insert({
      run_id: ids.runId,
      project_id: ids.projectId,
      user_id: ids.userId,
      type: event.type,
      data: event.data,
    });
    if (error) throw new Error(`run event insert failed: ${error.message}`);
  }

  /** Progress emits are fire-and-forget: a dropped progress row must never
   * fail the pipeline. Terminal events (complete/run-error) should use
   * emit() and be awaited so the run always ends with a visible outcome. */
  emitSoft(ids: { runId: string; projectId: string; userId: string }, event: HostedRunEvent): void {
    void this.emit(ids, event).catch(() => {});
  }
}

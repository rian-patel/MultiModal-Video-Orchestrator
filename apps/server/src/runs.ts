import { newId } from '@rev/core';
import type {
  CompleteEventData,
  ErrorEventData,
  ProgressEventData,
  RunStatus,
} from '@rev/core';

export type RunEvent =
  | { type: 'progress'; data: ProgressEventData }
  | { type: 'complete'; data: CompleteEventData }
  | { type: 'error'; data: ErrorEventData };

export interface Run {
  id: string;
  status: RunStatus;
  createdAt: string;
  projectId?: string;
  /** Replay buffer so late SSE subscribers see the full history. */
  events: RunEvent[];
  subscribers: Set<(e: RunEvent) => void>;
}

/**
 * In-memory registry of pipeline runs. One Run per "Generate" click; SSE
 * subscribers get the buffered history followed by live events. In-memory is
 * fine for a single-user local tool — the durable state lives in
 * projects/<id>/project.json either way.
 */
export class RunRegistry {
  private runs = new Map<string, Run>();

  create(): Run {
    const run: Run = {
      id: newId('run'),
      status: 'running',
      createdAt: new Date().toISOString(),
      events: [],
      subscribers: new Set(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  emit(id: string, event: RunEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.events.push(event);
    if (event.type === 'complete') run.status = 'complete';
    if (event.type === 'error') run.status = 'error';
    for (const fn of run.subscribers) fn(event);
  }

  /** Returns an unsubscribe function. */
  subscribe(id: string, fn: (e: RunEvent) => void): () => void {
    const run = this.runs.get(id);
    if (!run) return () => {};
    run.subscribers.add(fn);
    return () => run.subscribers.delete(fn);
  }
}

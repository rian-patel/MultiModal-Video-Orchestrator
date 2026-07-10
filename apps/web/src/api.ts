// Thin client for the rev-server API. Event payload types come from
// @rev/core so the wire format can't drift between front and back.
// NOTE: only `import type` from workspace packages here — some of their
// runtime code uses Node built-ins that don't exist in the browser.
import type {
  CompleteEventData,
  ErrorEventData,
  HealthData,
  ProgressEventData,
} from '@rev/core';

export interface RunHandlers {
  onProgress: (d: ProgressEventData) => void;
  onComplete: (d: CompleteEventData) => void;
  onError: (d: ErrorEventData) => void;
}

export async function checkHealth(): Promise<HealthData | null> {
  try {
    const res = await fetch('/api/health');
    return res.ok ? ((await res.json()) as HealthData) : null;
  } catch {
    return null;
  }
}

async function toRunId(res: Response): Promise<string> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  }
  const { runId } = (await res.json()) as { runId: string };
  return runId;
}

/**
 * Start a run. With files: multipart upload of the real photo bytes (the
 * server routes them through the real Upload Engine). Without: JSON demo mode
 * (mock engines, built-in demo set).
 */
export async function startRun(targetDurationSec: number, files?: File[]): Promise<string> {
  let res: Response;
  if (files && files.length > 0) {
    const form = new FormData();
    // Field order matters for streaming parsers: scalar fields first.
    form.append('targetDurationSec', String(targetDurationSec));
    for (const f of files) form.append('photos', f, f.name);
    res = await fetch('/api/runs', { method: 'POST', body: form });
  } else {
    res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDurationSec }),
    });
  }
  return toRunId(res);
}

/** Resume a failed run from its last persisted checkpoint. */
export async function resumeRun(projectId: string): Promise<string> {
  const res = await fetch(`/api/projects/${projectId}/resume`, { method: 'POST' });
  return toRunId(res);
}

/** Subscribe to a run's SSE stream. Returns a cleanup function. */
export function watchRun(runId: string, handlers: RunHandlers): () => void {
  const es = new EventSource(`/api/runs/${runId}/events`);

  es.addEventListener('progress', (e) => {
    handlers.onProgress(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener('complete', (e) => {
    handlers.onComplete(JSON.parse((e as MessageEvent).data));
    es.close();
  });
  // Server sends 'run-error' — plain 'error' is EventSource's own
  // network-error event, which auto-reconnects (and replays the buffer).
  es.addEventListener('run-error', (e) => {
    handlers.onError(JSON.parse((e as MessageEvent).data));
    es.close();
  });
  // When EventSource gives up entirely (e.g. the server restarted and the
  // in-memory run is gone -> 404), surface it instead of spinning forever.
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) {
      handlers.onError({
        message: 'Lost connection to the server. If it restarted mid-run, resume the last project.',
      });
    }
  });

  return () => es.close();
}

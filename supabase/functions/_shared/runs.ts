// Pure run-gate policy, shared by the start-run and resume-run edge functions
// and unit-tested from Node (no Deno/jsr imports here on purpose, so it runs
// in both runtimes). The DB counting lives in enqueue.ts (Deno-only).

export interface RunLimits {
  /** Concurrent runs per user. 1 keeps a user to one run at a time; the task's
   * global concurrencyLimit is the real execution guard, this is the UX cap. */
  maxActive: number;
  /** Runs a user can start per rolling 24h (owner's API spend is finite). */
  maxPerDay: number;
  /** An 'active' row older than this is treated as stale (crashed worker that
   * never marked itself terminal), so it doesn't wedge the user forever. */
  staleHours: number;
}

export const RUN_LIMITS: RunLimits = {
  maxActive: 1,
  maxPerDay: 20,
  staleHours: 2,
};

export interface RunGateInput {
  /** Non-stale active runs for this user. */
  activeCount: number;
  /** Runs this user started in the last 24h. */
  todayCount: number;
}

export type RunGate = { ok: true } | { ok: false; status: number; error: string };

/**
 * Decide whether a user may start another run. Active cap first (a run in
 * progress blocks a new one), then the daily cap. Returned status codes map
 * straight onto the HTTP response.
 */
export function evaluateRunGate(input: RunGateInput, limits = RUN_LIMITS): RunGate {
  if (input.activeCount >= limits.maxActive) {
    return {
      ok: false,
      status: 409,
      error: 'You already have a run in progress. Wait for it to finish before starting another.',
    };
  }
  if (input.todayCount >= limits.maxPerDay) {
    return {
      ok: false,
      status: 429,
      error: `Daily limit reached (${limits.maxPerDay} runs). Please try again tomorrow.`,
    };
  }
  return { ok: true };
}

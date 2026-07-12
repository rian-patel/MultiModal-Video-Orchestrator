// Deno-only run bookkeeping: service-role client, cap counting, run-row
// reserve/release, and the Trigger.dev task trigger. Kept out of the Node
// tsconfig (it imports jsr:); the pure policy it uses lives in runs.ts.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { evaluateRunGate, RUN_LIMITS, type RunGate } from './runs.ts';

/** Service-role client: bypasses RLS so the run ledger cannot be user-forged. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function newRunId(): string {
  return `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

/** Count this user's non-stale active runs + last-24h runs, then apply the gate. */
export async function gateRun(svc: SupabaseClient, userId: string): Promise<RunGate> {
  const staleCut = new Date(Date.now() - RUN_LIMITS.staleHours * 3_600_000).toISOString();
  const dayCut = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [active, today] = await Promise.all([
    svc
      .from('runs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active')
      .gt('created_at', staleCut),
    svc
      .from('runs')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gt('created_at', dayCut),
  ]);
  return evaluateRunGate({ activeCount: active.count ?? 0, todayCount: today.count ?? 0 });
}

/** Record an active run before triggering (so it counts against the caps). */
export async function reserveRun(
  svc: SupabaseClient,
  runId: string,
  userId: string,
  kind: 'fresh' | 'resume',
  projectId?: string,
): Promise<void> {
  const { error } = await svc.from('runs').insert({
    id: runId,
    user_id: userId,
    kind,
    project_id: projectId ?? null,
    status: 'active',
  });
  if (error) throw new Error(error.message);
}

/** Mark a reserved run errored (used when the trigger call itself fails). */
export async function releaseRun(svc: SupabaseClient, runId: string): Promise<void> {
  await svc.from('runs').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', runId);
}

/** Fire the generate-tour task. `options` carries concurrency/idempotency. */
export function triggerTask(payload: unknown, options: Record<string, unknown> = {}): Promise<Response> {
  return fetch(
    `${Deno.env.get('TRIGGER_API_URL') ?? 'https://api.trigger.dev'}/api/v1/tasks/generate-tour/trigger`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Deno.env.get('TRIGGER_SECRET_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload, options }),
    },
  );
}

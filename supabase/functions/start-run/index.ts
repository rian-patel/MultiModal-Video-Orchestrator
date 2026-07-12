// Edge function: validate a run request from the browser and enqueue the
// generate-tour task on Trigger.dev. Photos were already uploaded by the
// browser to the `photos` bucket under the caller's own folder (enforced by
// storage RLS); this function only ever passes storage paths around, never
// bytes. Runs in Deno on Supabase; deploy with `supabase functions deploy`.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { gateRun, newRunId, releaseRun, reserveRun, serviceClient, triggerTask } from '../_shared/enqueue.ts';

// Keep in sync with packages/engine-upload (MIN_PHOTOS/MAX_PHOTOS).
const MIN_PHOTOS = 10;
const MAX_PHOTOS = 40;

interface StartRunBody {
  targetDurationSec?: number;
  photos?: { path?: string; name?: string }[];
  branding?: {
    address?: string;
    agentName?: string;
    phone?: string;
    email?: string;
    logoPath?: string;
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // The caller's own JWT scopes this client; auth.getUser() verifies it.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'not signed in' }, 401);

  const body = (await req.json().catch(() => ({}))) as StartRunBody;
  const target = Number(body.targetDurationSec);
  if (target !== 30 && target !== 45 && target !== 60) {
    return json({ error: 'targetDurationSec must be 30, 45 or 60' }, 400);
  }
  const photos = (body.photos ?? []).filter(
    (p): p is { path: string; name: string } => typeof p?.path === 'string' && typeof p?.name === 'string',
  );
  if (photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) {
    return json({ error: `Expected ${MIN_PHOTOS}-${MAX_PHOTOS} photos, received ${photos.length}.` }, 400);
  }
  // Paths must live in the caller's own folder of the photos bucket.
  const ownPrefix = `${user.id}/`;
  const foreign = photos.find((p) => !p.path.startsWith(ownPrefix));
  if (foreign) return json({ error: 'photo paths must be your own uploads' }, 403);
  if (body.branding?.logoPath && !body.branding.logoPath.startsWith(ownPrefix)) {
    return json({ error: 'logo path must be your own upload' }, 403);
  }

  // Per-user spend caps (service role so the ledger cannot be user-forged).
  const svc = serviceClient();
  const gate = await gateRun(svc, user.id);
  if (!gate.ok) return json({ error: gate.error }, gate.status);

  const runId = newRunId();
  await reserveRun(svc, runId, user.id, 'fresh');

  // No concurrencyKey: the task's global concurrencyLimit:1 serializes ALL
  // runs so at most one run's 2 in-flight clips hit Higgsfield's 2-job plan
  // ceiling at a time. A per-user key would let N users run N*2 jobs at once.
  const trigger = await triggerTask({
    runId,
    userId: user.id,
    fresh: { targetDurationSec: target, photos, branding: body.branding },
  });
  if (!trigger.ok) {
    await releaseRun(svc, runId);
    const detail = (await trigger.text()).slice(0, 300);
    return json({ error: `could not enqueue the run: ${trigger.status} ${detail}` }, 502);
  }

  return json({ runId, photoCount: photos.length }, 202);
});

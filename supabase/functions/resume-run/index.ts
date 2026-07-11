// Edge function: resume a persisted project from its last checkpoint.
// Ownership is proven by selecting the row through the caller's own
// RLS-scoped client: if the select returns nothing, the project either does
// not exist or is not theirs, and the response is the same 404 either way.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'not signed in' }, 401);

  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId || !/^[\w-]+$/.test(projectId)) return json({ error: 'projectId required' }, 400);

  const { data: row } = await supabase
    .from('projects')
    .select('id, stage')
    .eq('id', projectId)
    .maybeSingle();
  if (!row) return json({ error: 'project not found' }, 404);
  if (row.stage === 'complete') return json({ error: 'Project is already complete.' }, 409);
  if (row.stage === 'created') {
    return json({ error: 'This project cannot be resumed — start a new run.' }, 409);
  }

  const runId = `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const trigger = await fetch(
    `${Deno.env.get('TRIGGER_API_URL') ?? 'https://api.trigger.dev'}/api/v1/tasks/generate-tour/trigger`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Deno.env.get('TRIGGER_SECRET_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        payload: { runId, userId: user.id, resume: { projectId } },
      }),
    },
  );
  if (!trigger.ok) {
    const detail = (await trigger.text()).slice(0, 300);
    return json({ error: `could not enqueue the resume: ${trigger.status} ${detail}` }, 502);
  }

  return json({ runId, projectId, resumeFrom: row.stage }, 202);
});

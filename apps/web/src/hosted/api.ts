// Hosted implementations of the api.ts surface: same function names and
// shapes, but photos go straight to Supabase Storage, runs are enqueued via
// edge functions, and progress arrives over Realtime instead of SSE.
import type {
  CompleteEventData,
  HealthData,
  ReviewEventData,
} from '@rev/core';
import type { BrandingInput, RunHandlers } from '../api';
import { supabase } from './client';

/** The hosted worker always runs the real engines (its keys, not the user's). */
export async function checkHealth(): Promise<HealthData | null> {
  const { data } = await supabase().auth.getSession();
  if (!data.session) return null;
  return {
    ok: true,
    service: 'rev-hosted',
    engines: { vision: 'claude', videogen: 'higgsfield', fidelity: 'claude' },
  };
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().functions.invoke(fn, { body });
  if (error) {
    // FunctionsHttpError carries the response; surface the server's message.
    const ctx = (error as { context?: Response }).context;
    const detail = ctx ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(detail?.error ?? error.message ?? `${fn} failed`);
  }
  return data as T;
}

export async function startRun(
  targetDurationSec: number,
  files?: File[],
  _review = false, // storyboard review is not available hosted yet
  branding?: BrandingInput,
): Promise<string> {
  if (!files || files.length === 0) {
    throw new Error('Hosted mode needs real photos — drop in 10-40 images.');
  }
  const { data: auth } = await supabase().auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error('Sign in first.');

  // Upload straight to the photos bucket under this user's folder (storage
  // RLS only allows their own prefix), then hand paths to the edge function.
  const batch = crypto.randomUUID().slice(0, 8);
  const storage = supabase().storage.from('photos');
  const photos: { path: string; name: string }[] = [];
  for (const [i, file] of files.entries()) {
    const safe = file.name.replace(/[^\w.\- ]/g, '_');
    const path = `${uid}/${batch}/${i}-${safe}`;
    const { error } = await storage.upload(path, file, { upsert: true });
    if (error) throw new Error(`photo upload failed: ${error.message}`);
    photos.push({ path, name: file.name });
  }

  let logoPath: string | undefined;
  if (branding?.logo) {
    const safe = branding.logo.name.replace(/[^\w.\- ]/g, '_');
    logoPath = `${uid}/${batch}/logo-${safe}`;
    const { error } = await storage.upload(logoPath, branding.logo, { upsert: true });
    if (error) throw new Error(`logo upload failed: ${error.message}`);
  }

  const res = await invoke<{ runId: string }>('start-run', {
    targetDurationSec,
    photos,
    branding: branding
      ? {
          address: branding.address?.trim() || undefined,
          agentName: branding.agentName?.trim() || undefined,
          phone: branding.phone?.trim() || undefined,
          email: branding.email?.trim() || undefined,
          logoPath,
        }
      : undefined,
  });
  return res.runId;
}

export async function resumeRun(projectId: string): Promise<string> {
  const res = await invoke<{ runId: string }>('resume-run', { projectId });
  return res.runId;
}

export async function patchStoryboard(
  _projectId: string,
  _assetIds: string[],
): Promise<ReviewEventData> {
  throw new Error('Storyboard review is not available in hosted mode yet.');
}

/** storage://<bucket>/<path> -> a short-lived signed URL for this user. */
async function resolveStorageUrl(url: string): Promise<string> {
  const m = /^storage:\/\/([^/]+)\/(.+)$/.exec(url);
  if (!m) return url;
  const { data, error } = await supabase().storage.from(m[1]).createSignedUrl(m[2], 3600);
  if (error || !data) throw new Error(`could not sign ${m[2]}: ${error?.message ?? 'no data'}`);
  return data.signedUrl;
}

/**
 * Replay + live tail of run_events, mapped onto the same handlers the SSE
 * client uses. Subscribe first, then select the backlog, and dedupe on row
 * id so the overlap window can't double-fire.
 */
export function watchRun(runId: string, handlers: RunHandlers): () => void {
  const sb = supabase();
  const seen = new Set<number>();
  let done = false;

  const deliver = async (row: { id: number; type: string; data: unknown }) => {
    if (done || seen.has(row.id)) return;
    seen.add(row.id);
    if (row.type === 'progress') {
      handlers.onProgress(row.data as Parameters<RunHandlers['onProgress']>[0]);
    } else if (row.type === 'complete') {
      done = true;
      const data = { ...(row.data as CompleteEventData) };
      data.videoUrl = await resolveStorageUrl(data.videoUrl);
      if (data.verticalUrl) data.verticalUrl = await resolveStorageUrl(data.verticalUrl);
      handlers.onComplete(data);
      cleanup();
    } else if (row.type === 'run-error') {
      done = true;
      handlers.onError(row.data as Parameters<RunHandlers['onError']>[0]);
      cleanup();
    }
  };

  const channel = sb
    .channel(`run-${runId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'run_events', filter: `run_id=eq.${runId}` },
      (payload) => void deliver(payload.new as { id: number; type: string; data: unknown }),
    )
    .subscribe();

  // Replay the backlog after subscribing (late watchers recover everything,
  // matching the SSE replay buffer's behavior).
  void sb
    .from('run_events')
    .select('id, type, data')
    .eq('run_id', runId)
    .order('id', { ascending: true })
    .then(async ({ data }) => {
      for (const row of data ?? []) await deliver(row as { id: number; type: string; data: unknown });
    });

  const cleanup = () => void sb.removeChannel(channel);
  return cleanup;
}

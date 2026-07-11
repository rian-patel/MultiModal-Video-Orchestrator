import { createClient } from '@supabase/supabase-js';
import type { SupabaseLike } from './types';

/**
 * The worker's Supabase client: service-role key, so it bypasses RLS (the
 * worker is trusted; row ownership is enforced at the edge-function boundary
 * where user requests enter). Throws early with a precise message when the
 * env is incomplete, because a worker without its backing store must not
 * accept jobs.
 */
export function createServiceClient(env: NodeJS.ProcessEnv = process.env): SupabaseLike {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for hosted mode');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseLike;
}

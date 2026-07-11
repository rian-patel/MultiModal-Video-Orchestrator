import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Hosted mode switches on entirely via env: a build with VITE_SUPABASE_URL +
// VITE_SUPABASE_ANON_KEY talks to Supabase (auth, storage, realtime, edge
// functions); a build without them is the unchanged local-first app talking
// to the Fastify server on /api.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const hostedMode = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

/** The browser Supabase client (only call when hostedMode is true). */
export function supabase(): SupabaseClient {
  if (!url || !anonKey) throw new Error('hosted mode is not configured');
  client ??= createClient(url, anonKey);
  return client;
}

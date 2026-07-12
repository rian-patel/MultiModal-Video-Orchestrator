-- P0 hardening (audit 2026-07-11): per-user spend caps + storage limits.
-- Depends on 0001_init.sql (projects, run_events, buckets).

-- ------------------------------------------------------------------- runs
-- One row per enqueued run, written by the edge functions via the service
-- role (users can only SELECT their own; no user INSERT/UPDATE policy, so the
-- ledger cannot be forged to bypass the caps). The worker marks a run
-- terminal (complete/error) when it finishes.
create table public.runs (
  id text primary key,                       -- run_xxxxxxxx
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text,                           -- set by the worker once known
  kind text not null check (kind in ('fresh', 'resume')),
  status text not null default 'active' check (status in ('active', 'complete', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Serves both cap queries: active count (status + recency) and daily count.
create index runs_user_status_created_idx on public.runs (user_id, status, created_at desc);

alter table public.runs enable row level security;

create policy "owners read own runs"
  on public.runs for select
  using (auth.uid() = user_id);

-- --------------------------------------------------------- storage limits
-- P0-4: cap raw photo uploads at 30 MB (matches the local multipart limit)
-- and constrain them to real image types. The projects bucket is
-- service-role-write only (finished videos), so it keeps no size limit.
update storage.buckets
set file_size_limit = 31457280,               -- 30 MB
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'photos';

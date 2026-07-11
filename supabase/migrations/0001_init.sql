-- Hosted mode schema (H1 alpha). Apply with: supabase db push
-- Model: the Project JSON document stays the pipeline's source of truth
-- (JSONB `data`), with promoted columns for querying and RLS. run_events is
-- the hosted replacement for the in-memory SSE registry: one row per event,
-- replayed by SELECT and tailed via Realtime.

-- ---------------------------------------------------------------- projects
create table public.projects (
  id text primary key,                       -- proj_xxxxxxxx (app-generated)
  user_id uuid not null references auth.users (id) on delete cascade,
  stage text not null default 'created',
  target_duration_sec int not null,
  last_error text,
  data jsonb not null,                       -- the full Project document
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_user_idx on public.projects (user_id, created_at desc);

alter table public.projects enable row level security;

-- Owners read their own projects; all writes go through the service role
-- (edge functions + worker), which bypasses RLS.
create policy "owners read own projects"
  on public.projects for select
  using (auth.uid() = user_id);

-- -------------------------------------------------------------- run_events
create table public.run_events (
  id bigint generated always as identity primary key,
  run_id text not null,                      -- run_xxxxxxxx (app-generated)
  project_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('progress', 'review', 'complete', 'run-error')),
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index run_events_run_idx on public.run_events (run_id, id);

alter table public.run_events enable row level security;

create policy "owners read own run events"
  on public.run_events for select
  using (auth.uid() = user_id);

-- Realtime: the browser subscribes to INSERTs on run_events for live progress.
alter publication supabase_realtime add table public.run_events;

-- ---------------------------------------------------------------- storage
-- photos: raw browser uploads, keyed uploads/<user_id>/... (pre-project)
-- projects: pipeline artifacts, keyed <user_id>/<project_id>/<sub>/<file>
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false), ('projects', 'projects', false)
on conflict (id) do nothing;

-- Users upload raw photos only into their own folder.
create policy "users upload own photos"
  on storage.objects for insert
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "users read own photos"
  on storage.objects for select
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Users read their own project artifacts (finished videos, thumbnails).
-- Writes come only from the worker via service role.
create policy "users read own project artifacts"
  on storage.objects for select
  using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);

-- Invite-only alpha: disable public signups in Dashboard -> Auth -> Providers
-- (Email: turn off "Allow new users to sign up"), then invite testers from
-- Dashboard -> Auth -> Users -> Invite. No schema needed for that.

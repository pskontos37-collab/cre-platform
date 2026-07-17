-- 20240111_abstract_jobs.sql
-- Background-job tracking for the abstract review surface. A reviewer can upload
-- a document (or ask for a re-run) and keep working elsewhere in the app; the
-- client-orchestrated pipeline (extract text -> brief -> synthesize -> verify)
-- writes its progress here, and a global toaster polls this table to show
-- progress and a completion alert app-wide.
--
-- This is deliberately a STATUS ledger, not a server-side queue: the pipeline is
-- driven from the browser (see AbstractsPage.uploadAndReabstract), so a job
-- survives navigation within the SPA but not a full tab close. A future
-- cron/pg_net worker (cf. uw-extract) could take ownership of running rows
-- without changing this schema.

create table if not exists public.abstract_jobs (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid references public.properties(id) on delete cascade,
  tenant_name  text not null,
  kind         text not null default 'upload_reabstract'
                 check (kind in ('upload_reabstract', 'reabstract')),
  status       text not null default 'running'
                 check (status in ('running', 'done', 'error')),
  phase        text,                                              -- human-readable current step
  document_id  uuid references public.documents(id) on delete set null,
  file_name    text,
  error        text,
  seen         boolean not null default false,                    -- toaster dismissed the completion notice
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The toaster's hot query: this user's running jobs + not-yet-acknowledged finishes.
create index if not exists abstract_jobs_creator_idx
  on public.abstract_jobs (created_by, updated_at desc);
create index if not exists abstract_jobs_active_idx
  on public.abstract_jobs (created_by)
  where status = 'running' or seen = false;

alter table public.abstract_jobs enable row level security;

-- Abstracts are an admin / asset-manager surface (AbstractsPage gates the route
-- to those roles); jobs follow the same posture.
create policy "abstract_jobs_select" on public.abstract_jobs
  for select using (public.is_admin_or_am());
create policy "abstract_jobs_insert" on public.abstract_jobs
  for insert with check (public.is_admin_or_am());
create policy "abstract_jobs_update" on public.abstract_jobs
  for update using (public.is_admin_or_am());
create policy "abstract_jobs_delete" on public.abstract_jobs
  for delete using (public.is_admin_or_am());

-- Anon-role posture (cf. migration 20240098): the anon key ships in the browser
-- bundle and holds zero write privileges. Writes come from authenticated staff
-- (gated by the RLS policies above) or service_role edge functions.
revoke all on public.abstract_jobs from anon;
grant select, insert, update, delete on public.abstract_jobs to authenticated;

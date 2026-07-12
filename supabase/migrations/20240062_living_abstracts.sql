-- 20240062_living_abstracts.sql
-- Tier-2 abstractor enhancements (three features, one migration):
--
-- 1. LIVING ABSTRACTS — abstract_refresh_log records every automatic refresh
--    triggered by a newly-ingested document that matches an abstracted tenant
--    (runner: scripts/refresh_abstracts.ps1, chained after the nightly doc sync).
--    `changes` holds a field -> {old,new} diff of the high-value fields so the
--    AbstractsPage banner can show exactly what moved; locked abstracts are never
--    regenerated (action='locked_needs_review' instead).
--
-- 2. LEASE CRITICAL DATES — sync_lease_critical_dates() materializes option
--    notice deadlines (lease_options, MRI system-of-record) and lease expirations
--    into critical_dates, which the dashboard widget already reads. Idempotent
--    via the new auto_source column (auto rows replaced wholesale each run;
--    manual rows untouched). Re-run after every rent-roll load.
--
-- 3. MRI RECONCILIATION WORKFLOW — mri_recon_status turns v_mri_reconciliation
--    (migration 20240060) from a report into a managed queue: status, assignee,
--    resolution note per (property, tenant, field).

-- ── 1. abstract refresh log ──
create table if not exists public.abstract_refresh_log (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  tenant_name  text not null,
  document_id  uuid,
  doc_title    text,
  action       text not null,              -- regenerated | locked_needs_review | regen_failed
  qa_status    text,                       -- verdict after the refresh (when regenerated)
  changes      jsonb,                      -- { "term.expiration": {"old":"...","new":"..."}, ... }
  material     boolean not null default false,
  seen         boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.abstract_refresh_log enable row level security;
create policy "arl_select" on public.abstract_refresh_log for select using (public.can_access_property(property_id));
create policy "arl_write"  on public.abstract_refresh_log for all    using (public.is_admin_or_am());
grant select, insert, update on public.abstract_refresh_log to authenticated;

-- ── 2. lease critical-dates sync ──
alter table public.critical_dates add column if not exists auto_source text;  -- null = manually entered

create or replace function public.sync_lease_critical_dates()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.critical_dates where auto_source = 'lease_model';

  insert into public.critical_dates (property_id, lease_id, date_type, due_date, description, auto_source)
  select l.property_id, l.id, 'option_notice_deadline'::critical_date_type, o.notice_deadline,
         coalesce(t.trade_name, t.name) || ' — ' || o.option_type || ' option notice'
           || case when o.notice_days_required is not null then ' (' || o.notice_days_required || ' days required)' else '' end,
         'lease_model'
  from public.lease_options o
  join public.leases l on l.id = o.lease_id
  join public.tenants t on t.id = l.tenant_id
  where o.is_exercised = false
    and o.notice_deadline is not null
    and o.notice_deadline >= current_date - 30;      -- keep the just-missed visible

  insert into public.critical_dates (property_id, lease_id, date_type, due_date, description, auto_source)
  select l.property_id, l.id, 'lease_expiration'::critical_date_type, l.expiration_date,
         coalesce(t.trade_name, t.name) || ' — lease expiration',
         'lease_model'
  from public.leases l
  join public.tenants t on t.id = l.tenant_id
  where l.status = 'active'
    and l.expiration_date is not null
    and l.expiration_date between current_date and current_date + interval '3 years';

  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.sync_lease_critical_dates() from public, anon;
grant execute on function public.sync_lease_critical_dates() to authenticated, service_role;

-- ── 3. MRI reconciliation workflow ──
create table if not exists public.mri_recon_status (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  tenant_name  text not null,
  field        text not null,
  status       text not null default 'open',   -- open | in_progress | resolved | not_an_issue
  assigned_to  uuid references public.users(id),
  note         text,
  updated_by   uuid references public.users(id),
  updated_at   timestamptz not null default now(),
  unique (property_id, tenant_name, field)
);
alter table public.mri_recon_status enable row level security;
create policy "mrs_select" on public.mri_recon_status for select using (public.can_access_property(property_id));
create policy "mrs_write"  on public.mri_recon_status for all    using (public.is_admin_or_am());
grant select, insert, update, delete on public.mri_recon_status to authenticated;

-- 20240086_critical_dates_workflow.sql
-- Critical-dates resolution workflow, take 2 (supersedes the single generic
-- dropdown from 20240029). Three things:
--
-- 1. STATUS VOCABULARY — the resolution status is now contextual to the date
--    type. Expanded check constraint covers every per-type choice:
--      option_notice_deadline : exercised | lapsed  | waived
--      lease_expiration       : renewed   | moved_out
--      other                  : completed | approved | ignored | waived
--      rent_commencement / free_rent_end / escalation : completed
--      loan_maturity          : ok
--      tax_appeal_deadline    : completed | in_progress  (in_progress stays OPEN)
--      inspection_due         : ok        | waived
--    'received' is kept for back-compat with rows written under 20240029.
--
-- 2. REASON CAPTURE — resolution_note holds the required reason for
--    ignored / waived resolutions.
--
-- 3. LANDLORD REMINDER PROVISION — some leases oblige the LANDLORD to remind
--    the tenant that an option-exercise window is opening before the tenant's
--    silence can count as a waiver. requires_landlord_reminder is the durable
--    flag on lease_options (populated by scripts/extract_landlord_reminder_provisions.ps1);
--    it is mirrored onto the option_notice_deadline critical_dates row so the
--    dashboard can badge "prepare tenant notice" without a join.
--
-- Also fixes a latent bug in sync_lease_critical_dates(): it used to delete and
-- recreate ALL auto rows wholesale, which resurrected any lease_expiration a
-- manager had already resolved (renewed / moved out). It now regenerates only
-- OPEN, unresolved auto rows and carries the reminder flag forward.

-- ── 1. new columns ──
alter table public.critical_dates
  add column if not exists resolution_note text,
  add column if not exists requires_landlord_reminder boolean not null default false;

alter table public.lease_options
  add column if not exists requires_landlord_reminder boolean not null default false,
  add column if not exists landlord_reminder_note text;

-- ── 2. expanded status vocabulary ──
alter table public.critical_dates drop constraint if exists critical_dates_status_check;
alter table public.critical_dates add constraint critical_dates_status_check
  check (status in (
    'open', 'in_progress',
    'completed', 'approved', 'ignored', 'waived', 'ok',
    'exercised', 'lapsed', 'received',
    'renewed', 'moved_out'
  ));

-- ── 3. regenerator: preserve resolutions, carry the reminder flag ──
create or replace function public.sync_lease_critical_dates()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  -- Only regenerate rows that are still OPEN. Resolved / in-progress auto rows
  -- are left alone so the nightly sync never resurrects a closed date.
  delete from public.critical_dates
   where auto_source = 'lease_model'
     and is_completed = false
     and coalesce(status, 'open') = 'open';

  -- option notice deadlines (skip leases that still carry a live/resolved auto row)
  insert into public.critical_dates
    (property_id, lease_id, date_type, due_date, description, requires_landlord_reminder, auto_source)
  select l.property_id, l.id, 'option_notice_deadline'::critical_date_type, o.notice_deadline,
         coalesce(t.trade_name, t.name) || ' — ' || o.option_type || ' option notice'
           || case when o.notice_days_required is not null then ' (' || o.notice_days_required || ' days required)' else '' end,
         coalesce(o.requires_landlord_reminder, false),
         'lease_model'
  from public.lease_options o
  join public.leases l on l.id = o.lease_id
  join public.tenants t on t.id = l.tenant_id
  where o.is_exercised = false
    and o.notice_deadline is not null
    and o.notice_deadline >= current_date - 30      -- keep the just-missed visible
    and not exists (
      select 1 from public.critical_dates c
       where c.lease_id = l.id
         and c.date_type = 'option_notice_deadline'
         and c.auto_source = 'lease_model'
    );

  -- lease expirations
  insert into public.critical_dates
    (property_id, lease_id, date_type, due_date, description, auto_source)
  select l.property_id, l.id, 'lease_expiration'::critical_date_type, l.expiration_date,
         coalesce(t.trade_name, t.name) || ' — lease expiration',
         'lease_model'
  from public.leases l
  join public.tenants t on t.id = l.tenant_id
  where l.status = 'active'
    and l.expiration_date is not null
    and l.expiration_date between current_date and current_date + interval '3 years'
    and not exists (
      select 1 from public.critical_dates c
       where c.lease_id = l.id
         and c.date_type = 'lease_expiration'
         and c.auto_source = 'lease_model'
    );

  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.sync_lease_critical_dates() from public, anon;
grant execute on function public.sync_lease_critical_dates() to authenticated, service_role;

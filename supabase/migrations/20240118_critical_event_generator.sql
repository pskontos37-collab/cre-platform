-- 20240118_critical_event_generator.sql
-- PHASE 1 (P1d-b) — DETERMINISTIC generator that materializes the critical_events
-- ledger (migration 20240117) from the current lease + option data.
--
-- It computes dates by CODE, never by an AI model, and is idempotent: re-running
-- UPSERTs on dedupe_key rather than duplicating (the exact bug critical_dates had
-- with its lease+type+source dedup). A human resolution (completed/waived/
-- not_applicable) is never clobbered by a re-run.
--
-- The option-notice formula is `current-term expiration - notice_days`, IDENTICAL
-- to src/lib/leaseMath.optionNoticeDeadline, which is golden-tested:
-- 2031-07-31 - 270 = 2030-11-03 (Starbucks). Postgres `date - integer` is a date,
-- so the SQL and the TS produce the same calendar day by construction. The stored
-- MRI notice_deadline is carried as a cross-check (reconciliation_status), never
-- silently trusted.
--
-- Scope note: this generates ONLY what the structured data supports —
-- lease_expiration (from leases.expiration_date, the current post-exercise term)
-- and per-option events. Options that are not present as rows (e.g. Starbucks'
-- three remaining options) cannot produce notice events until they are populated
-- in lease_options (a RETAILRR/abstraction step). Loans, management agreements,
-- and recurring obligations are later generators.

create or replace function public.generate_critical_events_for_lease(p_lease_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_lease  record;
  v_opt    record;
  v_count  integer := 0;
  v_computed date;
begin
  select l.id, l.property_id, l.expiration_date, l.status, t.name as tenant
    into v_lease
  from public.leases l join public.tenants t on t.id = l.tenant_id
  where l.id = p_lease_id;
  if not found then return 0; end if;

  -- 1. Current lease-term expiration — from leases.expiration_date, which already
  --    reflects any exercised option (Starbucks = 2031-07-31, NOT the stale
  --    2026-07-31 that lives in the legacy critical_dates store).
  if v_lease.expiration_date is not null then
    insert into public.critical_events (
      property_id, lease_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version,
      status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, 'lease_expiration', 'legal',
      format('Lease expiration — %s', v_lease.tenant),
      'Current lease-term expiration (reflects any exercised option).',
      v_lease.expiration_date, 'current lease term',
      'leases.expiration_date (current term)', 'sql-generator@2026-07-19',
      'open', 'deterministic', format('lease:%s:expiration', v_lease.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date       = excluded.computed_date,
      formula             = excluded.formula,
      computation_version = excluded.computation_version,
      updated_at          = now(),
      -- never overwrite a human's resolution on a re-run
      status = case when public.critical_events.status in ('completed','waived','not_applicable')
                    then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end if;

  -- 2. Options.
  for v_opt in select * from public.lease_options where lease_id = p_lease_id loop
    if v_opt.is_exercised then
      -- Historical audit-trail event: retained, never alerts (obligation_class
      -- 'historical' is excluded from active_critical_events).
      insert into public.critical_events (
        property_id, lease_id, lease_option_id, event_type, obligation_class,
        title, description, computation_version, status, generated_by, dedupe_key, updated_at
      ) values (
        v_lease.property_id, v_lease.id, v_opt.id, 'option_exercised', 'historical',
        format('%s option exercised — %s', v_opt.option_type, v_lease.tenant),
        coalesce(v_opt.notes, 'Option exercised.'), 'sql-generator@2026-07-19',
        'completed', 'deterministic', format('option:%s:exercised', v_opt.id), now()
      )
      on conflict (dedupe_key) do update set description = excluded.description, updated_at = now();
      v_count := v_count + 1;

    elsif v_opt.notice_days_required is not null then
      -- Deterministic notice deadline = current-term expiration - notice_days
      -- (leaseMath.optionNoticeDeadline; date - integer = date in Postgres).
      v_computed := v_lease.expiration_date - v_opt.notice_days_required;
      insert into public.critical_events (
        property_id, lease_id, lease_option_id, event_type, obligation_class,
        title, description, computed_date, trigger_event, formula, computation_version,
        mri_value, reconciliation_status, requires_landlord_reminder,
        status, generated_by, dedupe_key, updated_at
      ) values (
        v_lease.property_id, v_lease.id, v_opt.id, 'option_notice', 'legal',
        format('%s option notice deadline — %s', v_opt.option_type, v_lease.tenant),
        format('Notice due at least %s days before the current-term expiration.', v_opt.notice_days_required),
        v_computed, 'current-term expiration',
        format('expiration (%s) - %s days', v_lease.expiration_date, v_opt.notice_days_required),
        'sql-generator@2026-07-19',
        v_opt.notice_deadline,
        case when v_opt.notice_deadline is null then 'no_mri'
             when v_opt.notice_deadline = v_computed then 'match'
             else 'deterministic_differs_from_mri' end,
        coalesce(v_opt.requires_landlord_reminder, false),
        'open', 'deterministic', format('option:%s:notice', v_opt.id), now()
      )
      on conflict (dedupe_key) do update set
        computed_date        = excluded.computed_date,
        formula              = excluded.formula,
        mri_value            = excluded.mri_value,
        reconciliation_status = excluded.reconciliation_status,
        computation_version  = excluded.computation_version,
        updated_at           = now(),
        status = case when public.critical_events.status in ('completed','waived','not_applicable')
                      then public.critical_events.status else excluded.status end;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $$;

comment on function public.generate_critical_events_for_lease(uuid) is
  'P1d-b deterministic generator: materializes critical_events for one lease (expiration + per-option events) from leases/lease_options. Idempotent via dedupe_key; never clobbers human resolutions. Option-notice formula matches src/lib/leaseMath (golden-tested). Migration 20240118.';

-- System operation: service_role only (invoked by the materializer / MCP), never
-- the public anon key. (Anon-lockdown posture, CLAUDE.md.)
revoke all on function public.generate_critical_events_for_lease(uuid) from public, anon;
grant execute on function public.generate_critical_events_for_lease(uuid) to service_role;
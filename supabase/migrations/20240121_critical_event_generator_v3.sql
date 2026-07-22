-- 20240121_critical_event_generator_v3.sql
-- PHASE 1 (P1d, follow-on) — coverage fix for the lease generator so the
-- critical_events ledger reaches parity with the legacy critical_dates store
-- before the Critical Dates widget is repointed at it (branch p1d-c).
--
-- GAP FOUND (proving widget parity): 34 open RENEWAL options carry a stored
-- notice_deadline (MRI = system of record) but have NO notice_days_required on
-- file. The v2 generator only emits a renewal notice when notice_days is present
-- (it recomputes the window as term-end - notice_days), so those 34 were silently
-- dropped from the ledger while the legacy widget still showed them via the stored
-- date. That is the whole of the observed 86 -> 44 option-notice regression.
--
-- v3 adds ONE loop (2a-bis): a renewal option with a stored notice_deadline but no
-- notice_days is CARRIED at its stored date and marked 'unverified' — exactly the
-- treatment v2 already gives non-renewal options (we never fabricate a window from
-- the lease expiration when we lack notice_days). No other logic changes; every
-- other loop is identical to v2. Idempotent: same dedupe_key ('option:<id>:notice')
-- UPSERTs in place, and human resolutions (completed/waived/not_applicable) are
-- never clobbered.
--
-- The '8 other' PMA reporting items are NOT lost in the migration: the ledger
-- already models them as recurring_obligation (from management_agreement_deadlines
-- via generate-recurring-events); no change needed here.

create or replace function public.generate_critical_events_for_lease(p_lease_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_lease record; v_opt record; v_count int := 0;
  v_ref date; v_cum int := 0; v_computed date;
begin
  select l.id, l.property_id, l.expiration_date, l.status, t.name as tenant
    into v_lease from public.leases l join public.tenants t on t.id=l.tenant_id where l.id=p_lease_id;
  if not found then return 0; end if;

  -- 1. Current lease-term expiration (reflects any exercised option).
  if v_lease.expiration_date is not null then
    insert into public.critical_events (
      property_id, lease_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version, status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, 'lease_expiration', 'legal',
      format('Lease expiration — %s', v_lease.tenant),
      'Current lease-term expiration (reflects any exercised option).',
      v_lease.expiration_date, 'current lease term', 'leases.expiration_date (current term)',
      'sql-generator@2026-07-19', 'open', 'deterministic', format('lease:%s:expiration', v_lease.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date=excluded.computed_date, formula=excluded.formula,
      computation_version=excluded.computation_version, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end if;

  -- 2a. RENEWAL options WITH notice_days — sequenced. No explicit order column, so
  --     order by exercise_deadline, then notice_deadline, then created_at.
  v_cum := 0;
  for v_opt in
    select * from public.lease_options
    where lease_id=p_lease_id and not is_exercised
      and option_type='renewal' and notice_days_required is not null
    order by exercise_deadline nulls last, notice_deadline nulls last, created_at
  loop
    v_ref := (v_lease.expiration_date + (v_cum || ' months')::interval)::date;   -- current term-end + prior renewal terms
    v_computed := v_ref - v_opt.notice_days_required;
    insert into public.critical_events (
      property_id, lease_id, lease_option_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version, mri_value, reconciliation_status,
      requires_landlord_reminder, status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, v_opt.id, 'option_notice', 'legal',
      format('renewal option notice deadline — %s', v_lease.tenant),
      format('Notice due at least %s days before the renewal term-end.', v_opt.notice_days_required),
      v_computed, 'renewal term-end',
      format('term-end (%s) - %s days', v_ref, v_opt.notice_days_required),
      'sql-generator@2026-07-19', v_opt.notice_deadline,
      case when v_opt.notice_deadline is null then 'no_mri'
           when v_opt.notice_deadline = v_computed then 'match'
           else 'deterministic_differs_from_mri' end,
      coalesce(v_opt.requires_landlord_reminder,false), 'open', 'deterministic',
      format('option:%s:notice', v_opt.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date=excluded.computed_date, trigger_event=excluded.trigger_event, formula=excluded.formula,
      mri_value=excluded.mri_value, reconciliation_status=excluded.reconciliation_status,
      computation_version=excluded.computation_version, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_cum := v_cum + coalesce(v_opt.term_if_exercised_months, 0);
    v_count := v_count + 1;
  end loop;

  -- 2a-bis. RENEWAL options WITHOUT notice_days but WITH a stored notice_deadline.
  --     We cannot recompute the window without notice_days, so carry the stored
  --     (MRI) date and mark it 'unverified' — same treatment as non-renewal
  --     options below. (v3 fix — recovers renewals the v2 generator dropped.)
  for v_opt in
    select * from public.lease_options
    where lease_id=p_lease_id and not is_exercised
      and option_type='renewal' and notice_days_required is null
      and notice_deadline is not null
  loop
    insert into public.critical_events (
      property_id, lease_id, lease_option_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version, mri_value, reconciliation_status,
      requires_landlord_reminder, status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, v_opt.id, 'option_notice', 'legal',
      format('renewal option notice deadline — %s', v_lease.tenant),
      'Renewal notice; notice-days not on file, so the window cannot be recomputed — stored (MRI) date shown.',
      v_opt.notice_deadline, 'renewal notice (stored)',
      'stored notice date (notice_days not on file; not recomputed)', 'sql-generator@2026-07-21',
      v_opt.notice_deadline, 'unverified',
      coalesce(v_opt.requires_landlord_reminder,false), 'open', 'deterministic',
      format('option:%s:notice', v_opt.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date=excluded.computed_date, trigger_event=excluded.trigger_event, formula=excluded.formula,
      mri_value=excluded.mri_value, reconciliation_status=excluded.reconciliation_status,
      computation_version=excluded.computation_version, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end loop;

  -- 2b. NON-renewal options (termination/expansion/contraction/rofo/rofr): the
  --     notice references a date NOT derivable from the lease expiration. Carry
  --     the STORED notice_deadline (system of record); do NOT recompute. Only
  --     emit when a stored date exists (nothing to track otherwise).
  for v_opt in
    select * from public.lease_options
    where lease_id=p_lease_id and not is_exercised
      and option_type<>'renewal' and notice_deadline is not null
  loop
    insert into public.critical_events (
      property_id, lease_id, lease_option_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version, mri_value, reconciliation_status,
      requires_landlord_reminder, status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, v_opt.id, 'option_notice', 'legal',
      format('%s option notice deadline — %s', v_opt.option_type, v_lease.tenant),
      format('%s notice; window not derivable from the lease expiration — stored (MRI) date shown.', v_opt.option_type),
      v_opt.notice_deadline, v_opt.option_type::text || ' window',
      'stored notice date (not recomputed from lease expiration)', 'sql-generator@2026-07-19',
      v_opt.notice_deadline, 'unverified',
      coalesce(v_opt.requires_landlord_reminder,false), 'open', 'deterministic',
      format('option:%s:notice', v_opt.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date=excluded.computed_date, trigger_event=excluded.trigger_event, formula=excluded.formula,
      mri_value=excluded.mri_value, reconciliation_status=excluded.reconciliation_status,
      computation_version=excluded.computation_version, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end loop;

  -- 2c. Exercised options → historical (never alerts).
  for v_opt in select * from public.lease_options where lease_id=p_lease_id and is_exercised loop
    insert into public.critical_events (
      property_id, lease_id, lease_option_id, event_type, obligation_class, title, description,
      computation_version, status, generated_by, dedupe_key, updated_at
    ) values (
      v_lease.property_id, v_lease.id, v_opt.id, 'option_exercised', 'historical',
      format('%s option exercised — %s', v_opt.option_type, v_lease.tenant),
      coalesce(v_opt.notes,'Option exercised.'), 'sql-generator@2026-07-19',
      'completed', 'deterministic', format('option:%s:exercised', v_opt.id), now()
    )
    on conflict (dedupe_key) do update set description=excluded.description, updated_at=now();
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

comment on function public.generate_critical_events_for_lease(uuid) is
  'P1d generator v3: lease_expiration + SEQUENCED renewal-option notices (notice_days present) + renewal AND non-renewal options WITHOUT notice_days carried at stored/unverified deadline + exercised→historical. v3 (mig 20240121) added the carried-renewal loop so the ledger reaches option-notice parity with the legacy critical_dates widget.';

revoke all on function public.generate_critical_events_for_lease(uuid) from public, anon;
grant execute on function public.generate_critical_events_for_lease(uuid) to service_role;

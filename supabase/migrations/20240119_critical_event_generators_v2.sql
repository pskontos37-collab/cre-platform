-- 20240119_critical_event_generators_v2.sql
-- PHASE 1 (P1d, follow-ons) — corrected lease generator + loan & management-
-- agreement generators for the critical_events ledger.
--
-- CORRECTNESS FIX (found while proving the multi-option leases): the v1 lease
-- generator computed EVERY option's notice as (expiration - notice_days). That is
-- right only for a RENEWAL option (whose notice is due before the current term
-- ends). It is WRONG for termination/expansion/contraction/rofo/rofr options,
-- whose notice references a mid-term date NOT derivable from the lease expiration
-- — which produced false "deterministic_differs_from_mri" flags on mid-term
-- termination windows (e.g. Kay Jewelers' 2026 termination dates flagged as ~5yr
-- "stale" against a 2031 expiration they never referenced). v2:
--   * RENEWAL options are SEQUENCED: the k-th renewal extends from the prior
--     renewal's term-end, so its notice references (current expiration + Σ prior
--     renewal terms) - notice_days. Fixes leases with a renewal chain (Qdoba).
--   * NON-renewal options carry their STORED notice_deadline (MRI = system of
--     record) and are marked 'unverified' — we do not fabricate a date from the
--     expiration.
-- Idempotent: dedupe_key UPSERT corrects v1 rows in place on re-run.

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

  -- 2a. RENEWAL options — sequenced. No explicit order column, so order by
  --     exercise_deadline, then notice_deadline, then created_at.
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

-- ── Loan generator: loan-maturity events (covenants are ratios, not dates) ────
create or replace function public.generate_critical_events_for_loan(p_loan_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_loan record; v_count int := 0;
begin
  select id, property_id, lender_name, maturity_date from public.loans where id=p_loan_id into v_loan;
  if not found or v_loan.maturity_date is null then return 0; end if;
  insert into public.critical_events (
    property_id, loan_id, event_type, obligation_class, title, description,
    computed_date, trigger_event, formula, computation_version, status, generated_by, dedupe_key, updated_at
  ) values (
    v_loan.property_id, v_loan.id, 'loan_maturity', 'legal',
    format('Loan maturity — %s', coalesce(v_loan.lender_name,'lender')),
    'Loan matures; refinance/payoff must be arranged ahead of this date.',
    v_loan.maturity_date, 'loan maturity', 'loans.maturity_date',
    'sql-generator@2026-07-19', 'open', 'deterministic', format('loan:%s:maturity', v_loan.id), now()
  )
  on conflict (dedupe_key) do update set
    computed_date=excluded.computed_date, updated_at=now(),
    status=case when public.critical_events.status in ('completed','waived','not_applicable')
                then public.critical_events.status else excluded.status end;
  return v_count + 1;
end $$;

-- ── Management-agreement generator: termination/renewal notice window ─────────
-- Deterministic: term_end - termination_notice_days, for the CURRENT agreement.
-- (Prose-based recurring submittals in management_agreement_deadlines need a
-- recurrence engine with a date anchor — a later generator.)
create or replace function public.generate_critical_events_for_mgmt_agreement(p_agreement_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_ma record; v_count int := 0; v_computed date;
begin
  select id, property_id, manager_name, term_end, termination_notice_days, is_current
    from public.management_agreements where id=p_agreement_id into v_ma;
  if not found or not coalesce(v_ma.is_current,false) then return 0; end if;
  if v_ma.term_end is not null and v_ma.termination_notice_days is not null then
    v_computed := v_ma.term_end - v_ma.termination_notice_days;
    insert into public.critical_events (
      property_id, management_agreement_id, event_type, obligation_class, title, description,
      computed_date, trigger_event, formula, computation_version, status, generated_by, dedupe_key, updated_at
    ) values (
      v_ma.property_id, v_ma.id, 'mgmt_termination_notice', 'legal',
      format('PMA termination/renewal notice — %s', coalesce(v_ma.manager_name,'manager')),
      format('Notice to terminate/renew the management agreement is due %s days before term-end.', v_ma.termination_notice_days),
      v_computed, 'management-agreement term-end',
      format('term-end (%s) - %s days', v_ma.term_end, v_ma.termination_notice_days),
      'sql-generator@2026-07-19', 'open', 'deterministic', format('mgmt:%s:termination_notice', v_ma.id), now()
    )
    on conflict (dedupe_key) do update set
      computed_date=excluded.computed_date, formula=excluded.formula,
      computation_version=excluded.computation_version, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end if;
  return v_count;
end $$;

comment on function public.generate_critical_events_for_lease(uuid) is
  'P1d generator v2: lease_expiration + SEQUENCED renewal-option notices + non-renewal options carried as stored/unverified + exercised→historical. Renewal notice = (current expiration + prior renewal terms) - notice_days (leaseMath). Migration 20240119.';

revoke all on function public.generate_critical_events_for_loan(uuid) from public, anon;
revoke all on function public.generate_critical_events_for_mgmt_agreement(uuid) from public, anon;
grant execute on function public.generate_critical_events_for_loan(uuid) to service_role;
grant execute on function public.generate_critical_events_for_mgmt_agreement(uuid) to service_role;
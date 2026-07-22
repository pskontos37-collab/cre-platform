-- 20240123_construction_dates.sql
-- Construction & contingency dates (spec: docs/CONSTRUCTION-DATES-SPEC.md).
--
-- The critical-events ledger (mig 20240117-121) is deterministic from STRUCTURED
-- data only; construction-phase dates live only in the lease documents and are
-- tracked nowhere: plan submittal deadlines, landlord plan-approval windows,
-- permit contingencies, delivery-of-possession deadlines, construction completion,
-- opening deadlines, TI-requisition windows, RCD outside dates.
--
-- Trust-layer shape (same as lease_options -> generator): AI extracts to
-- lease_construction_dates WITH mandatory verbatim evidence
-- (scripts/extract_construction_dates.ps1, report-first -> -Load), and the
-- deterministic generator below materializes ledger events. AI never writes
-- critical_events directly. generated_by='import' marks AI-extracted rows on the
-- ledger (the widget badges them); a human-verified source row emits 'human'.
--
-- Also materializes DATED termination windows (termination_rights, mig 20240072 —
-- sales kickouts / fixed windows / dated ongoing rights) as ledger events:
-- deterministic from an existing structured table, so kickout exposure finally
-- reaches the Critical Dates widget.

-- ── 1) Structured home for document-sourced construction/contingency dates ─────
create table if not exists public.lease_construction_dates (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references public.leases(id)     on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,

  obligation_type text not null check (obligation_type in
    ('plan_submittal','plan_approval','permit_contingency','delivery_deadline',
     'construction_completion','opening_deadline','ti_allowance_request','rcd_outside_date')),
  obligor text not null default 'tenant' check (obligor in ('tenant','landlord','either')),

  -- WHEN: a fixed date, or a formula off a trigger ("60 days after delivery").
  -- The generator computes coalesce(fixed_date, trigger_date + offset_days);
  -- an undated formula row becomes a CONDITIONAL ledger event (no alert until dated).
  fixed_date      date,
  trigger_event   text,      -- what starts the clock ('delivery of possession', 'lease execution', 'permit issuance', ...)
  offset_days     integer,   -- days after trigger_event
  trigger_date    date,      -- the trigger's actual date once known (dates the formula)
  window_earliest date,
  window_latest   date,

  remedy             text,    -- what happens on a miss (termination, abatement, forfeiture, self-help)
  grants_termination boolean not null default false,

  -- open = live obligation; satisfied/lapsed/waived resolved at the source;
  -- historical = construction phase long past (stabilized tenant) — audit-only.
  status text not null default 'open'
    check (status in ('open','satisfied','lapsed','waived','historical')),

  -- EVIDENCE — the loader must populate source_quote on every extracted row
  -- (page resolves via quote text in the viewer deep-link, so source_page may be null).
  source_document_id uuid references public.documents(id) on delete set null,
  source_page        integer,
  source_quote       text,
  section_ref        text,

  -- PROVENANCE
  extraction_model      text,
  extraction_confidence text check (extraction_confidence in ('high','medium','low')),
  extracted_at          timestamptz,
  human_verified        boolean not null default false,
  notes                 text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.lease_construction_dates is
  'Document-sourced construction/contingency obligations per lease (mig 20240123). AI-extracted with verbatim evidence by extract_construction_dates.ps1; materialized into critical_events by generate_construction_critical_events(). Spec: docs/CONSTRUCTION-DATES-SPEC.md.';

create index if not exists idx_lease_construction_dates_lease on public.lease_construction_dates (lease_id);
create index if not exists idx_lease_construction_dates_prop  on public.lease_construction_dates (property_id);

alter table public.lease_construction_dates enable row level security;
create policy "lease_construction_dates_select" on public.lease_construction_dates
  for select using (public.can_access_property(property_id));
create policy "lease_construction_dates_insert" on public.lease_construction_dates
  for insert with check (public.is_admin_or_am());
create policy "lease_construction_dates_update" on public.lease_construction_dates
  for update using (public.is_admin_or_am());
grant select, insert, update, delete on public.lease_construction_dates to authenticated;

-- ── 2) Deterministic generator: construction rows -> ledger events ────────────
-- One event per row, event_type = obligation_type (the widget labels per type).
-- Resolved/stale rows class 'historical' (audit-retained, never alert). Human
-- resolutions made ON THE EVENT (completed/waived/not_applicable) are never
-- clobbered — same sticky guard as generator v3.
create or replace function public.generate_construction_critical_events(p_lease_id uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  r record; v_count int := 0;
  v_date date; v_label text; v_class text; v_status text; v_formula text;
  v_mri date; v_recon text;
begin
  for r in
    select c.*, l.commencement_date, t.name as tenant
    from public.lease_construction_dates c
    join public.leases  l on l.id = c.lease_id
    join public.tenants t on t.id = l.tenant_id
    where p_lease_id is null or c.lease_id = p_lease_id
  loop
    v_date := coalesce(
      r.fixed_date,
      case when r.trigger_date is not null and r.offset_days is not null
           then r.trigger_date + r.offset_days end);

    v_label := case r.obligation_type
      when 'plan_submittal'          then 'Tenant plan submittal deadline'
      when 'plan_approval'           then 'Landlord plan-approval deadline'
      when 'permit_contingency'      then 'Permit contingency outside date'
      when 'delivery_deadline'       then 'Delivery-of-possession deadline'
      when 'construction_completion' then 'Construction completion deadline'
      when 'opening_deadline'        then 'Tenant opening deadline'
      when 'ti_allowance_request'    then 'TI allowance requisition deadline'
      when 'rcd_outside_date'        then 'Rent-commencement outside date'
      else r.obligation_type end;

    if r.status in ('satisfied','lapsed','waived','historical') then
      v_class := 'historical'; v_status := 'completed';
    else
      v_class := case when r.grants_termination then 'legal' else 'operational' end;
      v_status := 'open';
    end if;

    v_formula := case
      when r.fixed_date is not null then 'fixed date stated in lease'
      when r.trigger_event is not null and r.offset_days is not null then
        format('%s + %s days%s', r.trigger_event, r.offset_days,
               case when r.trigger_date is null then ' (trigger not yet dated)' else '' end)
      else 'see cited provision' end;

    -- RCD outside dates cross-check the MRI-fed commencement date: commenced on
    -- or before the outside date = match; after it = flag for a human.
    if r.obligation_type = 'rcd_outside_date' and r.commencement_date is not null and v_date is not null then
      v_mri := r.commencement_date;
      v_recon := case when r.commencement_date <= v_date then 'match'
                      else 'deterministic_differs_from_mri' end;
    else
      v_mri := null; v_recon := 'no_mri';
    end if;

    insert into public.critical_events (
      property_id, lease_id, event_type, obligation_class, title, description,
      computed_date, window_earliest, window_latest, trigger_event, formula,
      computation_version, is_conditional,
      source_document_id, source_page, source_section, source_quote,
      mri_value, reconciliation_status, status, generated_by, dedupe_key, updated_at
    ) values (
      r.property_id, r.lease_id, r.obligation_type, v_class,
      format('%s — %s', v_label, r.tenant),
      concat_ws(' ',
        format('Obligor: %s.', r.obligor),
        case when r.remedy is not null then format('On miss: %s', r.remedy) end,
        case when r.status <> 'open' then format('[source row %s]', r.status) end),
      v_date, r.window_earliest, r.window_latest, r.trigger_event, v_formula,
      'sql-generator@2026-07-21', (v_date is null),
      r.source_document_id, r.source_page, r.section_ref, r.source_quote,
      v_mri, v_recon, v_status,
      case when r.human_verified then 'human' else 'import' end,
      format('construction:%s', r.id), now()
    )
    on conflict (dedupe_key) do update set
      obligation_class=excluded.obligation_class, title=excluded.title,
      description=excluded.description, computed_date=excluded.computed_date,
      window_earliest=excluded.window_earliest, window_latest=excluded.window_latest,
      trigger_event=excluded.trigger_event, formula=excluded.formula,
      computation_version=excluded.computation_version, is_conditional=excluded.is_conditional,
      source_document_id=excluded.source_document_id, source_page=excluded.source_page,
      source_section=excluded.source_section, source_quote=excluded.source_quote,
      mri_value=excluded.mri_value, reconciliation_status=excluded.reconciliation_status,
      generated_by=excluded.generated_by, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

comment on function public.generate_construction_critical_events(uuid) is
  'Materializes lease_construction_dates into critical_events (mig 20240123). event_type = obligation_type; resolved/stale source rows -> historical; undated formula rows -> is_conditional (no alert until dated); rcd_outside_date cross-checks leases.commencement_date. generated_by import|human by source human_verified.';

revoke all on function public.generate_construction_critical_events(uuid) from public, anon;
grant execute on function public.generate_construction_critical_events(uuid) to service_role;

-- ── 3) Deterministic generator: dated termination windows -> ledger events ────
-- termination_rights (mig 20240072) already stores kickout/fixed windows with
-- dates, but they never reached the Critical Dates widget. Phase-aware single
-- date: window past -> historical; window not yet open -> alert on its opening;
-- window open now -> alert on its close (right exercisable until then).
create or replace function public.generate_termination_window_events(p_lease_id uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  r record; v_count int := 0;
  v_start date; v_end date; v_date date; v_class text; v_status text;
  v_label text; v_phase text;
begin
  for r in
    select tr.*, t.name as tenant
    from public.termination_rights tr
    join public.leases  l on l.id = tr.lease_id
    join public.tenants t on t.id = l.tenant_id
    where (p_lease_id is null or tr.lease_id = p_lease_id)
      and (tr.window_start is not null or tr.window_end is not null or tr.exercisable_from is not null)
  loop
    v_start := coalesce(r.window_start, r.exercisable_from);
    v_end   := r.window_end;

    if v_end is not null and v_end < current_date then
      v_date := v_end; v_class := 'historical'; v_status := 'completed';
      v_phase := 'window lapsed';
    elsif v_start is not null and v_start > current_date then
      v_date := v_start; v_class := 'legal'; v_status := 'open';
      v_phase := 'window opens';
    elsif v_end is not null then
      v_date := v_end; v_class := 'legal'; v_status := 'open';
      v_phase := 'window closes — right exercisable until then';
    else
      continue;  -- no usable date (open-ended ongoing right already open = radar's job)
    end if;

    v_label := case r.right_type
      when 'sales_kickout'          then 'Sales kickout'
      when 'fixed_window'           then 'Termination window'
      when 'ongoing_notice'         then 'Termination right'
      when 'cotenancy_termination'  then 'Co-tenancy termination'
      else 'Termination right' end;

    insert into public.critical_events (
      property_id, lease_id, event_type, obligation_class, title, description,
      computed_date, window_earliest, window_latest, trigger_event, formula,
      computation_version, status, generated_by, dedupe_key, updated_at
    ) values (
      r.property_id, r.lease_id, 'termination_window', v_class,
      format('%s — %s', v_label, r.tenant),
      concat_ws(' ',
        format('%s (%s).', coalesce(r.details, v_label), v_phase),
        case when r.sales_threshold is not null
             then format('Sales floor $%s.', to_char(r.sales_threshold, 'FM999,999,999')) end,
        case when r.notice_days is not null
             then format('%s days'' notice.', r.notice_days) end),
      v_date, v_start, v_end, r.right_type,
      'termination_rights window (structured, mig 20240072)',
      'sql-generator@2026-07-21', v_status,
      case when r.human_verified then 'human' else 'import' end,
      format('termright:%s:window', r.id), now()
    )
    on conflict (dedupe_key) do update set
      obligation_class=excluded.obligation_class, title=excluded.title,
      description=excluded.description, computed_date=excluded.computed_date,
      window_earliest=excluded.window_earliest, window_latest=excluded.window_latest,
      formula=excluded.formula, computation_version=excluded.computation_version,
      generated_by=excluded.generated_by, updated_at=now(),
      status=case when public.critical_events.status in ('completed','waived','not_applicable')
                  then public.critical_events.status else excluded.status end;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

comment on function public.generate_termination_window_events(uuid) is
  'Materializes DATED termination_rights windows (kickouts/fixed windows) into critical_events (mig 20240123). Phase-aware: lapsed -> historical; future window -> alert on opening; open window -> alert on close. Re-run after every extract_lease_rights load.';

revoke all on function public.generate_termination_window_events(uuid) from public, anon;
grant execute on function public.generate_termination_window_events(uuid) to service_role;

notify pgrst, 'reload schema';

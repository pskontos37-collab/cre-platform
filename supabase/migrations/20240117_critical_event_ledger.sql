-- 20240117_critical_event_ledger.sql
-- PHASE 1 (audit trust layer) — ONE authoritative CRITICAL-EVENT LEDGER.
--
-- Today two date stores disagree: AI dates embedded in lease_abstracts.abstract
-- JSON, and the operational `critical_dates` table materialized from leases/
-- options. That split is the Starbucks root cause — the dashboard can show a lease
-- expiring in days while the abstract shows it renewed. `critical_dates` also has
-- NO per-option link (its dedup is lease+date_type+source), so it cannot tell one
-- option's notice date from another's, and a superseded (pre-exercise) expiration
-- keeps firing as an active alert.
--
-- `critical_events` is the single ledger every surface (abstract, dashboard,
-- rollover, tasks, calendar, reports, alerts) should read. Each event:
--   - links to a STABLE source obligation/right (lease_option_id, etc.);
--   - carries EVIDENCE (source document + page/section/quote via the register);
--   - stores the DETERMINISTIC formula + trigger + computed date + calc version
--     (computed by src/lib/leaseMath, not an AI model — the generator is P1d-b);
--   - cross-checks the computed date against the MRI/stored value and flags a
--     discrepancy rather than silently trusting either;
--   - is CLASSIFIED (legal/operational/informational/historical/superseded) so a
--     superseded expiration is retained for audit but excluded from active alerts.
--
-- This migration is ADDITIVE: it only CREATES new objects. `critical_dates` is
-- left untouched and keeps running; consumers migrate to the ledger in later
-- increments (generator P1d-b, UI wiring P1d-c), then the old store is retired.

create table if not exists public.critical_events (
  id uuid primary key default gen_random_uuid(),

  -- ── WHERE it belongs ──
  property_id             uuid references public.properties(id)            on delete cascade,
  lease_id                uuid references public.leases(id)                on delete cascade,
  lease_option_id         uuid references public.lease_options(id)         on delete cascade,  -- STABLE per-option link (the audit's fix)
  loan_id                 uuid references public.loans(id)                 on delete cascade,
  management_agreement_id uuid references public.management_agreements(id) on delete cascade,

  -- ── WHAT it is ──
  event_type       text not null,   -- 'option_notice' | 'lease_expiration' | 'rent_step' | 'recurring_report' | 'loan_maturity' | ...
  obligation_class text not null default 'operational'
    check (obligation_class in ('legal','operational','informational','historical','superseded')),
  title            text not null,
  description      text,

  -- ── WHEN (deterministic) ──
  computed_date        date,          -- the computed event date (null until computable)
  window_earliest      date,          -- for windows rather than a single date
  window_latest        date,
  trigger_event        text,          -- what starts the clock ('current-term expiration', 'RCD', 'fixed', ...)
  formula              text,          -- human-readable deterministic rule, e.g. 'expiration - 270 days'
  computation_version  text,          -- which calc produced computed_date (e.g. 'leaseMath@2026-07-19')
  is_conditional       boolean not null default false,  -- clock runs only if the trigger occurs

  -- ── EVIDENCE (register linkage) ──
  source_document_id   uuid references public.documents(id) on delete set null,
  source_page          integer,
  source_section       text,
  source_quote         text,
  mri_value            date,          -- MRI/stored value for cross-check (system of record for option dates)
  reconciliation_status text not null default 'unverified'
    check (reconciliation_status in ('match','deterministic_differs_from_mri','no_mri','unverified')),

  -- ── WORKFLOW ──
  status             text not null default 'open'
    check (status in ('open','in_progress','completed','waived','not_applicable','superseded')),
  responsible_owner  uuid references public.users(id) on delete set null,
  alert_days_before  integer[] not null default '{}',
  requires_landlord_reminder boolean not null default false,
  completed_date     date,
  completed_by       uuid references public.users(id) on delete set null,
  resolution_note    text,

  -- ── PROVENANCE ──
  generated_by   text not null default 'deterministic'   -- 'deterministic' | 'human' | 'import'
    check (generated_by in ('deterministic','human','import')),
  superseded_by  uuid references public.critical_events(id) on delete set null,
  -- Idempotency key for the deterministic generator: one row per
  -- (source obligation, event type). Lets a re-run UPSERT rather than duplicate
  -- (the exact bug in critical_dates' lease+type+source dedup). Nullable so
  -- human-authored events don't need one.
  dedupe_key     text unique,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.critical_events is
  'Single authoritative critical-event ledger (Phase 1, migration 20240117). One row per obligation/right with stable source link, evidence, deterministic formula+computed date, MRI cross-check, and lifecycle class. Supersedes the split between lease_abstracts JSON dates and critical_dates. Generator = P1d-b (src/lib/leaseMath).';
comment on column public.critical_events.lease_option_id is
  'Stable per-option link — the fix for critical_dates having no option identity (one option''s notice date could not be told from another''s).';
comment on column public.critical_events.obligation_class is
  'legal | operational | informational | historical | superseded. historical/superseded are retained for audit but EXCLUDED from active alerts (a pre-exercise expiration must not keep firing).';
comment on column public.critical_events.reconciliation_status is
  'Deterministic computed_date vs mri_value: match | deterministic_differs_from_mri (flag for a human) | no_mri | unverified.';

create index if not exists critical_events_property_idx  on public.critical_events (property_id);
create index if not exists critical_events_lease_idx     on public.critical_events (lease_id);
create index if not exists critical_events_option_idx    on public.critical_events (lease_option_id);
create index if not exists critical_events_computed_idx  on public.critical_events (computed_date);
-- Active-alert hot path: open, non-historical events with a date.
create index if not exists critical_events_active_idx    on public.critical_events (computed_date)
  where status = 'open' and obligation_class not in ('historical','superseded');

-- RLS mirrors critical_dates exactly: read scoped by property; write = admin/AM
-- (the deterministic generator runs as service_role and bypasses RLS).
alter table public.critical_events enable row level security;
create policy "critical_events_select" on public.critical_events for select using (public.can_access_property(property_id));
create policy "critical_events_insert" on public.critical_events for insert with check (public.is_admin_or_am());
create policy "critical_events_update" on public.critical_events for update using (public.is_admin_or_am());
grant select, insert, update, delete on public.critical_events to authenticated;

-- Active events for alerts/rollover: exclude completed/waived/N-A and the
-- historical/superseded classes. security_invoker → respects the table's RLS.
create or replace view public.active_critical_events
with (security_invoker = true) as
select *
from public.critical_events
where status in ('open','in_progress')
  and obligation_class not in ('historical','superseded');

comment on view public.active_critical_events is
  'Open/in-progress events excluding historical & superseded — the set that may raise an alert. A pre-exercise expiration lives in critical_events (audit trail) but never here. Migration 20240117.';

grant select on public.active_critical_events to authenticated;
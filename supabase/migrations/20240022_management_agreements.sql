-- ============================================================
-- Property Management Agreements — capture + prompt for operational terms
-- (PM/leasing/construction fees, spending & decision authority, submittals,
--  budget process, leasing authority, funds handling, insurance, term/termination).
-- Text + CHECK instead of new enums so this stays additive and transaction-safe.
-- ============================================================

create table if not exists management_agreements (
  id                      uuid primary key default uuid_generate_v4(),
  property_id             uuid not null references properties(id) on delete cascade,
  document_id             uuid references documents(id) on delete set null,
  role                    text not null default 'base' check (role in ('base','amendment','sub_management')),
  manager_name            text,
  sub_manager_name        text,
  owner_name              text,
  effective_date          date,
  amends_id               uuid references management_agreements(id) on delete set null,
  -- term
  term_start              date,
  term_end                date,
  -- high-value, queryable/alertable terms (the rest live in `terms` jsonb)
  termination_notice_days integer,
  mgmt_fee_pct            numeric,
  construction_fee_pct    numeric,   -- null when tiered; see terms->'fees'
  leasing_fee_pct         numeric,
  budget_variance_pct     numeric,   -- line-item variance requiring owner approval
  monthly_report_due_day  integer,
  -- comprehensive structured capture (fees, authority, owner_approval, submittals,
  -- budget, leasing, funds, insurance, standard_of_care, termination, term, …)
  terms                   jsonb not null default '{}'::jsonb,
  is_current              boolean not null default true,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Recurring submittals / notice windows the platform prompts for and can calendar.
create table if not exists management_agreement_deadlines (
  id             uuid primary key default uuid_generate_v4(),
  agreement_id   uuid not null references management_agreements(id) on delete cascade,
  property_id    uuid not null references properties(id) on delete cascade,
  kind           text not null default 'report'
                   check (kind in ('report','budget','reconciliation','insurance','notice','expiration','certification','other')),
  label          text not null,
  frequency      text check (frequency in ('monthly','quarterly','semiannual','annual','one_time','on_event')),
  due_rule       text,           -- e.g. "15th of month", "within 90 days of year start", "60 days before sale"
  next_due       date,           -- optional concrete next occurrence; used to push a row into critical_dates
  source_section text,
  created_at     timestamptz not null default now()
);

-- Link PMA-generated calendar items back to the agreement (mirrors loan_id).
alter table critical_dates add column if not exists management_agreement_id uuid references management_agreements(id) on delete cascade;

alter table management_agreements           enable row level security;
alter table management_agreement_deadlines  enable row level security;

create policy "ma_select"  on management_agreements          for select using (public.can_access_property(property_id));
create policy "ma_write"   on management_agreements          for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());
create policy "mad_select" on management_agreement_deadlines for select using (public.can_access_property(property_id));
create policy "mad_write"  on management_agreement_deadlines for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());

create index if not exists idx_ma_property     on management_agreements(property_id);
create index if not exists idx_mad_agreement   on management_agreement_deadlines(agreement_id);
create index if not exists idx_mad_property    on management_agreement_deadlines(property_id);

-- ============================================================
-- GROUP C: Financials
-- ============================================================

-- import_jobs.created_by FK added after users table in 20240008
create table import_jobs (
  id             uuid primary key default uuid_generate_v4(),
  property_id    uuid not null references properties(id) on delete cascade,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  file_name      text,
  import_type    import_type not null,
  status         import_status not null default 'pending',
  column_mapping jsonb,
  row_count      integer,
  error_log      jsonb
);

create table financial_periods (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references properties(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  period_type   period_type not null,
  is_budget     boolean not null default false,
  source        financial_source not null default 'manual',
  import_job_id uuid references import_jobs(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table operating_line_items (
  id                  uuid primary key default uuid_generate_v4(),
  financial_period_id uuid not null references financial_periods(id) on delete cascade,
  category            operating_category not null,
  line_name           text not null,
  amount              numeric not null,
  unit_id             uuid references units(id) on delete set null,
  tenant_id           uuid references tenants(id) on delete set null,
  notes               text,
  created_at          timestamptz not null default now()
);

create table loans (
  id                  uuid primary key default uuid_generate_v4(),
  property_id         uuid not null references properties(id) on delete restrict,
  lender_name         text,
  loan_amount         numeric,
  outstanding_balance numeric,
  interest_rate       numeric,
  rate_type           rate_type not null default 'fixed',
  origination_date    date,
  maturity_date       date,
  amortization_years  integer,
  io_period_months    integer,
  annual_debt_service numeric,
  dscr_covenant       numeric,
  ltv_covenant        numeric,
  notes               text,
  document_id         uuid references documents(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table loan_covenant_checks (
  id              uuid primary key default uuid_generate_v4(),
  loan_id         uuid not null references loans(id) on delete cascade,
  checked_at      date not null,
  trailing_12_noi numeric,
  annual_debt_svc numeric,
  dscr_actual     numeric,
  dscr_covenant   numeric,
  headroom        numeric,
  is_breach       boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Back-fill FK from critical_dates to loans
alter table critical_dates
  add constraint critical_dates_loan_id_fkey
  foreign key (loan_id) references loans(id) on delete set null;

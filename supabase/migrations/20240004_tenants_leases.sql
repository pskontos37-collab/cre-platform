-- ============================================================
-- GROUP B: Tenants & Leases
-- ============================================================

create table tenants (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  trade_name    text,
  industry      text,
  credit_rating text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Stub so leases can FK to documents; fully defined in 20240007
create table documents (
  id uuid primary key default uuid_generate_v4()
);

create table leases (
  id                       uuid primary key default uuid_generate_v4(),
  property_id              uuid not null references properties(id) on delete restrict,
  unit_id                  uuid references units(id) on delete restrict,
  tenant_id                uuid not null references tenants(id) on delete restrict,
  document_id              uuid references documents(id) on delete set null,
  lease_type               text not null check (lease_type in ('retail', 'office')),
  status                   lease_status not null default 'active',
  lease_number             text,
  commencement_date        date,
  expiration_date          date,
  rent_commencement_date   date,
  free_rent_months         integer default 0,
  leased_sf                numeric,
  recovery_method          recovery_method,
  base_year                integer,
  expense_stop_amount      numeric,
  security_deposit         numeric,
  ti_allowance             numeric,
  ti_allowance_paid        numeric,
  has_percentage_rent      boolean not null default false,
  percentage_rent_rate     numeric,
  natural_breakpoint       numeric,
  artificial_breakpoint    numeric,
  has_exclusives           boolean not null default false,
  has_co_tenancy_clause    boolean not null default false,
  has_radius_restriction   boolean not null default false,
  radius_restriction_miles numeric,
  sublease_allowed         boolean,
  assignment_allowed       boolean,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table lease_rent_schedule (
  id               uuid primary key default uuid_generate_v4(),
  lease_id         uuid not null references leases(id) on delete cascade,
  effective_date   date not null,
  annual_rent      numeric not null,
  rent_per_sf      numeric,
  escalation_type  text,
  escalation_value numeric,
  created_at       timestamptz not null default now()
);

create table lease_cam_terms (
  id            uuid primary key default uuid_generate_v4(),
  lease_id      uuid not null references leases(id) on delete cascade,
  cam_type      text,
  admin_fee_pct numeric,
  cap_type      text,
  cap_pct       numeric,
  exclusions    text[],
  created_at    timestamptz not null default now()
);

create table lease_options (
  id                       uuid primary key default uuid_generate_v4(),
  lease_id                 uuid not null references leases(id) on delete cascade,
  option_type              option_type not null,
  notice_days_required     integer,
  notice_deadline          date,
  exercise_deadline        date,
  term_if_exercised_months integer,
  rent_at_exercise         text,
  is_exercised             boolean not null default false,
  notes                    text,
  created_at               timestamptz not null default now()
);

create table co_tenancy_clauses (
  id                      uuid primary key default uuid_generate_v4(),
  lease_id                uuid not null references leases(id) on delete cascade,
  clause_type             co_tenancy_clause_type not null,
  anchor_tenant_id        uuid references tenants(id) on delete set null,
  occupancy_threshold_pct numeric,
  named_tenant_id         uuid references tenants(id) on delete set null,
  remedy                  co_tenancy_remedy not null,
  remedy_rent_pct         numeric,
  cure_period_days        integer,
  is_triggered            boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- co_tenancy_flags references users; FK added in 20240008
create table co_tenancy_flags (
  id                   uuid primary key default uuid_generate_v4(),
  co_tenancy_clause_id uuid not null references co_tenancy_clauses(id) on delete cascade,
  property_id          uuid not null references properties(id) on delete cascade,
  triggered_at         timestamptz not null default now(),
  trigger_reason       text not null,
  remedy_description   text,
  source_document_ids  uuid[],
  status               co_tenancy_flag_status not null default 'pending_review',
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  notes                text
);

-- critical_dates.loan_id FK added after loans table in 20240005
create table critical_dates (
  id                uuid primary key default uuid_generate_v4(),
  property_id       uuid not null references properties(id) on delete cascade,
  lease_id          uuid references leases(id) on delete cascade,
  loan_id           uuid,
  date_type         critical_date_type not null,
  due_date          date not null,
  description       text,
  is_completed      boolean not null default false,
  alert_days_before integer[],
  created_at        timestamptz not null default now()
);

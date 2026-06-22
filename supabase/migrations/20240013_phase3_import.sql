-- ============================================================
-- PHASE 3 — Drive import pipeline
-- Adds: drive_file_catalog, rent_roll_snapshots, rent_roll_rows
-- Seeds: BBK Knightdale LLC portfolio + KM East/West properties
-- Safe to re-run (IF NOT EXISTS + ON CONFLICT DO NOTHING)
-- ============================================================

-- ── Drive file catalog (sync manifest) ───────────────────────
create table if not exists public.drive_file_catalog (
  drive_id          text        primary key,
  name              text        not null,
  parent_folder     text,
  mime_type         text,
  file_size_bytes   bigint,
  modified_at       timestamptz,
  property_id       uuid        references public.properties(id) on delete set null,
  file_category     text        check (file_category in (
                                  'rent_roll','trial_balance','income_statement',
                                  'budget','lease_doc','correspondence','other')),
  period_year       int,
  period_month      int         check (period_month between 1 and 12),
  import_status     text        not null default 'pending'
                                check (import_status in ('pending','imported','error','skipped')),
  import_job_id     uuid        references public.import_jobs(id) on delete set null,
  imported_at       timestamptz,
  import_error      text,
  last_synced_at    timestamptz not null default now()
);

-- ── Rent roll snapshots (point-in-time from Drive xlsx) ───────
create table if not exists public.rent_roll_snapshots (
  id                uuid        primary key default uuid_generate_v4(),
  property_id       uuid        not null references public.properties(id) on delete cascade,
  period_year       int         not null,
  period_month      int         not null check (period_month between 1 and 12),
  drive_file_id     text        references public.drive_file_catalog(drive_id),
  import_job_id     uuid        references public.import_jobs(id),
  total_sf          numeric,
  leased_sf         numeric,
  vacant_sf         numeric,
  occupancy_pct     numeric,
  avg_base_rent_psf numeric,
  total_base_rent   numeric,
  row_count         int,
  created_at        timestamptz not null default now(),
  unique(property_id, period_year, period_month)
);

-- ── Rent roll rows (individual lease records per snapshot) ────
create table if not exists public.rent_roll_rows (
  id                uuid        primary key default uuid_generate_v4(),
  snapshot_id       uuid        not null references public.rent_roll_snapshots(id) on delete cascade,
  property_id       uuid        not null references public.properties(id) on delete cascade,
  suite             text,
  tenant_name       text,
  sqft              numeric,
  lease_start       date,
  lease_end         date,
  monthly_base_rent numeric,
  annual_base_rent  numeric,
  base_rent_psf     numeric,
  is_occupied       boolean     not null default true,
  tenant_id         uuid        references public.tenants(id) on delete set null,
  lease_id          uuid        references public.leases(id) on delete set null,
  unit_id           uuid        references public.units(id) on delete set null,
  raw_data          jsonb,
  created_at        timestamptz not null default now()
);

-- ── Seed: BBK Knightdale LLC portfolio ────────────────────────
insert into public.portfolios (id, name, description)
values (
  '00000000-0000-0000-0000-000000000001',
  'BBK Knightdale LLC',
  'Knightdale Marketplace — KM East (Midtown #0531) and KM West (Midway #0532). Acquired July 2019.'
) on conflict (id) do nothing;

-- ── Seed: KM East ────────────────────────────────────────────
insert into public.properties (
  id, portfolio_id, name, address, city, state, zip,
  asset_type, acquisition_date, notes
)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'KM East — Knightdale Marketplace East',
  'Knightdale Marketplace East',
  'Knightdale', 'NC', '27545',
  'retail',
  '2019-07-15',
  'fka Shoppes at Midway Plantation. Drive folder: Midtown #0531.'
) on conflict (id) do nothing;

-- ── Seed: KM West ────────────────────────────────────────────
insert into public.properties (
  id, portfolio_id, name, address, city, state, zip,
  asset_type, acquisition_date, notes
)
values (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'KM West — Knightdale Marketplace West',
  'Knightdale Marketplace West',
  'Knightdale', 'NC', '27545',
  'retail',
  '2019-07-15',
  'fka Midtown Commons. Drive folder: Midway #0532.'
) on conflict (id) do nothing;

-- ── Seed: KeyBank acquisition loan ───────────────────────────
insert into public.loans (
  property_id, lender_name, rate_type, origination_date, notes
)
select
  '00000000-0000-0000-0000-000000000010',
  'KeyBank', 'fixed', '2019-07-15',
  'Consolidated acquisition loan covering KM East and KM West. Update balance, rate, maturity, and ADS from the loan agreement.'
where not exists (
  select 1 from public.loans
  where property_id = '00000000-0000-0000-0000-000000000010'
    and lender_name = 'KeyBank'
);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.drive_file_catalog  enable row level security;
alter table public.rent_roll_snapshots enable row level security;
alter table public.rent_roll_rows      enable row level security;

drop policy if exists "dfc_select" on public.drive_file_catalog;
drop policy if exists "dfc_insert" on public.drive_file_catalog;
drop policy if exists "dfc_update" on public.drive_file_catalog;
create policy "dfc_select" on public.drive_file_catalog for select using (public.is_admin_or_am());
create policy "dfc_insert" on public.drive_file_catalog for insert with check (public.is_admin_or_am());
create policy "dfc_update" on public.drive_file_catalog for update using (public.is_admin_or_am());

drop policy if exists "rrs_select" on public.rent_roll_snapshots;
drop policy if exists "rrs_insert" on public.rent_roll_snapshots;
create policy "rrs_select" on public.rent_roll_snapshots for select using (public.can_access_property(property_id));
create policy "rrs_insert" on public.rent_roll_snapshots for insert with check (public.is_admin_or_am());

drop policy if exists "rrr_select" on public.rent_roll_rows;
drop policy if exists "rrr_insert" on public.rent_roll_rows;
create policy "rrr_select" on public.rent_roll_rows for select using (public.can_access_property(property_id));
create policy "rrr_insert" on public.rent_roll_rows for insert with check (public.is_admin_or_am());

-- ── Indexes ───────────────────────────────────────────────────
create index if not exists idx_dfc_property_id  on public.drive_file_catalog(property_id);
create index if not exists idx_dfc_category     on public.drive_file_catalog(file_category);
create index if not exists idx_dfc_status       on public.drive_file_catalog(import_status);
create index if not exists idx_rrs_prop_period  on public.rent_roll_snapshots(property_id, period_year, period_month);
create index if not exists idx_rrr_snapshot     on public.rent_roll_rows(snapshot_id);
create index if not exists idx_rrr_property     on public.rent_roll_rows(property_id);

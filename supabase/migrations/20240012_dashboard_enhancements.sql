-- ============================================================
-- DASHBOARD ENHANCEMENTS
-- Adds: dashboard_prefs on users, cam_reconciliations,
--       lease_payments, pct_rent_records
-- Safe to re-run (IF NOT EXISTS guards throughout)
-- ============================================================

-- User dashboard preferences (theme + widget layout)
alter table public.users
  add column if not exists dashboard_prefs jsonb not null default '{}'::jsonb;

-- ── CAM Reconciliation Tracking ──────────────────────────────
create table if not exists public.cam_reconciliations (
  id                uuid        primary key default uuid_generate_v4(),
  property_id       uuid        not null references properties(id) on delete cascade,
  lease_id          uuid        references leases(id) on delete set null,
  tenant_id         uuid        references tenants(id) on delete set null,
  period_year       int         not null,
  estimated_amount  numeric,
  actual_amount     numeric,
  status            text        not null default 'in_progress'
                                check (status in ('in_progress', 'complete', 'overdue', 'disputed')),
  due_date          date,
  completed_date    date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ── Lease Payment Tracking (for delinquency) ─────────────────
create table if not exists public.lease_payments (
  id            uuid        primary key default uuid_generate_v4(),
  lease_id      uuid        not null references leases(id) on delete cascade,
  property_id   uuid        not null references properties(id) on delete cascade,
  tenant_id     uuid        not null references tenants(id) on delete cascade,
  amount_due    numeric     not null,
  amount_paid   numeric     not null default 0,
  due_date      date        not null,
  paid_date     date,
  payment_type  text        not null default 'rent'
                            check (payment_type in ('rent', 'cam', 'tax', 'insurance', 'other')),
  period_start  date,
  period_end    date,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Percentage Rent Sales Records ────────────────────────────
create table if not exists public.pct_rent_records (
  id                        uuid        primary key default uuid_generate_v4(),
  lease_id                  uuid        not null references leases(id) on delete cascade,
  property_id               uuid        not null references properties(id) on delete cascade,
  tenant_id                 uuid        not null references tenants(id) on delete cascade,
  period_year               int         not null,
  period_month              int         check (period_month between 1 and 12),
  reported_sales            numeric     not null,
  cumulative_ytd_sales      numeric,
  pct_rent_owed             numeric,
  is_annual_reconciliation  boolean     not null default false,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ── RLS ────────────────────────────────────────────────────────
alter table public.cam_reconciliations  enable row level security;
alter table public.lease_payments       enable row level security;
alter table public.pct_rent_records     enable row level security;

-- cam_reconciliations (drop first so re-runs don't error on duplicate policy)
drop policy if exists "cam_recon_select" on public.cam_reconciliations;
drop policy if exists "cam_recon_insert" on public.cam_reconciliations;
drop policy if exists "cam_recon_update" on public.cam_reconciliations;
drop policy if exists "cam_recon_delete" on public.cam_reconciliations;
create policy "cam_recon_select"  on public.cam_reconciliations for select using (public.can_access_property(property_id));
create policy "cam_recon_insert"  on public.cam_reconciliations for insert with check (public.can_access_property(property_id));
create policy "cam_recon_update"  on public.cam_reconciliations for update using (public.can_access_property(property_id));
create policy "cam_recon_delete"  on public.cam_reconciliations for delete using (public.is_admin_or_am());

-- lease_payments
drop policy if exists "lease_pay_select" on public.lease_payments;
drop policy if exists "lease_pay_insert" on public.lease_payments;
drop policy if exists "lease_pay_update" on public.lease_payments;
create policy "lease_pay_select"  on public.lease_payments for select using (public.can_access_property(property_id));
create policy "lease_pay_insert"  on public.lease_payments for insert with check (public.can_access_property(property_id));
create policy "lease_pay_update"  on public.lease_payments for update using (public.can_access_property(property_id));

-- pct_rent_records
drop policy if exists "pct_rent_select" on public.pct_rent_records;
drop policy if exists "pct_rent_insert" on public.pct_rent_records;
drop policy if exists "pct_rent_update" on public.pct_rent_records;
create policy "pct_rent_select"   on public.pct_rent_records for select using (public.can_access_property(property_id));
create policy "pct_rent_insert"   on public.pct_rent_records for insert with check (public.can_access_property(property_id));
create policy "pct_rent_update"   on public.pct_rent_records for update using (public.can_access_property(property_id));

-- ── Indexes (IF NOT EXISTS) ────────────────────────────────────
create index if not exists idx_cam_recon_property_id  on public.cam_reconciliations(property_id);
create index if not exists idx_cam_recon_status       on public.cam_reconciliations(status);
create index if not exists idx_cam_recon_year         on public.cam_reconciliations(period_year);
create index if not exists idx_lease_pay_property_id  on public.lease_payments(property_id);
create index if not exists idx_lease_pay_due_date     on public.lease_payments(due_date);
create index if not exists idx_lease_pay_paid_date    on public.lease_payments(paid_date);
create index if not exists idx_pct_rent_property_id   on public.pct_rent_records(property_id);
create index if not exists idx_pct_rent_lease_id      on public.pct_rent_records(lease_id);
create index if not exists idx_pct_rent_year          on public.pct_rent_records(period_year);

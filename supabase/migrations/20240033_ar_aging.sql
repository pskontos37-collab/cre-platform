-- 20240033_ar_aging.sql
-- Tenant A/R aging snapshots from the MRI "Aged Delinquencies" export.
-- One row per tenant (MRI lease) per snapshot date; buckets mirror the report
-- columns (Current / 30 / 60 / 90 / 120+). categories carries the per-income-
-- category subtotals as jsonb for drill-down. Loader: scripts/load_ar_aging.ps1.

create table if not exists public.ar_aging (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  as_of_date date not null,
  tenant_id uuid references public.tenants(id),
  lease_id uuid references public.leases(id),
  tenant_label text not null,
  mri_lease_id text,
  suite text,
  occupant_status text,
  total numeric not null,
  bucket_current numeric not null default 0,
  bucket_30 numeric not null default 0,
  bucket_60 numeric not null default 0,
  bucket_90 numeric not null default 0,
  bucket_120 numeric not null default 0,
  last_payment_date date,
  last_payment_amount numeric,
  categories jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ar_aging_prop_date on public.ar_aging(property_id, as_of_date);

alter table public.ar_aging enable row level security;
create policy "ar_aging_select" on public.ar_aging
  for select using (public.can_access_property(property_id));
create policy "ar_aging_write" on public.ar_aging
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.ar_aging to authenticated;

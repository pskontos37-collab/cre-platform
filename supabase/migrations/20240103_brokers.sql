-- Brokers: the deal-sourcing relationship book (distinct from brokerage_agreements,
-- which tracks our own listing/engagement contracts). Deals attribute to a broker
-- by matching the free-text pipeline_deals.broker to a broker's name/firm, so no FK
-- or backfill is needed. Admin / asset-manager only; anon locked out by default
-- privileges (migration 20240098).

create table if not exists public.brokers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  firm text,
  email text,
  phone text,
  markets text[] not null default '{}',
  asset_types text[] not null default '{}',
  status text not null default 'active',   -- active / prospect / dormant
  last_contact_date date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brokers enable row level security;
create policy "brokers_select" on public.brokers
  for select using (public.is_admin_or_am());
create policy "brokers_write" on public.brokers
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.brokers to authenticated;

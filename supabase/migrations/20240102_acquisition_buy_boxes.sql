-- Acquisition buy-boxes: the firm's target criteria for sourcing. Deals are
-- scored against these (src/lib/buyBox.ts) to surface on-strategy vs off-strategy
-- flow. Admin / asset-manager only, like the rest of the pipeline. anon holds no
-- privileges (default-privilege lockdown, migration 20240098).

create table if not exists public.acquisition_buy_boxes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  asset_types text[] not null default '{}',
  risk_profiles text[] not null default '{}',
  states text[] not null default '{}',
  markets text[] not null default '{}',
  min_price numeric,
  max_price numeric,
  min_gla numeric,
  max_gla numeric,
  min_going_in_cap numeric,
  max_going_in_cap numeric,
  min_irr numeric,
  min_equity_multiple numeric,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.acquisition_buy_boxes enable row level security;
create policy "acq_buy_boxes_select" on public.acquisition_buy_boxes
  for select using (public.is_admin_or_am());
create policy "acq_buy_boxes_write" on public.acquisition_buy_boxes
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.acquisition_buy_boxes to authenticated;

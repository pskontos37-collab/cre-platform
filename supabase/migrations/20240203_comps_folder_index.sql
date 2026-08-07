-- 20240203_comps_folder_index
-- "Have we looked at this before?" — one row per acquisition deal folder from
-- the K:\ASSTMGMT\ACQUISITIONS inventory (2,532 property folders; only 1,013
-- have CF models loaded into comps, so 1,519 prior looks are invisible to the
-- comps DB). This index makes every folder searchable from /pipeline: file
-- counts by class, year span, and a link to comps.source_property when that
-- folder's assumptions are loaded. Loader: scripts/load_folder_index.ps1
-- (aggregates acq_inventory.csv; re-run after a fresh inventory scan).
-- Ranked #1 of the also-valuable corpus ideas ("cheapest, immediate payoff").
create table comps.folder_index (
  id uuid primary key,
  market text not null,
  folder_name text not null,
  norm_name text not null,
  n_files int not null default 0,
  total_mb numeric not null default 0,
  first_year int,
  last_year int,
  n_cf_models int not null default 0,
  n_oms int not null default 0,
  n_rent_rolls int not null default 0,
  n_lease_docs int not null default 0,
  n_argus int not null default 0,
  source_property_id uuid references comps.source_property(id),
  inventoried_at date not null,
  created_at timestamptz not null default now(),
  unique (market, folder_name)
);

alter table comps.folder_index enable row level security;
create policy folder_index_select on comps.folder_index
  for select using (is_admin_or_am());
-- writes come from the service-role loader only (RLS bypassed); no write policies.

grant select on comps.folder_index to authenticated;
revoke all on comps.folder_index from anon;
grant all on comps.folder_index to service_role;

create index folder_index_norm_idx on comps.folder_index (norm_name);
create index folder_index_market_idx on comps.folder_index (market);

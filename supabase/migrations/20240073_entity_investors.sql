-- ============================================================
-- Per-investor rosters for the M&J syndication entities (Layer 2)
-- Source: quarterly Distribution Workbook entity tabs.
-- ============================================================

create table if not exists entity_investors (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id) on delete cascade,
  name       text not null,
  unit_class text not null default 'A',
  units      numeric not null,
  notes      text,
  created_at timestamptz not null default now(),
  unique (deal_id, name, unit_class)
);

create index if not exists idx_entity_investors_deal on entity_investors (deal_id);

alter table entity_investors enable row level security;

create policy "entity_investors_admin_am_read" on entity_investors
  for select to authenticated using (is_admin_or_am());

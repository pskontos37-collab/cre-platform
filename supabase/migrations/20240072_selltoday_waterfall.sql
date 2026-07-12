-- ============================================================
-- Sell-today waterfall: dated capital flows + deal-level config
-- ============================================================

-- Equity-multiple cap: a promote tier is satisfied at the LESSER of hurdle_irr
-- and hurdle_em × contributed capital (e.g. Knightdale L2: 12% IRR or 1.75x).
alter table waterfall_tiers add column if not exists hurdle_em numeric;

-- 1 = property-level JV waterfall, 2 = M&J investor-syndication entity.
alter table deals add column if not exists layer smallint;

-- Sell-today defaults and agreement quirks, e.g.:
-- { "gross_value": 87000000, "closing_cost_pct": 0.02, "nca": 0,
--   "payoff": 34000000, "payoff_label": "MetLife mortgage payoff",
--   "freeze_date": "2025-06-30",
--   "override": { "threshold": 73000000, "lp": 0.75, "gp": 0.25 },
--   "cash_split": { "lp": 0.9, "gp": 0.1 },
--   "entity_cash": 249550.50, "units": { "A": 2800, "B": 100 } }
alter table deals add column if not exists selltoday jsonb;

-- One row per dated capital flow per party per deal (contributions negative,
-- distributions positive) — the input the IRR-hurdle engine runs on.
create table if not exists capital_flows (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id) on delete cascade,
  party      text not null,   -- display name, e.g. 'MetLife / URS', 'Class A Members'
  role       text not null check (role in ('lp','gp','class_a','class_ac','class_b','class_c','class_d')),
  flow_date  date not null,
  amount     numeric not null,
  source     text,            -- provenance, e.g. 'PS Samples.xlsx', 'MRI GL 302100'
  notes      text,
  created_at timestamptz not null default now()
);

create index if not exists idx_capital_flows_deal on capital_flows (deal_id, role, flow_date);

alter table capital_flows enable row level security;

-- Same visibility as the rest of the JV/capital stack: admin + asset managers only.
create policy "capital_flows_admin_am_read" on capital_flows
  for select to authenticated using (is_admin_or_am());

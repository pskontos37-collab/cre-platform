-- ============================================================
-- GROUP D: Capital Stack & Waterfall
-- ============================================================

create table funds (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  fund_type    text not null default 'equity',
  vintage_year integer,
  target_return numeric,
  notes        text,
  created_at   timestamptz not null default now()
);

create table investors (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  entity_type  investor_entity_type not null default 'lp',
  contact_info jsonb,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table deals (
  id                      uuid primary key default uuid_generate_v4(),
  property_id             uuid not null references properties(id) on delete restrict,
  fund_id                 uuid references funds(id) on delete set null,
  name                    text not null,
  closing_date            date,
  total_equity            numeric,
  gp_equity               numeric,
  lp_equity               numeric,
  preferred_equity_amount numeric,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Per-deal waterfall structure. tier_order = 1 is paid first.
create table waterfall_tiers (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  tier_order    integer not null,
  tier_type     waterfall_tier_type not null,
  description   text,
  hurdle_irr    numeric,
  pref_rate     numeric,
  lp_split_pct  numeric,
  gp_split_pct  numeric,
  is_cumulative boolean not null default true,
  is_pik        boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (deal_id, tier_order)
);

create table preferred_equity_positions (
  id               uuid primary key default uuid_generate_v4(),
  deal_id          uuid not null references deals(id) on delete cascade,
  investor_id      uuid not null references investors(id) on delete restrict,
  principal_amount numeric not null,
  preferred_rate   numeric not null,
  is_pik           boolean not null default false,
  accrued_return   numeric not null default 0,
  redemption_date  date,
  is_redeemed      boolean not null default false,
  priority_rank    integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table capital_accounts (
  id                   uuid primary key default uuid_generate_v4(),
  deal_id              uuid not null references deals(id) on delete cascade,
  investor_id          uuid not null references investors(id) on delete restrict,
  account_type         capital_account_type not null default 'common_equity',
  initial_contribution numeric not null,
  current_balance      numeric not null,
  contributed_to_date  numeric not null default 0,
  distributed_to_date  numeric not null default 0,
  pref_accrued_to_date numeric not null default 0,
  is_pref_redeemed     boolean not null default false,
  opened_at            date not null,
  closed_at            date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table distributions (
  id                 uuid primary key default uuid_generate_v4(),
  deal_id            uuid not null references deals(id) on delete restrict,
  distribution_date  date not null,
  total_available    numeric not null,
  waterfall_snapshot jsonb,
  created_at         timestamptz not null default now()
);

create table distribution_line_items (
  id                 uuid primary key default uuid_generate_v4(),
  distribution_id    uuid not null references distributions(id) on delete cascade,
  capital_account_id uuid not null references capital_accounts(id) on delete restrict,
  waterfall_tier_id  uuid references waterfall_tiers(id) on delete set null,
  investor_id        uuid not null references investors(id) on delete restrict,
  amount             numeric not null,
  tier_type          waterfall_tier_type,
  notes              text,
  created_at         timestamptz not null default now()
);

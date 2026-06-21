-- ============================================================
-- GROUP A: Portfolio & Properties
-- ============================================================

create table portfolios (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table properties (
  id                uuid primary key default uuid_generate_v4(),
  portfolio_id      uuid references portfolios(id) on delete restrict,
  name              text not null,
  address           text,
  city              text,
  state             text,
  zip               text,
  asset_type        asset_type not null,
  total_sf          numeric,
  year_built        integer,
  acquisition_date  date,
  acquisition_price numeric,
  current_value     numeric,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table units (
  id          uuid primary key default uuid_generate_v4(),
  property_id uuid not null references properties(id) on delete cascade,
  unit_number text not null,
  floor       text,
  rentable_sf numeric,
  usable_sf   numeric,
  unit_type   text,
  is_anchor   boolean not null default false,
  status      unit_status not null default 'vacant',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

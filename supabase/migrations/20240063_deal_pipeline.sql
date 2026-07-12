-- 20240063_deal_pipeline.sql
-- ACQUISITION DEAL PIPELINE (v2) — the pre-close complement to `transactions`,
-- modeled on the firm's Deal Tracking Sheet (Aquisition Pipeline / Partner
-- Tracking / OM Tracking tabs).
--
-- A deal moves from first look (often "waiting on OM") through underwriting, LOI,
-- under-contract/DD and close. On CLOSE, one RPC (close_pipeline_deal) spawns the
-- owned-asset shells — a `properties` row + a `transactions` acquisition row — so
-- nothing is re-keyed between "deal we're chasing" and "asset we own".
--
-- Four tables:
--   pipeline_deals      one row per live deal (team, submarket, investment
--                       profile = risk × asset, guidance/price, partner ...).
--   capital_partners    the LP mandate book (return target, leverage, deal size,
--                       markets, hold, fee, relationship manager, tier).
--   pipeline_deal_lps   per-deal capital-raise funnel (teaser -> committed).
--   om_intake           the OM-request workflow + AI extraction provenance.
--
-- NOTE the name: there is ALREADY a `deals` table (capital-waterfall modeling,
-- migration 20240006). This is deliberately `pipeline_deals` to avoid collision.
--
-- Access: deal + capital data is sensitive (like /transactions, /waterfall) so
-- read AND write are gated to admin / asset_manager via is_admin_or_am(). The
-- page is registered `restricted` in src/lib/pages.ts.

-- ── pipeline_deals ───────────────────────────────────────────────────────────
create table if not exists public.pipeline_deals (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  -- Investment Profile = asset type × risk profile (the firm's core taxonomy).
  -- 'mixed'/'industrial' allowed here even though the asset_type enum is
  -- retail|office; the close RPC maps them to retail when spawning the property.
  asset_type text not null default 'retail'
    check (asset_type in ('retail','office','mixed','industrial')),
  risk_profile text not null default 'value_add'
    check (risk_profile in ('core','core_plus','value_add','opportunistic')),
  sub_type text,                         -- grocery-anchored | power center | CBD office | MOB ...
  submarket text,                        -- CBD | Suburban | Urban (free text; matches the sheet)
  team text[] not null default '{}',     -- deal-team members (initials, matches the sheet's Team col)
  market text,                           -- metro
  city text,
  state text,
  address text,
  gla_sf numeric,
  year_built integer,

  stage text not null default 'sourced'
    check (stage in (
      'sourced','screening','underwriting','loi','under_contract',
      'dd','ic_approval','closing','closed','passed','dead','lost')),
  deal_source text                       -- how it came to us (off-market win-rate matters)
    check (deal_source in ('marketed','off_market')),
  broker text,
  seller text,                           -- counterparty on the sell side
  deal_lead uuid references public.users(id) on delete set null,
  partner text,                          -- quick LP label from the sheet ("MetLife / URS"); structured funnel = pipeline_deal_lps

  ask_price numeric,                     -- when a single number is known
  price_text text,                       -- ranges / PSF / notes ("$35-40M", "$250 PSF", "Need $32MM")
  going_in_cap numeric,                  -- decimal (0.065 = 6.5%)
  equity_required numeric,               -- LP equity to raise; drives weighted pipeline
  total_capitalization numeric,
  probability numeric not null default 0.10
    check (probability >= 0 and probability <= 1),
  target_close_date date,
  bid_text text,                         -- free-text bid timing ("Jul 15", "Early Nov", "Off-Market")
  thesis text,

  -- underwriting snapshot (returns the IC and LPs see)
  proj_irr numeric,
  equity_multiple numeric,
  avg_coc numeric,
  hold_years numeric,
  exit_cap numeric,
  stabilized_yield numeric,

  lost_reason text,

  -- populated by close_pipeline_deal()
  property_id uuid references public.properties(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pipeline_deals_stage on public.pipeline_deals(stage);
create index if not exists pipeline_deals_lead on public.pipeline_deals(deal_lead);
create index if not exists pipeline_deals_target_close on public.pipeline_deals(target_close_date);

-- ── capital_partners (LP mandate book — from Partner Tracking) ────────────────
create table if not exists public.capital_partners (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  tier text not null default 'tier1_prospect'
    check (tier in ('current','tier1_prospect','tier2_prospect')),
  partner_type text
    check (partner_type in (
      'insurance','pension','endowment','sovereign','fund_of_funds',
      'family_office','private_equity','reit','other')),
  product_types text[] not null default '{}',   -- {'retail','office','mixed','industrial'}
  markets text,                          -- prose ("Smile states", "Top-25 coastal + CHI")
  return_target text,                    -- "17%+" (kept as text — the sheet uses ranges/notes)
  leverage text,                         -- "50-60%"
  deal_size text,                        -- "$20-100M ($7-20M eq)"
  preferred_hold text,                   -- "3-5 yr"
  fee_structure text,
  relationship_manager text,
  primary_contact text,
  -- numeric mirrors (nullable) for programmatic mandate-matching
  min_check numeric,
  max_check numeric,
  target_irr numeric,
  discretionary boolean not null default false,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists capital_partners_tier on public.capital_partners(tier);
create index if not exists capital_partners_active on public.capital_partners(active);

-- ── pipeline_deal_lps (per-deal capital-raise funnel) ────────────────────────
create table if not exists public.pipeline_deal_lps (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid not null references public.pipeline_deals(id) on delete cascade,
  partner_id uuid not null references public.capital_partners(id) on delete cascade,
  status text not null default 'identified'
    check (status in ('identified','teaser_sent','reviewing','soft_circle','committed','passed')),
  soft_amount numeric,
  committed_amount numeric,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (deal_id, partner_id)
);
create index if not exists pipeline_deal_lps_deal on public.pipeline_deal_lps(deal_id);
create index if not exists pipeline_deal_lps_partner on public.pipeline_deal_lps(partner_id);

-- ── om_intake (OM-request workflow + AI extraction) ──────────────────────────
-- Mirrors the OM Tracking tab, plus a jsonb slot for the om-extract edge fn's
-- structured read of the offering memorandum. deal_id is nullable — an OM is
-- often tracked before a deal row exists.
create table if not exists public.om_intake (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid references public.pipeline_deals(id) on delete set null,
  requestor text,
  deal_name text not null,
  city text,
  state text,
  offer_due_date date,
  date_requested date default current_date,
  om_received boolean not null default false,
  base_model text not null default 'none'
    check (base_model in ('none','partial','complete')),
  spoke_to_broker boolean not null default false,
  taxes_updated boolean not null default false,
  comments text,
  -- the om-extract edge fn's structured output (fields + key points + open Qs)
  extracted jsonb,
  source_document_id uuid references public.documents(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists om_intake_deal on public.om_intake(deal_id);

-- ── close_pipeline_deal(): the automatic hand-off ────────────────────────────
create or replace function public.close_pipeline_deal(
  p_deal_id uuid,
  p_close_date date default current_date,
  p_final_price numeric default null,
  p_portfolio_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d           public.pipeline_deals%rowtype;
  v_asset     asset_type;
  v_price     numeric;
  v_close     date;
  v_prop_id   uuid;
  v_txn_id    uuid;
begin
  if not public.is_admin_or_am() then
    raise exception 'not authorized to close deals';
  end if;

  -- the client passes p_close_date explicitly (which overrides the SQL default
  -- even when null), so coalesce here to guarantee a non-null close date.
  v_close := coalesce(p_close_date, current_date);

  select * into d from public.pipeline_deals where id = p_deal_id;
  if not found then
    raise exception 'deal % not found', p_deal_id;
  end if;
  if d.stage = 'closed' or d.property_id is not null then
    raise exception 'deal % is already closed', p_deal_id;
  end if;

  -- the asset_type enum has only retail|office; mixed/industrial -> retail
  -- (portfolio is ~80% retail).
  v_asset := (case when d.asset_type = 'office' then 'office' else 'retail' end)::asset_type;
  v_price := coalesce(p_final_price, d.ask_price);

  -- 1. property shell
  insert into public.properties (
    portfolio_id, name, address, city, state, asset_type, total_sf,
    year_built, acquisition_date, acquisition_price, notes
  ) values (
    p_portfolio_id, d.name, d.address, d.city, d.state, v_asset, d.gla_sf,
    d.year_built, v_close, v_price,
    'Onboarded from deal pipeline' ||
      case when d.thesis is not null then ' — ' || d.thesis else '' end
  )
  returning id into v_prop_id;

  -- ownership_type was added outside the migration history; set it if present.
  begin
    execute format(
      'update public.properties set ownership_type = %L where id = %L',
      'owned', v_prop_id);
  exception
    when undefined_column then null;
  end;

  -- 2. transaction + property link
  insert into public.transactions (
    primary_property_id, type, close_date, counterparty, narrative
  ) values (
    v_prop_id, 'acquisition', v_close, d.seller, d.thesis
  )
  returning id into v_txn_id;

  insert into public.transaction_properties (transaction_id, property_id, is_primary)
  values (v_txn_id, v_prop_id, true);

  -- 3. contract-price figure (when known)
  if v_price is not null then
    insert into public.transaction_figures (transaction_id, label, value, basis, sort_order)
    values (v_txn_id, 'contract_price', v_price, 'final', 0);
  end if;

  -- 4. stamp the deal closed
  update public.pipeline_deals
     set stage          = 'closed',
         property_id    = v_prop_id,
         transaction_id = v_txn_id,
         updated_at     = now()
   where id = p_deal_id;

  return jsonb_build_object('property_id', v_prop_id, 'transaction_id', v_txn_id);
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.pipeline_deals enable row level security;
create policy "pipeline_deals_select" on public.pipeline_deals
  for select using (public.is_admin_or_am());
create policy "pipeline_deals_write" on public.pipeline_deals
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.pipeline_deals to authenticated;

alter table public.capital_partners enable row level security;
create policy "capital_partners_select" on public.capital_partners
  for select using (public.is_admin_or_am());
create policy "capital_partners_write" on public.capital_partners
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.capital_partners to authenticated;

alter table public.pipeline_deal_lps enable row level security;
create policy "pipeline_deal_lps_select" on public.pipeline_deal_lps
  for select using (public.is_admin_or_am());
create policy "pipeline_deal_lps_write" on public.pipeline_deal_lps
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.pipeline_deal_lps to authenticated;

alter table public.om_intake enable row level security;
create policy "om_intake_select" on public.om_intake
  for select using (public.is_admin_or_am());
create policy "om_intake_write" on public.om_intake
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.om_intake to authenticated;

-- close_pipeline_deal is SECURITY DEFINER + self-checks the role.
revoke all on function public.close_pipeline_deal(uuid, date, numeric, uuid) from public;
grant execute on function public.close_pipeline_deal(uuid, date, numeric, uuid) to authenticated;

-- ── audit ────────────────────────────────────────────────────────────────────
create trigger audit_pipeline_deals
  after insert or update or delete on public.pipeline_deals
  for each row execute procedure public.log_mutation();

notify pgrst, 'reload schema';

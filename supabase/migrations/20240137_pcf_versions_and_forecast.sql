-- 20240137_pcf_versions_and_forecast
-- PCF Phase 4: the interaction layer - versions, forecast cells, and the resolved grid.
--
-- THREE DECISIONS BY THE USER 2026-07-27 that this migration implements literally:
--
--  (1) "Analyst drives, app does arithmetic." Forward months seed from the approved budget and
--      then STAY PUT. Nothing re-derives a forward number on its own; closing a month does not
--      re-forecast the months after it. Every stored forward value is a row someone can see and
--      change, with a method recording where it came from.
--
--  (2) Cash convention is a PER-PROPERTY setting, because the firm's own two PCFs disagree:
--      Providence opened January at a real bank balance, KM East opened at 0 and tracked
--      cumulative cash generated (its 2,847,838 has no relationship to any bank account).
--      Both are legitimate; they are NOT the same number and must never be added together.
--
--  (3) Immutable monthly snapshot. Publishing freezes a version; next month starts as a copy.
--      Required, not just tidy: the reference workbook's distributions comparison pulls from the
--      PRIOR PCF, so prior versions are referenced by later ones.
--
-- THE BALANCE-SHEET CARVE-OUT (user, same conversation). Measured first: of the canonical lines
-- carrying GL activity since 2024, 67 have no budget line to seed from, and 35 of those are
-- balance_sheet plus 4 equity - i.e. the accrual->cash BRIDGE, the part that makes this a cash
-- flow rather than a P&L, is exactly the part MRI BF_PROFORMD budgets do not carry (Magnolia 42%
-- blank, Gateway 19%). Hand-keying 12 months x 35 lines x 4 properties is data entry, not
-- analysis, and it is where fatigue errors would land. So balance-sheet and equity lines seed
-- from a DERIVED SCHEDULE instead of blank - see v_pcf_bs_schedule_proposal below. Judgment
-- sections (income, opex, capital, non_operating) stay analyst-driven per decision (1).

-- ============================================================
-- 1. Per-property cash convention
-- ============================================================
alter table public.properties
  add column if not exists pcf_cash_basis text;
alter table public.properties
  drop constraint if exists properties_pcf_cash_basis_check;
alter table public.properties
  add constraint properties_pcf_cash_basis_check
  check (pcf_cash_basis is null or pcf_cash_basis in ('bank_balance','cumulative'));

comment on column public.properties.pcf_cash_basis is
  'How this property''s PCF states cash. bank_balance = opens at a real balance, ending cash is checkable against a statement (Providence). cumulative = opens at 0 and tracks cash generated (KM East). Null = not yet decided; the PCF will refuse to publish. NEVER sum ending cash across the two.';

-- ============================================================
-- 2. pcf_versions - the immutable monthly snapshot
-- ============================================================
create table if not exists public.pcf_versions (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  fiscal_year   int  not null,
  -- last CLOSED month: actuals run 1..as_of_month, forecast runs as_of_month+1..12.
  -- 0 is legal and means a pure budget-year PCF with nothing closed yet.
  as_of_month   int  not null check (as_of_month between 0 and 12),
  status        text not null default 'draft' check (status in ('draft','published')),
  -- snapshotted onto the version, NOT read live from properties: a published PCF must keep
  -- meaning what it meant when it was distributed, even if the property setting changes later.
  cash_basis    text check (cash_basis in ('bank_balance','cumulative')),
  opening_cash  numeric,
  published_at  timestamptz,
  published_by  uuid references public.users(id),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  unique (property_id, fiscal_year, as_of_month)
);
create index if not exists pcf_versions_property on public.pcf_versions(property_id, fiscal_year);

-- A published version is frozen and must carry the convention it was published under.
-- bank_basis additionally requires an opening balance or "ending cash" means nothing.
alter table public.pcf_versions drop constraint if exists pcf_versions_published_complete;
alter table public.pcf_versions add constraint pcf_versions_published_complete
  check (
    status = 'draft'
    or (cash_basis is not null
        and published_at is not null
        and (cash_basis = 'cumulative' or opening_cash is not null))
  );

alter table public.pcf_versions enable row level security;
create policy "pcf_versions_select" on public.pcf_versions for select
  using (public.can_access_property(property_id));
create policy "pcf_versions_write" on public.pcf_versions for all
  using (public.is_admin_or_am());
grant select, insert, update, delete on public.pcf_versions to authenticated;
revoke all on public.pcf_versions from anon;

-- ============================================================
-- 3. pcf_forecast_cells - every forward month value
-- ============================================================
-- One storage shape for all sections; `method` records where the number came from. That is what
-- keeps decision (1) honest: a seeded value and a hand-typed value are the same kind of row, both
-- visible, both editable, and the UI can always say which is which.
create table if not exists public.pcf_forecast_cells (
  id           uuid primary key default uuid_generate_v4(),
  version_id   uuid not null references public.pcf_versions(id) on delete cascade,
  line_key     text not null references public.pcf_lines(line_key),
  period_month int  not null check (period_month between 1 and 12),
  amount       numeric not null,
  method       text not null default 'manual'
                 check (method in ('budget','manual','derived_schedule','carried')),
  -- provenance for a derived value: which fiscal year the schedule was taken from
  derived_from_year int,
  note         text,
  author_id    uuid references public.users(id),
  updated_at   timestamptz not null default now(),
  unique (version_id, line_key, period_month)
);
create index if not exists pcf_forecast_cells_version on public.pcf_forecast_cells(version_id);

alter table public.pcf_forecast_cells enable row level security;
create policy "pcf_forecast_cells_select" on public.pcf_forecast_cells for select
  using (exists (select 1 from public.pcf_versions v
                 where v.id = version_id and public.can_access_property(v.property_id)));
create policy "pcf_forecast_cells_write" on public.pcf_forecast_cells for all
  using (public.is_admin_or_am());
grant select, insert, update, delete on public.pcf_forecast_cells to authenticated;
revoke all on public.pcf_forecast_cells from anon;

-- A published version is immutable. Enforced in the database, not the UI, because the whole
-- point of decision (3) is being able to answer "what did we tell the partner in July".
create or replace function public.pcf_block_published_edit() returns trigger
language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select status into st from public.pcf_versions
   where id = coalesce(new.version_id, old.version_id);
  if st = 'published' then
    raise exception 'PCF version is published and cannot be edited; create the next month''s version instead';
  end if;
  return coalesce(new, old);
end $$;

-- Anon-lockdown posture (mig 20240093/95/98): a plain revoke from anon is not enough, the
-- default PUBLIC grant has to go too. Belt-and-braces here - a trigger function returning
-- `trigger` is not RPC-callable - but the convention is uniform for a reason.
revoke execute on function public.pcf_block_published_edit() from public, anon;
grant  execute on function public.pcf_block_published_edit() to authenticated, service_role;

drop trigger if exists pcf_forecast_cells_immutable on public.pcf_forecast_cells;
create trigger pcf_forecast_cells_immutable
  before insert or update or delete on public.pcf_forecast_cells
  for each row execute function public.pcf_block_published_edit();

-- ============================================================
-- 4. v_pcf_line_coverage - does this line have a budget seed?
-- ============================================================
-- Drives the "no budget coverage" hint in the UI. A line the property genuinely has (GL activity)
-- but the budget never mentions must read as UNSEEDED, not as zero - a silent zero in the bridge
-- is how a cash flow quietly stops tying.
create or replace view public.v_pcf_line_coverage
with (security_invoker = true) as
with gl as (
  select distinct property_id, line_key from public.v_pcf_gl_lines
),
bud as (
  select distinct property_id, line_key from public.v_pcf_budget_lines
)
select coalesce(g.property_id, b.property_id) as property_id,
       coalesce(g.line_key,    b.line_key)    as line_key,
       (b.line_key is not null) as has_budget_seed,
       (g.line_key is not null) as has_gl_history
from gl g
full join bud b
  on b.property_id = g.property_id and b.line_key = g.line_key;

grant select on public.v_pcf_line_coverage to authenticated;

-- ============================================================
-- 5. v_pcf_bs_schedule_proposal - the balance-sheet carve-out
-- ============================================================
-- Seasonal-naive by design: month m is proposed as the SAME MONTH of the most recent complete
-- fiscal year, for balance_sheet and equity lines only. Deliberately NOT a pattern detector -
-- taking last year's actual shape reproduces the real behaviour without inventing a model.
-- Property Taxes Payable 2192-00 falls straight out of it (accrues ~35,218/mo, pays -387,402 in
-- December) because that is literally what the account did.
-- It is a PROPOSAL: the seed routine writes it as method='derived_schedule' and every cell stays
-- editable, so decision (1) still holds - the analyst can always overrule it.
create or replace view public.v_pcf_bs_schedule_proposal
with (security_invoker = true) as
with complete_years as (
  -- a fiscal year is complete when all 12 months carry GL activity for that property
  select property_id, period_year
  from public.v_pcf_gl_lines
  group by property_id, period_year
  having count(distinct period_month) = 12
),
latest as (
  select property_id, max(period_year) as src_year
  from complete_years group by property_id
)
select g.property_id,
       g.line_key,
       g.period_month,
       sum(g.amount) as amount,
       l.src_year    as derived_from_year
from public.v_pcf_gl_lines g
join latest l on l.property_id = g.property_id and l.src_year = g.period_year
join public.pcf_lines pl on pl.line_key = g.line_key
where pl.section in ('balance_sheet','equity')
group by g.property_id, g.line_key, g.period_month, l.src_year;

grant select on public.v_pcf_bs_schedule_proposal to authenticated;

-- ============================================================
-- 6. v_pcf_grid - the resolved grid behind the screen
-- ============================================================
-- One row per version x line x month, with the ACTUAL/FORECAST boundary applied:
--   month <= as_of_month -> actual, summed from the GL
--   month >  as_of_month -> forecast, from pcf_forecast_cells (absent = genuinely unset, so
--                           amount stays NULL rather than 0 - the UI must show the difference)
-- Cash-section lines are excluded: ending cash is DERIVED from the roll, never entered.
create or replace view public.v_pcf_grid
with (security_invoker = true) as
with months as (select generate_series(1,12) as period_month),
scope as (
  -- lines worth showing for a property: it has budget coverage or real GL history
  select distinct v.id as version_id, v.property_id, v.fiscal_year, v.as_of_month, c.line_key
  from public.pcf_versions v
  join public.v_pcf_line_coverage c on c.property_id = v.property_id
),
actuals as (
  select property_id, period_year, period_month, line_key, sum(amount) as amount
  from public.v_pcf_gl_lines
  group by property_id, period_year, period_month, line_key
)
select s.version_id,
       s.property_id,
       s.fiscal_year,
       s.line_key,
       pl.section,
       pl.subsection,
       pl.label,
       pl.sort_order,
       pl.is_non_cash,
       m.period_month,
       (m.period_month <= s.as_of_month) as is_actual,
       case when m.period_month <= s.as_of_month then a.amount else f.amount end as amount,
       case when m.period_month <= s.as_of_month then 'actual' else f.method end as method,
       f.note,
       f.derived_from_year,
       cov.has_budget_seed
from scope s
cross join months m
join public.pcf_lines pl on pl.line_key = s.line_key
left join actuals a
  on a.property_id = s.property_id and a.period_year = s.fiscal_year
 and a.period_month = m.period_month and a.line_key = s.line_key
left join public.pcf_forecast_cells f
  on f.version_id = s.version_id and f.line_key = s.line_key and f.period_month = m.period_month
left join public.v_pcf_line_coverage cov
  on cov.property_id = s.property_id and cov.line_key = s.line_key
where pl.section <> 'cash';

grant select on public.v_pcf_grid to authenticated;

-- ============================================================
-- 7. The roll-up guard
-- ============================================================
-- Ending cash under 'bank_balance' and under 'cumulative' are different quantities. Summing them
-- produces a number that looks like portfolio cash and is not. This view groups BY basis so a
-- caller cannot get a single total by accident; a mixed portfolio comes back as two rows.
create or replace view public.v_pcf_portfolio_cash
with (security_invoker = true) as
select v.fiscal_year,
       v.cash_basis,
       count(*)                                  as properties,
       sum(coalesce(v.opening_cash,0))           as opening_cash,
       string_agg(p.name, ', ' order by p.name)  as property_names
from public.pcf_versions v
join public.properties p on p.id = v.property_id
where v.status = 'published'
group by v.fiscal_year, v.cash_basis;

grant select on public.v_pcf_portfolio_cash to authenticated;

comment on view public.v_pcf_portfolio_cash is
  'Portfolio cash grouped BY cash_basis on purpose. bank_balance and cumulative ending cash are different quantities - a mixed portfolio returns two rows and must never be collapsed into one total.';

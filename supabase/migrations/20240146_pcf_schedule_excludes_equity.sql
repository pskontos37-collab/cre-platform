-- 20240146_pcf_schedule_excludes_equity
-- Narrow the balance-sheet carve-out: seed balance_sheet ONLY, never equity.
--
-- FOUND BY THE FIRST LIVE UI TEST (2026-07-28). Gateway's projected ending cash ran negative
-- all year and then jumped to +12.9M in November. The driver was
--   eq_contributions  +15,692,334  method='derived_schedule'
-- i.e. the seasonal-naive seed faithfully repeating a ONE-TIME November 2025 capital
-- contribution into November 2026. bs_mortgage_principal showed +596,812 the same month
-- (positive = cash IN, so that November also held a draw or refi) - likewise non-recurring.
--
-- The seed did exactly what mig 20240138 specified. The SPECIFICATION was wrong for equity.
-- The carve-out's whole justification was that balance-sheet deltas are MECHANICAL: a payable
-- accrues every month and pays out on a schedule, so last year's shape is a fair prior
-- (Property Taxes Payable: +35,219/mo, -387,404 in December). Capital contributions and
-- distributions are the opposite - discretionary, lumpy, decided by the partnership. Repeating
-- one forward is not a forecast, it is an invented $15.7M inflow, and because it lands in the
-- cash recap it silently makes the whole year's ending cash wrong.
--
-- Equity now seeds from NOTHING and stays blank for the analyst, which is the honest state:
-- the budget seed already excludes equity, so the two equity lines are simply unset and the
-- grid renders them as em dashes rather than as a confident wrong number. That is only 4 lines
-- of extra entry, and they are exactly the 4 where a human decision is the point.
--
-- Everything else about the carve-out is unchanged: balance_sheet lines still seed
-- seasonal-naive from the most recent COMPLETE fiscal year.

create or replace view public.v_pcf_bs_schedule_proposal
with (security_invoker = true) as
with complete_years as (
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
-- equity DELIBERATELY excluded - see the header. Was in ('balance_sheet','equity').
where pl.section = 'balance_sheet'
group by g.property_id, g.line_key, g.period_month, l.src_year;

grant select on public.v_pcf_bs_schedule_proposal to authenticated;

comment on view public.v_pcf_bs_schedule_proposal is
  'Seasonal-naive seed for BALANCE_SHEET lines only: month m = same month of the most recent complete fiscal year. Equity is excluded on purpose (mig 20240146) - contributions and distributions are discretionary capital events, and repeating one forward invents cash. Equity stays blank for the analyst.';

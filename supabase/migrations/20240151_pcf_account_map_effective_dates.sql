-- 20240151_pcf_account_map_effective_dates
-- Give pcf_account_map a time dimension, because an account's MEANING can change.
--
-- THE CASE THAT FORCED IT. Gateway's 188900 "Acquisition Costs" holds two different kinds of
-- entry, provable from the GL descriptions themselves:
--   2019-02   -1,368,048  "Purchase JE - Legal Morgan Lewis / Acq Fee / Title"   REAL CASH
--   2019-04   +1,368,048  "Rcls Amount per PPA"                                  reclass
--   2020-09  -172,969,918 "2019 Adjust for Master Lease JE"                      reclass
--   2025-11   -15,697,979 "Record Closing JE for Ground Lease Purch"             REAL CASH
--   2025-12      +136,959 "Reclass to acquisiton costs"                          reclass
-- Mapping the account outright fabricates -$173M of monthly cash in 2020-09 (mig 20240150).
-- Leaving it unmapped overstates a Gateway FY2025 PCF by $15,509,071 - the bridge counts
-- $13.17M of capital contributions with no offsetting use, reporting +14,196,877 of cash
-- generated when cash actually moved -1,312,193. Neither option is correct, because the
-- mapping key was account_code alone.
--
-- Now a mapping carries a half-open [effective_from, effective_to) window. NULL on either side
-- means unbounded, so every existing row keeps its current always-on behaviour untouched.

-- ============================================================
-- 1. The columns
-- ============================================================
alter table public.pcf_account_map
  add column if not exists effective_from date,
  add column if not exists effective_to   date;

alter table public.pcf_account_map drop constraint if exists pcf_account_map_effective_order;
alter table public.pcf_account_map add constraint pcf_account_map_effective_order
  check (effective_from is null or effective_to is null or effective_from < effective_to);

comment on column public.pcf_account_map.effective_from is
  'Inclusive start of the period this mapping applies to, compared against make_date(period_year, period_month, 1). NULL = unbounded.';
comment on column public.pcf_account_map.effective_to is
  'EXCLUSIVE end of the period this mapping applies to. NULL = unbounded. Half-open so consecutive windows can abut without overlapping.';

-- ============================================================
-- 2. Overlap protection
-- ============================================================
-- The old partial unique indexes enforced ONE mapping per account, which is exactly what the
-- date dimension needs to relax - but relaxing it without a replacement would let two windows
-- claim the same month, and the lateral pick below takes limit 1, so the winner would be
-- arbitrary and silent. An exclusion constraint keeps the guarantee where it matters: at most
-- one mapping per account per scope per instant.
create extension if not exists btree_gist;

drop index if exists pcf_account_map_default;
drop index if exists pcf_account_map_property;

alter table public.pcf_account_map drop constraint if exists pcf_account_map_no_overlap;
alter table public.pcf_account_map add constraint pcf_account_map_no_overlap
  exclude using gist (
    account_code with =,
    (coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    daterange(effective_from, effective_to) with &&
  );

-- ============================================================
-- 3. The views honour the window
-- ============================================================
-- Everything else inherits: pcf_grid(), v_pcf_line_coverage, v_pcf_bs_schedule_proposal and
-- v_pcf_cash_bridge_check are all built on these three.

create or replace view public.v_pcf_gl_lines
with (security_invoker = true) as
select a.property_id,
       a.period_year,
       a.period_month,
       a.account_code,
       a.account_name,
       m.line_key,
       coalesce(m.section_override, l.section) as section,
       l.subsection,
       l.label,
       l.sort_order,
       l.is_non_cash,
       l.escrow_key,
       a.cash_effect as amount
from public.v_pcf_gl_activity a
join lateral (
  select am.line_key, am.section_override
  from public.pcf_account_map am
  where am.account_code = a.account_code
    and (am.property_id = a.property_id or am.property_id is null)
    and (am.effective_from is null or make_date(a.period_year, a.period_month, 1) >= am.effective_from)
    and (am.effective_to   is null or make_date(a.period_year, a.period_month, 1) <  am.effective_to)
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_gl_lines to authenticated;

create or replace view public.v_pcf_budget_lines
with (security_invoker = true) as
select b.property_id,
       b.budget_year as period_year,
       b.period_month,
       b.account_code,
       b.account_name,
       m.line_key,
       coalesce(m.section_override, l.section) as section,
       l.subsection,
       l.label,
       l.sort_order,
       l.is_non_cash,
       l.escrow_key,
       b.amount * m.sign_factor::numeric as amount
from public.budget_lines b
join lateral (
  select am.line_key, am.sign_factor, am.section_override
  from public.pcf_account_map am
  where am.account_code = b.account_code
    and (am.property_id = b.property_id or am.property_id is null)
    and (am.effective_from is null or make_date(b.budget_year, coalesce(b.period_month,1), 1) >= am.effective_from)
    and (am.effective_to   is null or make_date(b.budget_year, coalesce(b.period_month,1), 1) <  am.effective_to)
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_budget_lines to authenticated;

-- The loud list must use the SAME window test, or an account that is mapped only outside its
-- window would vanish from both the resolved lines AND the unmapped list - invisible in both,
-- which is the one outcome this design exists to prevent.
create or replace view public.v_pcf_gl_unmapped_accounts
with (security_invoker = true) as
select a.property_id,
       a.period_year,
       a.account_code,
       min(a.account_name) as account_name,
       count(*)            as entries,
       sum(a.cash_effect)  as cash_effect
from public.v_pcf_gl_activity a
where not exists (
  select 1 from public.pcf_account_map am
  where am.account_code = a.account_code
    and (am.property_id = a.property_id or am.property_id is null)
    and (am.effective_from is null or make_date(a.period_year, a.period_month, 1) >= am.effective_from)
    and (am.effective_to   is null or make_date(a.period_year, a.period_month, 1) <  am.effective_to))
group by a.property_id, a.period_year, a.account_code;

grant select on public.v_pcf_gl_unmapped_accounts to authenticated;

-- ============================================================
-- 4. The first date-scoped mapping
-- ============================================================
-- 188900 becomes cap_acquisition from 2025-01-01 onward, which captures the ground-lease
-- purchase and leaves the 2019/2020 reclassifications unmapped and loud, exactly as they should
-- be. The 2025-12 +136,959 "Reclass to acquisiton costs" is inside the window and is accepted:
-- it is small, and splitting a single month out would need entry-level rules the schema does
-- not have.
insert into public.pcf_account_map (property_id, account_code, line_key, sign_factor, effective_from, notes)
values (null, '188900', 'cap_acquisition', 1, date '2025-01-01',
        'Date-scoped (mig 20240151): from 2025-01 this account carries the Gateway ground-lease purchase (2025-11-12, ref 122650, $14.5M funded by capital contributions). Before 2025 it also holds basis RECLASSIFICATIONS - notably 2020-09 -172,969,918 "2019 Adjust for Master Lease JE" - which are not cash and stay unmapped.')
-- bare DO NOTHING, not ON CONSTRAINT: a conflict target must name a unique index, and
-- pcf_account_map_no_overlap is an exclusion constraint. Targetless DO NOTHING does cover it.
on conflict do nothing;

-- 20240136_pcf_section_override
-- PCF Phase 3a: report placement becomes a property-level property, not a line-level one.
--
-- RULE (set by the user 2026-07-26): section placement follows EACH PROPERTY'S OWN
-- presentation, because monthly income statements are arriving and each property's NOI must
-- tie to its own statement. The same account can therefore sit above NOI at one property and
-- below it at another, and that is correct, not a bug. Account identity != report placement.
--
-- Phase 1 handled the one known case by DUPLICATING the canonical line: MR 7144-00 (Knightdale,
-- below NOI) went to `nonop_bank_fees` while TC 606300 (MRI, inside NOI) went to
-- `admin_bank_fees`. That ties each property to its own statement but costs portfolio
-- aggregation - "bank fees across the portfolio" is now two lines that must be remembered and
-- summed by hand, and every future placement disagreement would add another duplicate.
--
-- This migration replaces that with an override on the MAPPING:
--     effective section = coalesce(pcf_account_map.section_override, pcf_lines.section)
-- One `admin_bank_fees` line receives both codes; the Knightdale mapping carries an override so
-- its NOI still excludes them. Portfolio rollups get one line; per-property statements still tie.
--
-- NOT changed here: `mgmt_fee_asset` stays in non_operating. Phase 1 moved it there globally and
-- retiring that move was considered, but no property currently presents an asset-management fee
-- inside NOI, so an override would be speculative. The mechanism is now here when one does.
--
-- No account mappings are added by this migration - the 184 still-unmapped GL accounts are
-- Phase 3b. This is the schema change and the one consolidation that proves it.

-- ============================================================
-- 1. section_override on the mapping
-- ============================================================
alter table public.pcf_account_map
  add column if not exists section_override text;

-- 'cash' is deliberately EXCLUDED. v_pcf_cash_bridge_check splits on section = 'cash' vs
-- everything else to prove bridge = actual cash movement; letting an override move an account
-- into or out of the cash section would silently break that invariant rather than fail loudly.
alter table public.pcf_account_map
  drop constraint if exists pcf_account_map_section_override_check;
alter table public.pcf_account_map
  add constraint pcf_account_map_section_override_check
  check (section_override is null or section_override in
    ('income','opex','non_operating','capital','balance_sheet','equity'));

comment on column public.pcf_account_map.section_override is
  'Overrides pcf_lines.section for THIS property''s presentation of THIS account. Null = use the line''s own section. Cannot be ''cash'' - that would break the bridge invariant.';

-- ============================================================
-- 2. Views resolve the effective section
-- ============================================================
-- Both line views gain `section_override` in the lateral pick and coalesce it over the line's
-- own section. Everything downstream (NOI = income + opex, the bridge check, the escrow
-- ledgers) reads `section` from these views and so picks the override up for free.

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
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_budget_lines to authenticated;

-- sign_factor is still deliberately NOT applied here (Phase 2 RULE 2: credit - debit already is
-- the cash effect for a GL row; sign_factor is a budget-only correction).
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
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_gl_lines to authenticated;

-- ============================================================
-- 3. Retire nonop_bank_fees in favour of an override
-- ============================================================
-- 7144-00 keeps its below-NOI placement, but now as an override on the shared line rather than
-- as a line of its own. sign_factor is untouched (-1, still correct for the budget side).
update public.pcf_account_map
   set line_key = 'admin_bank_fees',
       section_override = 'non_operating',
       notes = trim(both ' ' from coalesce(notes,'') ||
         ' Presented BELOW NOI at Knightdale (MR chart) while MRI folds 606300 banking fees into'
         || ' 60xxxx inside NOI - same economic item, different report placement, so it shares'
         || ' the admin_bank_fees line and carries a section_override. (mig 20240136)')
 where account_code = '7144-00'
   and line_key = 'nonop_bank_fees';

-- Safe only because nothing else points at it. If a parallel session mapped something new to
-- nonop_bank_fees, this raises instead of silently orphaning the mapping.
do $$
declare n int;
begin
  select count(*) into n from public.pcf_account_map where line_key = 'nonop_bank_fees';
  if n > 0 then
    raise exception 'nonop_bank_fees still has % mapping(s); repoint them before dropping the line', n;
  end if;
  delete from public.pcf_lines where line_key = 'nonop_bank_fees';
end $$;

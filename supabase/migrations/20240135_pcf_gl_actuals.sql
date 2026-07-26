-- 20240135_pcf_gl_actuals.sql
-- PCF Phase 2: source the canonical PCF lines that no budget account can fill from gl_entries.
--
-- WHAT PHASE 1 LEFT OPEN
-- 20240133/34 mapped all 148 budget accounts, but 19 canonical lines had NO source account in
-- ANY budget: the 5 escrow/reserve funding lines, both equity lines, the working-capital delta
-- lines (prepaid rent, accrued expenses payable, capital items payable, mgmt fee payable,
-- security deposits, under/over-collection of recovery costs), plus util_electric_other,
-- cap_legal_leasing, nonop_other, bs_prepaid_other and bs_other. A budget forecasts NOI well
-- and the accrual-to-cash bridge badly, so those lines have to come from the general ledger.
--
-- ============================================================================
-- RULE 1 - PERIOD ACTIVITY: EXCLUDE source_code = 'BF'
-- ============================================================================
-- The MRI GENLEDG export re-books every account's opening balance as a regular January entry,
-- so each period_year is self-contained and summing years overstates balance accounts by about
-- the year count (2601-00 sums to +990,662,517 across 2014-2026 against a real balance of
-- 69,500,000). Those rows are identifiable: source_code = 'BF'.
--
-- CRITICAL: is_balance_forward IS FALSE on them. The existing flag marks a DIFFERENT, separate,
-- net-zero set of 695 null-period rows. Filtering only on is_balance_forward silently leaves
-- every opening balance in the data, which is the single easiest way to get this wrong.
--
-- source_code='BF' covers all of the year-open mechanics, every one of them non-cash:
--   "Opening Balance for Year" (3,606 rows), "Closed to retained earnings" (2,346),
--   "MM/YY Year End Net Income" (~554), "Open Year (Prior Yr Adj MM/YY)." (~47).
-- Excluding the class is what keeps prior-year P&L from reappearing as current-year activity.
--
-- VERIFIED: with (not is_balance_forward and source_code <> 'BF'), sum(debit-credit) over all
-- accounts = exactly 0.00 for every year 2014..2026 - the export is a complete trial balance.
-- Magnolia 2601-00 then reads -1,522,277.92 / -1,577,206.84 / -1,634,117.71 / -1,693,082.17 for
-- 2020-2023, -4,073,315.36 in 2024 (regular amortisation plus the November extension paydown,
-- closing at exactly the documented 69,500,000) and +80,000,000 in 2014 (the original draw).
--
-- ============================================================================
-- RULE 2 - CASH EFFECT IS (credit - debit), AND sign_factor MUST NOT BE APPLIED
-- ============================================================================
-- Because the trial balance closes, for any non-cash account (credit - debit) IS already that
-- account's effect on cash, with no per-account convention needed:
--   revenue credit -> +   expense debit -> -   capex debit -> -   escrow funding -> -
--   escrow release -> +   principal payment -> -   distribution -> -   contribution -> +
--   A/R up -> -          prepaid rent up -> +    deposits held up -> +   accrued A/P up -> +
-- That is exactly the Phase 1 canonical sign rule, so GL amounts need NO normalisation.
--
-- pcf_account_map.sign_factor exists ONLY because source BUDGET workbooks disagree with each
-- other (MRI stores capex positive, the Knightdale model negative). It is a BUDGET-side
-- correction and applying it to GL rows would corrupt them: 155300 Building Improvements carries
-- sign_factor -1 for the budget, while in the GL its additions are debits and already read
-- -2,369,584.94; multiplying by -1 would report capital spend as cash IN.
-- Therefore v_pcf_gl_lines below deliberately IGNORES sign_factor. Only v_pcf_budget_lines
-- applies it. The two views share line_key assignments and nothing else.
--
-- ============================================================================
-- RULE 3 - NON-CASH LINES MUST BE EXCLUDED IN MATCHED PAIRS
-- ============================================================================
-- is_non_cash lines belong in NOI/net income but not in the cash bridge. In a GL both halves of
-- each non-cash entry are present, so BOTH must be marked, or the bridge stops tying. The pairs
-- are exact in this data (2025-26): 7011-00 Leasing Cost Amortization -416,340.25 against
-- 1611-00 A/A Leasing Commissions +416,340.25; 7011-98 / 1631-98 at 341,052.66; 7021-00 /
-- 1621-00 at 233,138.11; 6042-00 / 1542-01 at 74,037.55; 6067-00 / 1567-00 at 14,720.76;
-- 6082-98 / 1582-00 at 3,387.26. This migration maps the accumulated-depreciation and
-- accumulated-amortisation side of every such pair it introduces.
--
-- ============================================================================
-- SCOPE - WHAT THIS MIGRATION DOES *NOT* DO (measured, not assumed)
-- ============================================================================
-- 283 of the 425 GL accounts with 2019+ activity are still unmapped. This migration fills the
-- 19 Phase 2 target lines and the machinery around them; it does NOT map the whole chart, so
-- v_pcf_cash_bridge_check will NOT read zero yet. That is intentional and visible rather than
-- hidden: the remaining accounts are mostly ordinary P&L lines that belong to Phase 3, and each
-- one is a judgement call that should be reviewed, not pattern-matched in bulk.
--
-- Two target lines have NO source in the GL either, and stay honestly unmapped:
--   bs_escrow_tax, bs_escrow_insurance, bs_escrow_tilc, bs_escrow_leasing - the Providence-style
--   escrow accounts (1013/1014/1015/1019-03/1019-04) DO NOT EXIST for any of these four
--   properties. They do not escrow through those accounts, so there is nothing to read.
--   bs_escrow_replacement likewise has no replacement-reserve account.
-- Gateway's only escrow is 109000 "Other Reserve/Escrow" (a lender NOI-shortfall wire plus a
-- lender-required Shake Shack reserve, released 06/2025), which is none of the five named
-- reserves - so this migration adds bs_escrow_other for it rather than mislabelling it.

-- (No explicit BEGIN/COMMIT: this is applied inside a transaction by apply_migration / the CLI.)

-- ============================================================
-- 1. pcf_lines gains a 'cash' section
-- ============================================================
-- The cascade needs to know which accounts ARE cash: they are excluded from the bridge and they
-- supply the CASH RECAP (beginning -> change -> ending). Holding them as mapped lines rather
-- than a hard-coded code list keeps them reviewable like every other mapping.
alter table public.pcf_lines drop constraint if exists pcf_lines_section_check;
alter table public.pcf_lines add constraint pcf_lines_section_check
  check (section in ('income','opex','non_operating','capital','balance_sheet','equity','cash'));

insert into public.pcf_lines (line_key, section, subsection, label, sort_order, is_non_cash, escrow_key) values
  ('cash_operating',  'cash', null, 'Cash - Operating Accounts',  50, false, null),
  ('cash_restricted', 'cash', null, 'Cash - Restricted',          60, false, null),
  -- a real escrow that rolls forward, but not one of the five named reserves
  ('bs_escrow_other', 'balance_sheet', null, 'Other Reserve / Escrow Funding', 1685, false, 'other_reserve')
on conflict (line_key) do nothing;

-- ============================================================
-- 2. Phase 1 correction: 149800 is an ASSET, not depreciation expense
-- ============================================================
-- 149800 "Land Improvements-Deprec" means Land Improvements, DEPRECIABLE class - its accumulated
-- counterpart is 169200 "A/D-Land Improvs-Deprecbl", and the real depreciation expense line is
-- 951300 "FA - Depreciation Exp" (already mapped to nonop_depreciation). Phase 1 matched on the
-- "-Deprec" substring and filed the asset as depreciation, which is is_non_cash - so Magnolia's
-- 364,150 of land-improvement spend is currently dropped from the cash bridge entirely.
-- Correct target is cap_site (1202-00 Site Improvements is the NNNN-NN twin of this 6-digit code).
-- sign_factor stays -1: that is the budget-side correction and is still right for the budget.
update public.pcf_account_map
   set line_key = 'cap_site',
       notes = 'Land Improvements, depreciable class - capital spend, not depreciation expense. '
               'Corrected in 20240135; Phase 1 matched the "-Deprec" substring. Real depreciation '
               'expense is 951300.'
 where account_code = '149800' and property_id is null and line_key = 'nonop_depreciation';

-- ============================================================
-- 3. GL account -> canonical line mappings
-- ============================================================
-- sign_factor is left at the default 1 for every row below and is NEVER read by the GL view
-- (see RULE 2). It is recorded only so these rows are shaped like their budget siblings.
insert into public.pcf_account_map (account_code, line_key, sign_factor, notes) values
  -- ---------- CASH (excluded from the bridge; drives the recap) ----------
  ('1001-00','cash_operating', 1,'GL: Cash - Property Oper (Magnolia, KM East/West)'),
  ('1003-00','cash_operating', 1,'GL: Cash - Money Mkt Investment'),
  ('1004-00','cash_operating', 1,'GL: Cash - Petty Cash'),
  ('1007-00','cash_operating', 1,'GL: Cash - Depository'),
  ('1008-00','cash_operating', 1,'GL: Cash - Operations'),
  ('1017-00','cash_operating', 1,'GL: Cash - Lockbox'),
  ('100600','cash_operating',  1,'GL: Petty Cash #1 (Gateway)'),
  ('102600','cash_operating',  1,'GL: Operations Account #1 (Gateway)'),
  ('103600','cash_operating',  1,'GL: Local Deposit Account (Gateway)'),
  ('106400','cash_operating',  1,'GL: Money Market Account #1 (Gateway)'),
  ('103800','cash_restricted', 1,'GL: Security Deposit Account (Gateway) - restricted, offsets 242000'),
  ('1019-05','cash_restricted',1,'GL: Cash - Tenant Reserves (Magnolia, dormant since 2015)'),
  -- 1010-00 is Knightdale's REAL operating cash account, confirmed by the data and by the user
  -- 2026-07-26: KM East/West 1007-00 "Cash - Depository" nets to exactly 0.00 for 2025 (1,891 and
  -- 881 rows in and straight back out - a pure sweep), while 1010-00 carries the entire cash
  -- movement (-2,761,025.42 East / -2,174,647.22 West). Treating it as anything else leaves both
  -- Knightdale entities reporting zero cash movement.
  ('1010-00','cash_operating', 1,'GL: Cash - Intercompany - KM East/West operating cash (1007-00 is a zero-net sweep)'),

  -- ---------- ESCROW ----------
  ('109000','bs_escrow_other', 1,'GL: Other Reserve/Escrow (Gateway) - lender NOI-shortfall wire + Shake Shack reserve'),

  -- ---------- WORKING CAPITAL: the accrual-to-cash bridge ----------
  ('1065-00','bs_under_collect',1,'GL: Under Collection of CAM Costs'),
  ('1066-00','bs_under_collect',1,'GL: Under Collect of Recov Costs'),
  ('2004-00','bs_excess_collect',1,'GL: Excess Collection of CAM Costs'),
  ('2007-00','bs_ap_capital',   1,'GL: Capital Items Payable'),
  ('203300','bs_ap_capital',    1,'GL: Payable - Capital (Gateway)'),
  ('2008-00','bs_ap_mgmt_fee',  1,'GL: Management Fee Payable'),
  ('2002-00','bs_ap_mgmt_fee',  1,'GL: A/P - Property Manager'),
  ('2091-00','bs_ap_mgmt_fee',  1,'GL: A/P - Asset Manager'),
  ('2101-00','bs_ap_accrued',   1,'GL: Accrued Expenses Payable'),
  ('2101-01','bs_ap_accrued',   1,'GL: Association Fee Accrual'),
  ('209900','bs_ap_accrued',    1,'GL: Other Accrued Expenses (Gateway)'),
  ('209600','bs_ap_accrued',    1,'GL: Accrued Interest Expense (Gateway)'),
  ('2602-00','bs_ap_accrued',   1,'GL: Accrued First Mortgage Interest'),
  ('201200','bs_ap_accrued',    1,'GL: Wages Payable (Gateway)'),
  ('210100','bs_ap_accrued',    1,'GL: Current Tax Liability (Gateway)'),
  ('2221-00','bs_security_deposits',1,'GL: Security Deposits Held'),
  ('242000','bs_security_deposits',1,'GL: Tenant Security Deposits (Gateway)'),
  ('2311-00','bs_prepaid_rent', 1,'GL: Prepaid Rent'),
  ('245100','bs_prepaid_rent',  1,'GL: Tenant Prepaid Rent (Gateway)'),

  -- ---------- PREPAIDS ----------
  ('1162-00','bs_prepaid_other',1,'GL: Prepaid Expenses'),
  ('129600','bs_prepaid_other', 1,'GL: Misc Prepaid Expenses (Gateway)'),
  ('1026-00','bs_prepaid_other',1,'GL: Prepaid Sales Taxes'),
  ('1163-00','bs_prepaid_other',1,'GL: Other Current Assets'),
  ('1027-00','bs_prepaid_other',1,'GL: Prepaid Property Taxes'),
  ('127800','bs_prepaid_other', 1,'GL: Prepaid Real Estate Taxes (Gateway)'),
  ('127100','bs_prepaid_insurance',1,'GL: Prepaid Insurance (Gateway)'),
  ('1052-00','bs_prepaid_insurance',1,'GL: Prepaid Liability Insurance'),

  -- ---------- EQUITY ----------
  ('3021-00','eq_contributions',1,'GL: Other Owners #1 Contributed Capital'),
  ('3022-00','eq_contributions',1,'GL: Other Owner''s #2 cont Cap'),
  ('3021-30','eq_contributions',1,'GL: Capital (Interco)'),
  ('300900','eq_contributions', 1,'GL: Contributions-Capital #1 (Gateway)'),
  ('309600','eq_contributions', 1,'GL: Contributions-Capital #2 (Gateway)'),
  ('3051-00','eq_distributions',1,'GL: Other Owners #1 Distributions'),
  ('3052-00','eq_distributions',1,'GL: Other Owner''s #2 Distributions'),
  ('302100','eq_distributions', 1,'GL: Distributions-Capital #1 (Gateway)'),
  ('310800','eq_distributions', 1,'GL: Distributions-Capital #2 (Gateway)'),

  -- ---------- CAPITALISED LEASING LEGAL ----------
  ('189150','cap_legal_leasing',1,'GL: Defer Lse Comm - Legal (Gateway)'),
  ('1218-00','cap_legal_leasing',1,'GL: CIP Legal Fees'),
  ('1311-01','cap_legal_leasing',1,'GL: Capitalized Leasing Costs-Other'),

  -- ---------- UTILITIES: electric-other / vacant ----------
  ('5006-00','util_electric_other',1,'GL: Electric - Non-Recoverable'),
  ('5006-01','util_vacant',        1,'GL: Vacant Electric Usage'),

  -- ---------- MORTGAGE PRINCIPAL (Magnolia's code was unmapped) ----------
  ('2601-00','bs_mortgage_principal',1,'GL: First Mortgage Payable (Magnolia) - draws AND principal'),

  -- ---------- NON-CASH: accumulated depreciation, the matched half of each pair ----------
  ('1551-00','nonop_depreciation',1,'GL: A/D Building - non-cash, pairs with 6051-98'),
  ('1542-00','nonop_depreciation',1,'GL: A/D Site Improvements'),
  ('1542-01','nonop_depreciation',1,'GL: A/D Site Improvements - Acq, pairs with 6042-00'),
  ('1552-00','nonop_depreciation',1,'GL: A/D Other Capitalized Costs'),
  ('1567-00','nonop_depreciation',1,'GL: A/D Bld Imps, pairs with 6067-00'),
  ('1581-00','nonop_depreciation',1,'GL: A/D Computer'),
  ('1582-00','nonop_depreciation',1,'GL: A/D Furniture and Fixtures, pairs with 6082-98'),
  ('169200','nonop_depreciation', 1,'GL: A/D-Land Improvs-Deprecbl (Gateway)'),
  ('173700','nonop_depreciation', 1,'GL: A/D-Building (Gateway)'),
  ('174700','nonop_depreciation', 1,'GL: A/D-Building Improvements (Gateway)'),
  ('177100','nonop_depreciation', 1,'GL: A/D-T/I-Nn-Reimb (Gateway)'),
  ('181100','nonop_depreciation', 1,'GL: A/D-Auto & Otr Motor Vehc (Gateway)'),
  ('191902','nonop_depreciation', 1,'GL: A/D - Sale (Gateway)'),
  ('6051-98','nonop_depreciation',1,'GL: Depreciation expense'),
  ('6042-00','nonop_depreciation',1,'GL: Site Improvements Depreciation'),
  ('6067-00','nonop_depreciation',1,'GL: Bld Imp Depr - Misc Improvements'),
  ('6082-98','nonop_depreciation',1,'GL: FF&E Depr - Furniture and Fixtures'),
  -- accumulated amortisation
  ('1611-00','nonop_amortization',1,'GL: A/A Leasing Commissions, pairs with 7011-00'),
  ('1621-00','nonop_amortization',1,'GL: A/A Tenant Improvements, pairs with 7021-00'),
  ('190900','nonop_amortization', 1,'GL: Acc Amor-Defer Lease Comm (Gateway)'),
  ('190700','nonop_amortization', 1,'GL: Acc Amor-Acquisition Costs (Gateway)'),
  ('191500','nonop_amortization', 1,'GL: Acc Amor-Organizatn Costs (Gateway)'),
  ('7011-00','nonop_amortization',1,'GL: Leasing Cost Amortization'),
  ('7021-00','nonop_amortization',1,'GL: Tenant Improvement Amortization'),
  -- deferred financing amortisation
  ('1631-00','nonop_interest_amort',1,'GL: A/A of Loan Acquisition Costs'),
  ('1631-98','nonop_interest_amort',1,'GL: A/A of Loan Acquisition Costs, pairs with 7011-98'),
  ('192700','nonop_interest_amort', 1,'GL: Accum Amort Cap Fin Costs (Gateway)'),
  ('7011-98','nonop_interest_amort',1,'GL: Amortization (deferred financing)'),
  -- acquired lease intangibles and their accumulated amortisation
  ('156000','lease_intangible_amort',1,'GL: In-Place Leases - Acq'),
  ('156300','lease_intangible_amort',1,'GL: Favorable Leases - Acq'),
  ('156301','lease_intangible_amort',1,'GL: Above market ground leases'),
  ('125423','lease_intangible_amort',1,'GL: Acquired Above Market-Ground Lease'),
  ('156700','lease_intangible_amort',1,'GL: Unfavorable Lease - Acq'),
  ('177200','lease_intangible_amort',1,'GL: A/A - In-Place Leases'),
  ('177300','lease_intangible_amort',1,'GL: A/A - Favorable Leases'),
  ('177301','lease_intangible_amort',1,'GL: A/A - Above Market Ground Leases'),
  ('177500','lease_intangible_amort',1,'GL: A/A - Unfavorable Leases'),
  -- straight-line / deferred rent receivable
  ('123500','rent_adjustments',1,'GL: Deferred Rent Rec-OA (Gateway)'),
  ('123503','rent_adjustments',1,'GL: Deferred Rent Rec SL Pandemic (Gateway)'),
  ('115100','rent_adjustments',1,'GL: Unbilled Rent Receivables (Gateway)'),
  ('402203','rent_adjustments',1,'GL: Deferred Rent Adj SL - Pandemic (Gateway)'),
  -- bad-debt allowance (contra-asset half of the reserve)
  ('1076-00','bad_debt_reserve',1,'GL: Allow for Uncollect Tenant Rec'),
  ('124600','bad_debt_reserve', 1,'GL: Allow Doubt Acct-Ten Recv (Gateway)'),
  ('4754-09','bad_debt_reserve',1,'GL: Bad Debt Reserve (Contra)'),
  ('4754-19','bad_debt_reserve',1,'GL: Bad Debt Reserves - Pandemic'),
  ('7136-00','bad_debt_reserve',1,'GL: Provision for Bad Debts'),
  ('873200','bad_debt_reserve', 1,'GL: Provision for Bad Debts (Gateway)'),

  -- ---------- OTHER BALANCE SHEET ----------
  ('247100','bs_other',1,'GL: Other Liabilities (Gateway)'),
  ('1083-00','bs_other',1,'GL: Due (to) from Seller'),
  ('243100','bs_other',1,'GL: Payable to Prior Owner (Gateway)'),
  ('192900','bs_other',1,'GL: Receivable from Prior Own (Gateway)'),
  ('192800','bs_other',1,'GL: Other Assets (Gateway)'),
  ('2001-00','bs_other',1,'GL: A/P - Trade'),
  ('2003-00','bs_other',1,'GL: A/P - Other'),
  ('2003-01','bs_other',1,'GL: Free Rent Credit'),
  ('200900','bs_other',1,'GL: Trade Payables (Gateway)'),
  ('1164-00','bs_other',1,'GL: Utility Deposits'),
  ('1164-01','bs_other',1,'GL: Deposits - Other'),
  ('122200','bs_other',1,'GL: Utilities Deposits (Gateway)'),
  ('1190-00','bs_other',1,'GL: Loans Receivable'),
  ('1073-00','bs_other',1,'GL: Receivable Other'),
  ('1074-00','bs_other',1,'GL: Receivable Other - Tenant'),
  ('1081-00','bs_other',1,'GL: A/R - Other'),
  ('1153-00','bs_other',1,'GL: A/R - Other Capital Partners'),
  ('122500','bs_other',1,'GL: Other Misc Receivable (Gateway)'),
  ('115900','bs_other',1,'GL: Misc Tenant Receivables (Gateway)'),
  ('115000','bs_ar_tenants',1,'GL: Rent Receivables (Gateway) - Gateway''s A/R - Tenants twin'),
  ('1067-01','bs_ar_ret_lump',1,'GL: A/R - Tenant CAM Lump Sum'),
  ('209000','bs_ap_taxes',1,'GL: Accrued Property Taxes (Gateway)')
on conflict do nothing;

-- ============================================================
-- 4. v_pcf_gl_activity: the ONE place the BF rule lives
-- ============================================================
-- Everything downstream reads this, so no caller can forget RULE 1.
create or replace view public.v_pcf_gl_activity
with (security_invoker = true) as
select g.property_id,
       g.period_year,
       g.period_month,
       g.account_code,
       g.account_name,
       (g.credit - g.debit)::numeric as cash_effect
from public.gl_entries g
where not g.is_balance_forward
  and coalesce(g.source_code,'') <> 'BF'
  and g.period_year is not null
  and g.period_month is not null;

grant select on public.v_pcf_gl_activity to authenticated;

-- ============================================================
-- 5. v_pcf_gl_lines: GL actuals resolved to canonical lines
-- ============================================================
-- Mirrors v_pcf_budget_lines, with two deliberate differences:
--   * amount is raw cash_effect - sign_factor is NOT applied (RULE 2)
--   * unmapped accounts are absent by design and listed by v_pcf_gl_unmapped_accounts
create or replace view public.v_pcf_gl_lines
with (security_invoker = true) as
select a.property_id,
       a.period_year,
       a.period_month,
       a.account_code,
       a.account_name,
       m.line_key,
       l.section,
       l.subsection,
       l.label,
       l.sort_order,
       l.is_non_cash,
       l.escrow_key,
       a.cash_effect as amount
from public.v_pcf_gl_activity a
join lateral (
  select am.line_key
  from public.pcf_account_map am
  where am.account_code = a.account_code
    and (am.property_id = a.property_id or am.property_id is null)
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_gl_lines to authenticated;

-- ============================================================
-- 6. v_pcf_gl_unmapped_accounts: the loud list
-- ============================================================
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
    and (am.property_id = a.property_id or am.property_id is null))
group by a.property_id, a.period_year, a.account_code;

grant select on public.v_pcf_gl_unmapped_accounts to authenticated;

-- ============================================================
-- 7. v_pcf_cash_bridge_check: the invariant, per property-month
-- ============================================================
-- Because the export is a complete trial balance, the bridge must equal the actual cash movement:
--   bridge   = sum(cash_effect) over mapped, NON-cash-section, NOT is_non_cash lines
--   cash_move= -sum(cash_effect) over section='cash' lines   [cash debit = cash in]
-- When every account is mapped, bridge - cash_move = 0. Until then the residual equals the
-- unmapped accounts plus any unpaired non-cash line, so this view is the progress meter for
-- Phase 3 as well as the regression test for Phase 2.
create or replace view public.v_pcf_cash_bridge_check
with (security_invoker = true) as
with mapped as (
  select property_id, period_year, period_month, section, is_non_cash, amount
  from public.v_pcf_gl_lines
),
b as (
  select property_id, period_year, period_month,
         sum(amount) filter (where section <> 'cash' and not is_non_cash) as bridge,
         -sum(amount) filter (where section = 'cash')                     as cash_move,
         sum(amount) filter (where is_non_cash)                           as non_cash_excluded
  from mapped
  group by property_id, period_year, period_month
),
u as (
  select property_id, period_year, sum(cash_effect) as unmapped_cash_effect
  from public.v_pcf_gl_unmapped_accounts group by property_id, period_year
)
select b.property_id, b.period_year, b.period_month,
       round(coalesce(b.bridge,0),2)            as bridge_total,
       round(coalesce(b.cash_move,0),2)         as cash_movement,
       round(coalesce(b.bridge,0) - coalesce(b.cash_move,0),2) as residual,
       round(coalesce(b.non_cash_excluded,0),2) as non_cash_excluded,
       round(coalesce(u.unmapped_cash_effect,0),2) as unmapped_cash_effect_year
from b left join u
  on u.property_id = b.property_id and u.period_year = b.period_year;

grant select on public.v_pcf_cash_bridge_check to authenticated;

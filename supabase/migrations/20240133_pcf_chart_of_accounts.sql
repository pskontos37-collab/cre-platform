-- 20240133_pcf_chart_of_accounts.sql
-- Canonical Projected Cash Flow (PCF) chart of accounts + source-account mapping.
--
-- WHY THIS EXISTS
-- The firm's PCF deliverable (golden reference: Providence Pavilion 04.2025 PCF, whose
-- workbook is literally the approved budget workbook with the closed months overwritten)
-- runs a single cascade:
--
--   TOTAL INCOME - OPERATING EXPENSES = NOI
--   NOI + NON-OPERATING              = NET INCOME
--   NET INCOME + CAPITAL + BALANCE SHEET + EQUITY = NET CHANGE IN CASH
--   beginning cash + net change = ending cash   (plus a ledger per escrow account)
--
-- Source budgets arrive in two shapes with completely different charts of accounts:
--   * MRI BF_PROFORMD proforma, 6-digit codes  (Gateway, Magnolia)
--   * Knightdale-style Excel model, NNNN-NN codes (KM East, KM West, Providence)
-- Nothing about a name-matching regex can safely span both, and a misfiled line leaves
-- NOI looking correct while the CASH number is silently wrong. So the account -> PCF line
-- relationship is stored as reviewable data, and anything unmapped is surfaced loudly by
-- v_pcf_unmapped_accounts rather than being absorbed into a subtotal.
--
-- SIGN CONVENTION (the important part)
-- pcf_lines/pcf_account_map normalise every amount to its EFFECT ON CASH:
--   income +, operating expense -, non-operating expense -, capital spend -,
--   escrow funding -, escrow release +, mortgage principal -, distributions -,
--   contributions +.
-- Every subtotal in the cascade is then a plain SUM, which removes the whole class of
-- sign bugs found in the reference workbook (where the Net-Increase-in-Cash variance was
-- computed as S-P while every neighbouring row used P-S, so the same figure was reported
-- as +76,077 and -76,077 four rows apart). Display code may flip signs to show expenses
-- as positive; storage stays cash-effect.
-- Source data does NOT follow one convention - MRI stores capital spend positive
-- (155300 Building Improvements +9,296,785) while the Knightdale model stores it negative
-- (1202-00 Site Improvements -183,750). pcf_account_map.sign_factor carries that per
-- account, which is exactly why the mapping cannot be inferred from the code alone.
--
-- NON-CASH LINES
-- is_non_cash marks lines that belong in NOI / Net Income so those tie to the income
-- statement, but which must be excluded from the bridge to cash: depreciation,
-- amortisation, straight-line/deferred rent adjustments, favorable/unfavorable lease
-- intangible amortisation, and bad-debt reserve.

-- ============================================================
-- pcf_lines: the canonical row model of the PCF. Global reference data, not per property.
-- ============================================================
create table if not exists public.pcf_lines (
  line_key    text primary key,
  section     text not null check (section in
                ('income','opex','non_operating','capital','balance_sheet','equity')),
  subsection  text,
  label       text not null,
  sort_order  int  not null,
  is_non_cash boolean not null default false,
  escrow_key  text,                        -- non-null => also rolls forward as an escrow ledger
  created_at  timestamptz not null default now()
);
create unique index if not exists pcf_lines_sort on public.pcf_lines(sort_order);
create index if not exists pcf_lines_section on public.pcf_lines(section, subsection);

alter table public.pcf_lines enable row level security;
create policy "pcf_lines_select" on public.pcf_lines for select using (true);
create policy "pcf_lines_write"  on public.pcf_lines for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.pcf_lines to authenticated;
revoke all on public.pcf_lines from anon;

-- ============================================================
-- pcf_account_map: source account -> canonical PCF line, with sign normalisation.
-- property_id NULL = default for every property; a property-specific row overrides it.
-- ============================================================
create table if not exists public.pcf_account_map (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid references public.properties(id) on delete cascade,
  account_code text not null,
  line_key     text not null references public.pcf_lines(line_key),
  sign_factor  smallint not null default 1 check (sign_factor in (-1, 1)),
  notes        text,
  created_at   timestamptz not null default now()
);
-- One mapping per account: at most one global default and at most one per property.
create unique index if not exists pcf_account_map_default
  on public.pcf_account_map(account_code) where property_id is null;
create unique index if not exists pcf_account_map_property
  on public.pcf_account_map(property_id, account_code) where property_id is not null;
create index if not exists pcf_account_map_line on public.pcf_account_map(line_key);

alter table public.pcf_account_map enable row level security;
create policy "pcf_account_map_select" on public.pcf_account_map for select
  using (property_id is null or public.can_access_property(property_id));
create policy "pcf_account_map_write" on public.pcf_account_map for all
  using (public.is_admin_or_am());
grant select, insert, update, delete on public.pcf_account_map to authenticated;
revoke all on public.pcf_account_map from anon;

-- ============================================================
-- Canonical PCF lines. sort_order is stepped by 10 so lines can be inserted between.
-- ============================================================
insert into public.pcf_lines (line_key, section, subsection, label, sort_order, is_non_cash, escrow_key) values
  -- INCOME
  ('base_rent',              'income', null, 'Base Rent',                                 100, false, null),
  ('percentage_rent',        'income', null, 'Percentage Rent',                           110, false, null),
  ('rent_adjustments',       'income', null, 'Straight-Line / Deferred Rent Adjustment',  120, true,  null),
  ('lease_intangible_amort', 'income', null, 'Favorable / Unfavorable Lease Amortization',130, true,  null),
  ('recovery_opex',          'income', null, 'Recovery - Operating Expenses',             140, false, null),
  ('recovery_cam',           'income', null, 'Recovery - Common Area Maintenance',        150, false, null),
  ('recovery_ret',           'income', null, 'Recovery - Real Estate Taxes',              160, false, null),
  ('recovery_ret_lump',      'income', null, 'Recovery - Real Estate Taxes Lump Sum',     170, false, null),
  ('recovery_insurance',     'income', null, 'Recovery - Insurance',                      180, false, null),
  ('recovery_water',         'income', null, 'Recovery - Water & Sewer',                  190, false, null),
  ('recovery_other',         'income', null, 'Recovery - Other / Prior Year',             200, false, null),
  ('bad_debt_reserve',       'income', null, 'Bad Debt Reserve (contra)',                 210, true,  null),
  ('interest_income',        'income', null, 'Interest Income',                           220, false, null),
  ('pad_rental',             'income', null, 'Pad Rental',                                230, false, null),
  ('other_income',           'income', null, 'Other Income',                              240, false, null),

  -- OPEX / utilities
  ('util_electric_cam',      'opex', 'utilities', 'Electric - Common Area',               300, false, null),
  ('util_electric_lot',      'opex', 'utilities', 'Electric - Parking Lot',               310, false, null),
  ('util_electric_other',    'opex', 'utilities', 'Electric - Other',                     320, false, null),
  ('util_water',             'opex', 'utilities', 'Water & Sewer',                        330, false, null),
  ('util_water_irrigation',  'opex', 'utilities', 'Water - Irrigation',                   340, false, null),
  ('util_tenant_rebill',     'opex', 'utilities', 'Tenant Re-Bill / Direct Reimbursed',   350, false, null),
  ('util_vacant',            'opex', 'utilities', 'Vacant Space Utilities',               360, false, null),
  ('util_other',             'opex', 'utilities', 'Other Utilities',                      370, false, null),

  -- OPEX / repairs & maintenance
  ('rm_electrical',          'opex', 'repairs_maintenance', 'Electrical Repairs',         400, false, null),
  ('rm_lighting',            'opex', 'repairs_maintenance', 'Lighting / Bulbs & Ballasts',410, false, null),
  ('rm_plumbing',            'opex', 'repairs_maintenance', 'Plumbing Repairs',           420, false, null),
  ('rm_roof',                'opex', 'repairs_maintenance', 'Roof Repairs',               430, false, null),
  ('rm_hvac',                'opex', 'repairs_maintenance', 'HVAC Repairs & Contracts',   440, false, null),
  ('rm_painting',            'opex', 'repairs_maintenance', 'Painting & Decorating',      450, false, null),
  ('rm_signage',             'opex', 'repairs_maintenance', 'Signs & Directories',        460, false, null),
  ('rm_pest',                'opex', 'repairs_maintenance', 'Pest Control',               470, false, null),
  ('rm_life_safety',         'opex', 'repairs_maintenance', 'Alarm / Fire / Life Safety', 480, false, null),
  ('rm_elevator',            'opex', 'repairs_maintenance', 'Elevator / Escalator',       490, false, null),
  ('rm_exterior',            'opex', 'repairs_maintenance', 'Exterior Building Maintenance', 500, false, null),
  ('rm_supplies',            'opex', 'repairs_maintenance', 'Repairs & Maintenance Supplies', 510, false, null),
  ('rm_other',               'opex', 'repairs_maintenance', 'Other Repairs & Maintenance',520, false, null),
  ('rm_nonrecoverable',      'opex', 'repairs_maintenance', 'Repairs - Non-Recoverable',  530, false, null),

  -- OPEX / cleaning
  ('clean_janitorial',       'opex', 'cleaning', 'Janitorial / Daily Cleaning',           600, false, null),
  ('clean_trash',            'opex', 'cleaning', 'Trash / Waste Removal',                 610, false, null),
  ('clean_supplies',         'opex', 'cleaning', 'Janitorial Supplies',                   620, false, null),
  ('clean_tenant_svcs',      'opex', 'cleaning', 'Contract Tenant Services',              630, false, null),
  ('clean_other',            'opex', 'cleaning', 'Other Cleaning',                        640, false, null),

  -- OPEX / grounds & lot
  ('gl_landscaping',         'opex', 'grounds_lot', 'Landscaping',                        700, false, null),
  ('gl_irrigation',          'opex', 'grounds_lot', 'Irrigation Repairs & Maintenance',   710, false, null),
  ('gl_sweeping',            'opex', 'grounds_lot', 'Parking Lot Sweeping',               720, false, null),
  ('gl_snow',                'opex', 'grounds_lot', 'Snow Removal',                       730, false, null),
  ('gl_lot_maint',           'opex', 'grounds_lot', 'Parking Lot / Curb & Walk Repairs',  740, false, null),
  ('gl_powerwashing',        'opex', 'grounds_lot', 'Powerwashing',                       750, false, null),
  ('gl_decorating',          'opex', 'grounds_lot', 'Seasonal Decorating',                760, false, null),
  ('gl_sprinkler',           'opex', 'grounds_lot', 'Ground Sprinkler',                   770, false, null),
  ('gl_other',               'opex', 'grounds_lot', 'Other Grounds / Parking',            780, false, null),

  -- OPEX / security
  ('sec_patrol',             'opex', 'security', 'Security Patrol / Contract',            800, false, null),
  ('sec_other',              'opex', 'security', 'Other Security',                        810, false, null),

  -- OPEX / insurance
  ('ins_property',           'opex', 'insurance', 'Property / Casualty Insurance',        850, false, null),
  ('ins_liability',          'opex', 'insurance', 'Liability Insurance',                  860, false, null),
  ('ins_other',              'opex', 'insurance', 'Other Insurance',                      870, false, null),

  -- OPEX / property taxes
  ('tax_re',                 'opex', 'property_taxes', 'Real Estate Taxes',               900, false, null),
  ('tax_consulting',         'opex', 'property_taxes', 'Real Estate Tax Consulting',      910, false, null),
  ('tax_other',              'opex', 'property_taxes', 'Other Property Taxes',            920, false, null),

  -- OPEX / administrative
  ('admin_payroll',          'opex', 'administrative', 'Administrative Payroll',          950, false, null),
  ('admin_postage',          'opex', 'administrative', 'Postage / Courier',               960, false, null),
  ('admin_telephone',        'opex', 'administrative', 'Telephone',                       970, false, null),
  ('admin_office',           'opex', 'administrative', 'Office Expense',                  980, false, null),
  ('admin_bank_fees',        'opex', 'administrative', 'Bank Fees',                       990, false, null),
  ('admin_dues',             'opex', 'administrative', 'Dues & Subscriptions',           1000, false, null),
  ('admin_license',          'opex', 'administrative', 'Licenses & Local Taxes',         1010, false, null),
  ('admin_travel',           'opex', 'administrative', 'Travel',                         1020, false, null),
  ('admin_advertising',      'opex', 'administrative', 'Advertising / Marketing',        1030, false, null),
  ('admin_other',            'opex', 'administrative', 'Other Administrative',           1040, false, null),

  -- OPEX / management fees
  ('mgmt_fee_property',      'opex', 'management_fee', 'Property Management Fee',        1100, false, null),
  ('mgmt_fee_asset',         'opex', 'management_fee', 'Asset Management Fee',           1110, false, null),

  -- NON-OPERATING
  ('nonop_interest',         'non_operating', null, 'Interest Expense',                  1200, false, null),
  ('nonop_interest_amort',   'non_operating', null, 'Amortization of Deferred Financing',1210, true,  null),
  ('nonop_depreciation',     'non_operating', null, 'Depreciation',                      1220, true,  null),
  ('nonop_amortization',     'non_operating', null, 'Amortization',                      1230, true,  null),
  ('nonop_legal',            'non_operating', null, 'Legal Fees',                        1240, false, null),
  ('nonop_legal_leasing',    'non_operating', null, 'Legal Fees - Leasing',              1250, false, null),
  ('nonop_accounting',       'non_operating', null, 'Audit / Accounting Fees',           1260, false, null),
  ('nonop_tax_fees',         'non_operating', null, 'Tax Preparation Fees',              1270, false, null),
  ('nonop_professional',     'non_operating', null, 'Other Professional Fees',           1280, false, null),
  ('nonop_leasing',          'non_operating', null, 'Other Leasing Expense',             1290, false, null),
  ('nonop_filing',           'non_operating', null, 'Filing Fees',                       1300, false, null),
  ('nonop_owner',            'non_operating', null, 'Other Owner Expense',               1310, false, null),
  ('nonop_tenant_specific',  'non_operating', null, 'Tenant Specific Other',             1320, false, null),
  ('nonop_other',            'non_operating', null, 'Other Non-Operating',               1330, false, null),

  -- CAPITAL EXPENDITURES
  ('cap_building',           'capital', null, 'Building Improvements',                   1400, false, null),
  ('cap_site',               'capital', null, 'Site Improvements',                       1410, false, null),
  ('cap_ti',                 'capital', null, 'Tenant Improvements',                     1420, false, null),
  ('cap_lc',                 'capital', null, 'Leasing Commissions',                     1430, false, null),
  ('cap_legal_leasing',      'capital', null, 'Legal - Leasing (Capitalized)',           1440, false, null),

  -- OTHER BALANCE SHEET
  ('bs_ar_tenants',          'balance_sheet', null, 'A/R - Tenants',                     1500, false, null),
  ('bs_ar_ret_lump',         'balance_sheet', null, 'A/R - Tenant RET Lump Sum',         1510, false, null),
  ('bs_prepaid_insurance',   'balance_sheet', null, 'Prepaid Insurance',                 1520, false, null),
  ('bs_prepaid_casualty',    'balance_sheet', null, 'Prepaid Casualty Insurance',        1530, false, null),
  ('bs_prepaid_other',       'balance_sheet', null, 'Prepaid Expenses - Other',          1540, false, null),
  ('bs_under_collect',       'balance_sheet', null, 'Under-Collection of Recovery Costs',1550, false, null),
  ('bs_excess_collect',      'balance_sheet', null, 'Excess Collection of Recovery Costs',1560, false, null),
  ('bs_ap_capital',          'balance_sheet', null, 'Capital Items Payable',             1570, false, null),
  ('bs_ap_mgmt_fee',         'balance_sheet', null, 'Management Fee Payable',            1580, false, null),
  ('bs_ap_accrued',          'balance_sheet', null, 'Accrued Expenses Payable',          1590, false, null),
  ('bs_ap_taxes',            'balance_sheet', null, 'Property Taxes Payable',            1600, false, null),
  ('bs_security_deposits',   'balance_sheet', null, 'Security Deposits Held',            1610, false, null),
  ('bs_prepaid_rent',        'balance_sheet', null, 'Prepaid Rent',                      1620, false, null),
  ('bs_mortgage_principal',  'balance_sheet', null, 'Mortgage / Note Principal Payments',1630, false, null),
  ('bs_escrow_replacement',  'balance_sheet', null, 'Replacement Reserve Funding',       1640, false, 'replacement_reserve'),
  ('bs_escrow_tax',          'balance_sheet', null, 'Real Estate Tax Escrow Funding',    1650, false, 'tax_escrow'),
  ('bs_escrow_insurance',    'balance_sheet', null, 'Insurance Escrow Funding',          1660, false, 'insurance_escrow'),
  ('bs_escrow_tilc',         'balance_sheet', null, 'TI/LC Reserve Funding',             1670, false, 'tilc_reserve'),
  ('bs_escrow_leasing',      'balance_sheet', null, 'Leasing Reserve Funding',           1680, false, 'leasing_reserve'),
  ('bs_other',               'balance_sheet', null, 'Other Balance Sheet',               1690, false, null),

  -- EQUITY
  ('eq_contributions',       'equity', null, 'Capital Contributions',                    1800, false, null),
  ('eq_distributions',       'equity', null, 'Distributions',                            1810, false, null)
on conflict (line_key) do nothing;

-- ============================================================
-- v_pcf_budget_lines: budget_lines resolved to canonical lines, normalised to cash effect.
-- The lateral picks the property-specific mapping when one exists, else the global default.
-- Unmapped accounts are ABSENT here on purpose and enumerated by v_pcf_unmapped_accounts -
-- never silently folded into a subtotal.
-- ============================================================
create or replace view public.v_pcf_budget_lines
with (security_invoker = true) as
select b.property_id,
       b.budget_year   as period_year,
       b.period_month,
       b.account_code,
       b.account_name,
       m.line_key,
       l.section,
       l.subsection,
       l.label,
       l.sort_order,
       l.is_non_cash,
       l.escrow_key,
       (b.amount * m.sign_factor)::numeric as amount
from public.budget_lines b
join lateral (
  select am.line_key, am.sign_factor
  from public.pcf_account_map am
  where am.account_code = b.account_code
    and (am.property_id = b.property_id or am.property_id is null)
  order by (am.property_id is not null) desc
  limit 1
) m on true
join public.pcf_lines l on l.line_key = m.line_key;

grant select on public.v_pcf_budget_lines to authenticated;

-- ============================================================
-- v_pcf_unmapped_accounts: the loud list. Any source account with no mapping shows up here
-- and must be resolved before a PCF for that property can be trusted.
-- ============================================================
create or replace view public.v_pcf_unmapped_accounts
with (security_invoker = true) as
select b.property_id,
       b.budget_year as period_year,
       b.account_code,
       min(b.account_name) as account_name,
       count(*)            as cells,
       sum(b.amount)       as amount
from public.budget_lines b
where not exists (
  select 1 from public.pcf_account_map am
  where am.account_code = b.account_code
    and (am.property_id = b.property_id or am.property_id is null))
group by b.property_id, b.budget_year, b.account_code;

grant select on public.v_pcf_unmapped_accounts to authenticated;

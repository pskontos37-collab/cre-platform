-- 20240134_pcf_account_map_seed.sql
-- Seeds pcf_account_map for every account currently present in budget_lines (FY2026):
-- 152 distinct codes across Gateway, Magnolia, KM East and KM West. All are seeded as
-- GLOBAL defaults (property_id NULL) because the two code families never collide - the
-- MRI proforma uses bare 6-digit codes and the Knightdale/Providence model uses NNNN-NN.
-- A property-specific row can override any of these later without touching this file.
--
-- sign_factor converts the source value to CASH EFFECT (see 20240133 header):
--   revenue in both families is stored positive           -> +1
--   expenses in both families are stored positive         -> -1
--   MRI capital + principal are stored POSITIVE           -> -1
--   Knightdale capital / balance sheet already cash-signed -> +1
-- That split is the whole reason this is data and not a regex: MRI 155300 Building
-- Improvements arrives as +9,296,785 while Knightdale 1202-00 Site Improvements arrives
-- as -183,750, and both are cash going out the door.

-- Two corrections to the canonical chart, to match how each family draws the NOI line.
-- Asset management fees are an owner-level cost that the reference PCF reports BELOW NOI
-- (the Providence classifier put 'asset management fee' in below_line), so move the line
-- out of operating expenses.
update public.pcf_lines
   set section = 'non_operating', subsection = null, sort_order = 1195
 where line_key = 'mgmt_fee_asset';

-- Knightdale/Providence report bank fees below NOI (Providence row 120, a/c 7144-00),
-- while MRI folds its 606300 Banking Fees into the 60xxxx general-office block inside NOI.
-- Both treatments are honoured so each property's NOI ties to its own statements.
insert into public.pcf_lines (line_key, section, subsection, label, sort_order, is_non_cash, escrow_key)
values ('nonop_bank_fees', 'non_operating', null, 'Bank Fees', 1235, false, null)
on conflict (line_key) do nothing;

insert into public.pcf_account_map (property_id, account_code, line_key, sign_factor, notes) values
  -- ============================================================
  -- Knightdale / Providence family (NNNN-NN)
  -- ============================================================
  -- balance sheet + capital (already signed as cash effect)
  (null, '1051-00', 'bs_prepaid_casualty',   1, null),
  (null, '1053-00', 'bs_prepaid_insurance',  1, null),
  (null, '1061-00', 'bs_ar_tenants',         1, null),
  (null, '1067-00', 'bs_ar_ret_lump',        1, null),
  (null, '1202-00', 'cap_site',              1, null),
  (null, '1267-01', 'cap_building',          1, null),
  (null, '1311-00', 'cap_lc',                1, null),
  (null, '1321-00', 'cap_ti',                1, null),
  (null, '2192-00', 'bs_ap_taxes',           1, null),
  -- income
  (null, '4151-00', 'base_rent',             1, null),
  (null, '4601-00', 'percentage_rent',       1, null),
  (null, '4754-00', 'other_income',          1, null),
  (null, '4757-00', 'pad_rental',            1, null),
  (null, '4781-00', 'recovery_opex',         1, null),
  (null, '4781-03', 'recovery_opex',         1, null),
  (null, '4782-00', 'recovery_water',        1, null),
  (null, '4791-00', 'recovery_ret',          1, null),
  (null, '4791-01', 'recovery_ret_lump',     1, null),
  (null, '4801-00', 'recovery_insurance',    1, null),
  -- utilities
  (null, '5002-00', 'util_electric_cam',    -1, null),
  (null, '5002-01', 'util_electric_lot',    -1, null),
  (null, '5003-00', 'util_water',           -1, null),
  (null, '5003-01', 'util_water_irrigation',-1, null),
  (null, '5010-00', 'util_other',           -1, null),
  (null, '5010-03', 'util_tenant_rebill',   -1, null),
  -- repairs & maintenance
  (null, '5016-00', 'rm_plumbing',          -1, null),
  (null, '5019-00', 'rm_lighting',          -1, null),
  (null, '5022-00', 'rm_roof',              -1, null),
  (null, '5023-00', 'rm_pest',              -1, null),
  (null, '5028-00', 'rm_hvac',              -1, null),
  (null, '5030-00', 'rm_painting',          -1, null),
  (null, '5031-00', 'rm_signage',           -1, null),
  (null, '5032-00', 'rm_nonrecoverable',    -1, null),
  (null, '5035-01', 'rm_other',             -1, null),
  (null, '5077-01', 'rm_life_safety',       -1, null),
  -- cleaning (504x/505x block)
  (null, '5040-00', 'clean_tenant_svcs',    -1, null),
  (null, '5041-00', 'clean_other',          -1, 'Generic "Contract Services"; sits in the 504x/505x cleaning block'),
  (null, '5051-00', 'clean_trash',          -1, null),
  (null, '5054-00', 'clean_janitorial',     -1, null),
  -- grounds & lot
  (null, '5061-00', 'gl_landscaping',       -1, null),
  (null, '5062-00', 'gl_lot_maint',         -1, null),
  (null, '5062-02', 'gl_lot_maint',         -1, null),
  (null, '5063-00', 'gl_sweeping',          -1, null),
  (null, '5064-01', 'gl_snow',              -1, null),
  (null, '5066-00', 'gl_sprinkler',         -1, null),
  (null, '5067-03', 'gl_decorating',        -1, null),
  (null, '5070-00', 'gl_other',             -1, null),
  (null, '5070-01', 'gl_powerwashing',      -1, null),
  -- security / insurance / taxes / admin
  (null, '5076-00', 'sec_patrol',           -1, null),
  (null, '5091-02', 'ins_property',         -1, null),
  (null, '5092-00', 'ins_liability',        -1, null),
  (null, '5095-00', 'ins_other',            -1, null),
  (null, '5102-00', 'tax_re',               -1, null),
  (null, '5112-00', 'tax_consulting',       -1, null),
  (null, '5203-00', 'admin_postage',        -1, null),
  (null, '5231-00', 'mgmt_fee_property',    -1, null),
  (null, '5253-00', 'admin_advertising',    -1, null),
  -- non-operating (71xx block)
  (null, '7126-00', 'nonop_legal',          -1, null),
  (null, '7129-00', 'nonop_professional',   -1, null),
  (null, '7144-00', 'nonop_bank_fees',      -1, null),
  (null, '7145-00', 'nonop_owner',          -1, null),
  (null, '7146-00', 'nonop_filing',         -1, null),
  (null, '7156-00', 'mgmt_fee_asset',       -1, null),

  -- ============================================================
  -- MRI BF_PROFORMD family (6-digit)
  -- ============================================================
  -- capital + principal: MRI stores these POSITIVE, so negate to cash effect
  (null, '155300', 'cap_building',          -1, null),
  (null, '157400', 'cap_ti',                -1, null),
  (null, '189100', 'cap_lc',                -1, null),
  (null, '218201', 'bs_mortgage_principal', -1, null),
  (null, '219201', 'bs_mortgage_principal', -1, null),
  (null, '149800', 'nonop_depreciation',    -1, 'Land Improvements-Deprec; only 4 monthly cells, confirm against MRI. Non-cash, so it cannot affect the cash total.'),
  -- income
  (null, '400610', 'lease_intangible_amort', 1, null),
  (null, '400620', 'lease_intangible_amort', 1, null),
  (null, '402200', 'rent_adjustments',       1, null),
  (null, '407000', 'base_rent',              1, null),
  (null, '411100', 'percentage_rent',        1, null),
  (null, '437700', 'recovery_ret',           1, null),
  (null, '438900', 'recovery_insurance',     1, null),
  (null, '439700', 'recovery_cam',           1, null),
  (null, '440500', 'recovery_opex',          1, null),
  (null, '444100', 'recovery_water',         1, null),
  (null, '448300', 'recovery_other',         1, null),
  (null, '449300', 'recovery_other',         1, null),
  (null, '475600', 'interest_income',        1, null),
  (null, '481602', 'bad_debt_reserve',       1, null),
  (null, '484600', 'other_income',           1, null),
  (null, '484605', 'other_income',           1, null),
  -- utilities
  (null, '501000', 'util_electric_cam',     -1, null),
  (null, '504900', 'util_water_irrigation', -1, null),
  (null, '514000', 'util_electric_cam',     -1, null),
  (null, '515600', 'util_tenant_rebill',    -1, null),
  (null, '515900', 'util_vacant',           -1, null),
  -- repairs & maintenance
  (null, '520400', 'rm_hvac',               -1, null),
  (null, '520600', 'rm_hvac',               -1, null),
  (null, '528200', 'rm_elevator',           -1, null),
  (null, '529200', 'rm_lighting',           -1, null),
  (null, '529800', 'rm_electrical',         -1, null),
  (null, '532500', 'rm_roof',               -1, null),
  (null, '532600', 'rm_plumbing',           -1, null),
  (null, '533300', 'rm_plumbing',           -1, null),
  (null, '534100', 'rm_life_safety',        -1, null),
  (null, '534700', 'rm_life_safety',        -1, null),
  (null, '537600', 'rm_painting',           -1, null),
  (null, '540300', 'rm_exterior',           -1, null),
  (null, '540700', 'rm_pest',               -1, null),
  (null, '542500', 'rm_signage',            -1, null),
  (null, '542900', 'rm_supplies',           -1, null),
  (null, '544100', 'rm_other',              -1, null),
  (null, '798600', 'rm_nonrecoverable',     -1, null),
  -- cleaning
  (null, '548900', 'clean_janitorial',      -1, null),
  (null, '552800', 'clean_supplies',        -1, null),
  (null, '553500', 'clean_trash',           -1, null),
  (null, '555600', 'clean_other',           -1, null),
  -- security
  (null, '560400', 'sec_patrol',            -1, null),
  (null, '563300', 'sec_other',             -1, null),
  -- grounds & lot
  (null, '568400', 'gl_landscaping',        -1, null),
  (null, '570200', 'gl_irrigation',         -1, null),
  (null, '571600', 'gl_landscaping',        -1, null),
  (null, '576300', 'gl_sweeping',           -1, null),
  (null, '577200', 'gl_snow',               -1, null),
  (null, '578100', 'gl_lot_maint',          -1, null),
  (null, '579200', 'gl_other',              -1, null),
  -- administrative
  (null, '584900', 'admin_advertising',     -1, null),
  (null, '598400', 'admin_payroll',         -1, null),
  (null, '604500', 'admin_postage',         -1, null),
  (null, '605500', 'admin_telephone',       -1, null),
  (null, '605700', 'admin_office',          -1, null),
  (null, '606300', 'admin_bank_fees',       -1, 'MRI keeps banking fees in the 60xxxx general-office block inside NOI; the Knightdale family reports 7144-00 below NOI'),
  (null, '607900', 'admin_dues',            -1, null),
  (null, '608700', 'admin_license',         -1, null),
  (null, '609700', 'admin_travel',          -1, null),
  (null, '869100', 'admin_other',           -1, null),
  (null, '613400', 'mgmt_fee_property',     -1, null),
  -- insurance / taxes
  (null, '920000', 'tax_re',                -1, null),
  (null, '920500', 'tax_consulting',        -1, null),
  (null, '922300', 'tax_other',             -1, null),
  (null, '926900', 'ins_property',          -1, null),
  (null, '927200', 'ins_liability',         -1, null),
  (null, '927800', 'ins_other',             -1, null),
  -- non-operating
  (null, '846401', 'nonop_legal_leasing',   -1, null),
  (null, '848200', 'nonop_leasing',         -1, null),
  (null, '852500', 'nonop_accounting',      -1, null),
  (null, '853100', 'nonop_tax_fees',        -1, null),
  (null, '853700', 'nonop_professional',    -1, null),
  (null, '854400', 'nonop_legal',           -1, null),
  (null, '875100', 'nonop_tenant_specific', -1, null),
  (null, '941100', 'nonop_interest',        -1, null),
  (null, '941600', 'nonop_interest_amort',  -1, null),
  (null, '951300', 'nonop_depreciation',    -1, null),
  (null, '951500', 'nonop_amortization',    -1, null)
on conflict do nothing;

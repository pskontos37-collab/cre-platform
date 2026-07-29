-- 20240148_pcf_phase3b_account_map
-- PCF Phase 3b: map the remaining GL accounts, and add cap_acquisition.
--
-- METHOD - two independent signals per account, because sibling precedent alone is wrong.
--   signal A  SIBLING: what other accounts sharing the 4-digit prefix already map to
--   signal B  CROSSWALK: the MR<->TC counterpart from
--             "GL Chart Mapping - MR to TC.pdf" (829 pairs, 829 MR -> 236 TC, 137 unmappable),
--             run FORWARD for MR accounts and REVERSE for TC accounts. The reverse is
--             many-to-one, so it is only trusted when every mapped MR parent agrees.
-- Where the two conflicted, the CROSSWALK won every time, and the conflicts show exactly why
-- signal A cannot be used alone:
--     5204-00 Dues/Subscriptions      sibling said rm_hvac        -> crosswalk admin_dues
--     5035-00 Gen Bldg R&M Supplies   sibling said rm_other       -> crosswalk rm_supplies
--     5067-00 Other Grounds/Lot       sibling said gl_decorating  -> crosswalk gl_other
-- Sibling-only would have filed Dues and Subscriptions under HVAC repairs. This is the same
-- failure mode as the 149800 error: never map on a name or a neighbour alone.
--
-- TWO ERRORS CAUGHT IN MY OWN FIRST DRAFT, both by checking is_non_cash before trusting a name:
--   * 192400 Cap Financing Costs (-1,503,281) and 1331-00 Loan Acquisition Costs (-454,737)
--     were headed for nonop_interest_amort, which is is_non_cash=true. Those are fees actually
--     PAID at closing; only 7031-00 Financing Cost Amortization is the non-cash half. Routing
--     the paid half to a non-cash line would have silently removed ~$1.96M of real outflow
--     from the bridge. The capitalised costs now go to bs_other (cash-effective).
--   * 1234-00 CIP Hard Costs - Construction was headed for cap_acquisition. It is ONGOING
--     construction that becomes a building improvement, not part of the original purchase.
--
-- 109 accounts mapped here. 75 remain deliberately unmapped and LOUD in
-- v_pcf_gl_unmapped_accounts - together they are only ~$6.4M gross and none has a defensible
-- home yet. An honest gap beats a confident guess folded into a subtotal.

-- ============================================================
-- 1. cap_acquisition - the original purchase basis
-- ============================================================
-- Approved by the user 2026-07-28. Existing capital lines cover improvements to an owned
-- asset (building / site / TI / LC / leasing legal); none covers buying it in the first place.
-- Gateway's 2019 purchase alone is ~$386M of otherwise unmappable activity: it was real cash,
-- funded by the $120M NY Life draw plus partner contributions, and the trial balance only
-- closes if it is represented. A current-year PCF simply shows zero on this line.
insert into public.pcf_lines (line_key, section, subsection, label, sort_order, is_non_cash, escrow_key)
values ('cap_acquisition', 'capital', null, 'Acquisition of Property', 1390, false, null)
on conflict (line_key) do nothing;

-- ============================================================
-- 2. The mappings
-- ============================================================
-- property_id is NULL on every row: these are global defaults. sign_factor stays 1 because
-- these accounts are GL-sourced and v_pcf_gl_lines deliberately IGNORES sign_factor
-- (Phase 2 RULE 2 - credit-debit already is the cash effect). If any of these codes later
-- appears in budget_lines, its sign must be revisited at that point.
insert into public.pcf_account_map (property_id, account_code, line_key, sign_factor, notes)
select null, v.account_code, v.line_key, 1, v.notes
from (values
  ('1201-00', 'cap_acquisition', 'Phase 3b: acquisition basis -- Land'),
  ('1234-00', 'cap_building', 'Phase 3b: construction/leasing in progress -- CIP Hard Costs - Construction'),
  ('1241-00', 'cap_acquisition', 'Phase 3b: acquisition basis -- Other Capitalized Fees'),
  ('1251-00', 'cap_acquisition', 'Phase 3b: acquisition basis -- Building Costs'),
  ('1251-04', 'cap_acquisition', 'Phase 3b: acquisition basis -- Building - Acquistion Costs'),
  ('1270-00', 'cap_building', 'Phase 3b: crosswalk -- Other Capitalized Costs'),
  ('1270-01', 'cap_building', 'Phase 3b: crosswalk -- Closing Costs'),
  ('1322-00', 'cap_ti', 'Phase 3b: construction/leasing in progress -- Tenant Improvements In Process'),
  ('1331-00', 'bs_other', 'Phase 3b: financing cost -- Loan Acquisition Costs'),
  ('1331-01', 'bs_other', 'Phase 3b: financing cost -- Deferred Finance Cost'),
  ('139500', 'cap_building', 'Phase 3b: construction/leasing in progress -- Building-CIP'),
  ('140100', 'cap_lc', 'Phase 3b: construction/leasing in progress -- Defer Leasing Comm - CIP'),
  ('140200', 'cap_ti', 'Phase 3b: construction/leasing in progress -- T/I-Nn-Reimbursable-CIP'),
  ('149801', 'cap_acquisition', 'Phase 3b: acquisition basis -- Land Imprvmnts - Acq'),
  ('154300', 'cap_acquisition', 'Phase 3b: acquisition basis -- Building - Acq'),
  ('157401', 'cap_acquisition', 'Phase 3b: acquisition basis -- T/I-Nn-Reimb - Acq'),
  ('188900', 'cap_acquisition', 'Phase 3b: acquisition basis -- Acquisition Costs'),
  ('189101', 'cap_acquisition', 'Phase 3b: acquisition basis -- Def Lease Comm - Acq'),
  ('189800', 'nonop_other', 'Phase 3b: hand-judged -- Lease Cancellations'),
  ('192400', 'bs_other', 'Phase 3b: financing cost -- Cap Financing Costs'),
  ('218200', 'bs_mortgage_principal', 'Phase 3b: crosswalk + sibling agree -- Mortgage Pay #1-Nn-Recrs'),
  ('400600', 'base_rent', 'Phase 3b: hand-corrected (signal was wrong) -- Base Rent-Office'),
  ('406203', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent Retail - Pandemic'),
  ('4151-01', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent - PY Tax Entry'),
  ('4151-04', 'base_rent', 'Phase 3b: crosswalk + sibling agree -- % Rent in Lieu'),
  ('4151-05', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent Retail Deferred'),
  ('419100', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Rent Concession'),
  ('419104', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Rent Deferral - Pandemic'),
  ('420300', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Other Rent Concessions'),
  ('4241-00', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent Abatement (Contra Rev)'),
  ('4241-01', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent Deferment COVID'),
  ('4241-02', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Base Rent Concession COVID'),
  ('4242-00', 'base_rent', 'Phase 3b: contra-revenue to base rent -- Rental Inc - Free Period Rent adj'),
  ('437703', 'recovery_ret', 'Phase 3b: sibling precedent -- Real Estate Tax Recovs - Pandemic'),
  ('440503', 'recovery_opex', 'Phase 3b: sibling precedent -- Operating Expense Recovs - Pandemic'),
  ('4741-00', 'other_income', 'Phase 3b: hand-judged -- Late Fee Income'),
  ('4749-00', 'other_income', 'Phase 3b: hand-judged -- Forfeited Security Deposits'),
  ('4754-04', 'other_income', 'Phase 3b: hand-judged -- Security Deposit Income'),
  ('4756-01', 'recovery_opex', 'Phase 3b: hand-judged -- Electricity - Direct Reimb'),
  ('4760-00', 'other_income', 'Phase 3b: hand-judged -- Tenant Services Income'),
  ('4761-00', 'other_income', 'Phase 3b: hand-judged -- Extended HVAC'),
  ('4769-00', 'other_income', 'Phase 3b: hand-judged -- Termination Fees'),
  ('4781-02', 'recovery_opex', 'Phase 3b: crosswalk + sibling agree -- Recov - Oper Exp Abatement'),
  ('4781-04', 'recovery_opex', 'Phase 3b: sibling precedent -- Recov - Oper Exp COVID'),
  ('4781-05', 'recovery_opex', 'Phase 3b: sibling precedent -- Recoveries - Oper Exp Defer COVID'),
  ('4783-00', 'recovery_opex', 'Phase 3b: hand-judged -- Recoveries - Trash'),
  ('4784-00', 'recovery_opex', 'Phase 3b: hand-judged -- Recoveries - Marketing Fnd'),
  ('4790-00', 'recovery_opex', 'Phase 3b: hand-judged -- Recoveries - Security Service'),
  ('4791-02', 'recovery_ret', 'Phase 3b: crosswalk + sibling agree -- Recov - Property Taxes Abatement'),
  ('4801-01', 'recovery_insurance', 'Phase 3b: crosswalk + sibling agree -- Recov - Insurance Abatement'),
  ('4801-02', 'recovery_insurance', 'Phase 3b: sibling precedent -- Recov - Insurance Reconciliation'),
  ('5003-02', 'util_water_irrigation', 'Phase 3b: crosswalk + sibling agree -- Water - Fire Service'),
  ('5005-00', 'util_vacant', 'Phase 3b: crosswalk -- Gas - Non-Recoverable'),
  ('5007-00', 'util_vacant', 'Phase 3b: crosswalk -- Water - Non-Recoverable'),
  ('5008-00', 'util_vacant', 'Phase 3b: crosswalk -- Sewer - Non-Recoverable'),
  ('5010-02', 'util_tenant_rebill', 'Phase 3b: crosswalk + sibling agree -- Electricity - Direct Reimb.'),
  ('5017-00', 'rm_electrical', 'Phase 3b: crosswalk -- Electrical Repair'),
  ('5022-01', 'rm_roof', 'Phase 3b: crosswalk + sibling agree -- Roof Inspections'),
  ('5024-00', 'rm_other', 'Phase 3b: crosswalk -- Other Repairs'),
  ('5029-00', 'gl_lot_maint', 'Phase 3b: crosswalk -- Parking Lot Repair'),
  ('5032-01', 'rm_nonrecoverable', 'Phase 3b: crosswalk + sibling agree -- Non-Recoverable Repair - Vacancy'),
  ('5035-00', 'rm_supplies', 'Phase 3b: crosswalk beats sibling -- Gen Bldg R&M Supplies'),
  ('5035-02', 'rm_other', 'Phase 3b: crosswalk + sibling agree -- Gen Bldg R&M Other'),
  ('503600', 'util_water', 'Phase 3b: crosswalk -- Water & Sewer Expense'),
  ('5037-00', 'rm_life_safety', 'Phase 3b: crosswalk -- Life Safety R&M'),
  ('5054-01', 'clean_janitorial', 'Phase 3b: sibling precedent -- Janitorial Service - Day'),
  ('5054-04', 'clean_janitorial', 'Phase 3b: sibling precedent -- Janitorial Service COVID'),
  ('5056-00', 'clean_other', 'Phase 3b: crosswalk -- Other Interior Cleaning'),
  ('5062-01', 'gl_lot_maint', 'Phase 3b: crosswalk + sibling agree -- Parking Lot Electrical Repair'),
  ('5065-00', 'gl_landscaping', 'Phase 3b: crosswalk -- Landscaping Supplies'),
  ('5067-00', 'gl_other', 'Phase 3b: crosswalk beats sibling -- Other Grounds/Landscaping/Pkg Lot'),
  ('5067-01', 'gl_decorating', 'Phase 3b: sibling precedent -- Decorating - Nonrecoverable'),
  ('5067-02', 'gl_decorating', 'Phase 3b: sibling precedent -- Music'),
  ('5068-00', 'gl_lot_maint', 'Phase 3b: crosswalk -- Parking Lot Lighting'),
  ('5076-02', 'sec_patrol', 'Phase 3b: sibling precedent -- Security Lines'),
  ('5077-00', 'rm_life_safety', 'Phase 3b: crosswalk + sibling agree -- Alarms'),
  ('5081-00', 'sec_other', 'Phase 3b: crosswalk -- Other Security/Fire/Safety Costs'),
  ('5091-01', 'ins_property', 'Phase 3b: crosswalk + sibling agree -- Insurance'),
  ('5095-01', 'ins_other', 'Phase 3b: crosswalk + sibling agree -- Insurance - PY Tax Entry'),
  ('5201-00', 'admin_office', 'Phase 3b: crosswalk -- Office Supplies'),
  ('5202-00', 'admin_telephone', 'Phase 3b: crosswalk -- Telephones/Radios'),
  ('5204-00', 'admin_dues', 'Phase 3b: crosswalk beats sibling -- Dues/Subscriptions'),
  ('5207-00', 'admin_travel', 'Phase 3b: crosswalk -- Travel'),
  ('5210-00', 'admin_license', 'Phase 3b: crosswalk -- Licenses & Permits'),
  ('5217-00', 'admin_office', 'Phase 3b: crosswalk -- Other'),
  ('5221-00', 'admin_bank_fees', 'Phase 3b: crosswalk -- Loan Servicing Fees'),
  ('5231-03', 'mgmt_fee_property', 'Phase 3b: sibling precedent -- Management Fee - Other'),
  ('5251-00', 'rm_signage', 'Phase 3b: crosswalk -- Signage'),
  ('5255-00', 'nonop_leasing', 'Phase 3b: crosswalk -- Leasing Expense'),
  ('543600', 'rm_other', 'Phase 3b: hand-corrected (signal was wrong) -- Other General Building Ex'),
  ('6001-00', 'interest_income', 'Phase 3b: crosswalk -- Misc Interest Income'),
  ('6011-00', 'nonop_interest', 'Phase 3b: crosswalk -- Interest Expense'),
  ('601200', 'nonop_professional', 'Phase 3b: hand-corrected (signal was wrong) -- Other Professional Fees'),
  ('6042-98', 'nonop_depreciation', 'Phase 3b: crosswalk + sibling agree -- Site Improvements Depreciation'),
  ('6051-01', 'nonop_depreciation', 'Phase 3b: crosswalk + sibling agree -- Depreciation'),
  ('6081-00', 'nonop_depreciation', 'Phase 3b: crosswalk -- FF&E Depreciation - Computer'),
  ('6081-98', 'nonop_depreciation', 'Phase 3b: crosswalk -- FF&E Depreciation - Computer'),
  ('614900', 'mgmt_fee_asset', 'Phase 3b: crosswalk -- Other Management Fees'),
  ('7011-01', 'nonop_amortization', 'Phase 3b: crosswalk + sibling agree -- Amortization'),
  ('7031-00', 'nonop_interest_amort', 'Phase 3b: financing cost -- Financing Cost Amortization'),
  ('7126-01', 'nonop_legal', 'Phase 3b: sibling precedent -- Legal Fees COVID'),
  ('7127-00', 'nonop_accounting', 'Phase 3b: crosswalk -- Audit Fees'),
  ('7136-19', 'bad_debt_reserve', 'Phase 3b: sibling precedent -- Bad Debt W/O - Pandemic'),
  ('7145-01', 'nonop_owner', 'Phase 3b: sibling precedent -- Late Fees-Utilities'),
  ('846400', 'nonop_legal', 'Phase 3b: hand-corrected (signal was wrong) -- Legal (NR)'),
  ('878200', 'nonop_owner', 'Phase 3b: crosswalk -- Other Expenses (NR)'),
  ('933600', 'nonop_other', 'Phase 3b: hand-judged -- Ground Rent Expense')
) as v(account_code, line_key, notes)
where not exists (
  select 1 from public.pcf_account_map am
  where am.account_code = v.account_code and am.property_id is null
);

-- Fail loudly rather than silently mapping to a line that does not exist.
do $$
declare bad int;
begin
  select count(*) into bad
  from public.pcf_account_map am
  left join public.pcf_lines l on l.line_key = am.line_key
  where l.line_key is null;
  if bad > 0 then
    raise exception 'Phase 3b: % mapping(s) point at a non-existent pcf_lines row', bad;
  end if;
end $$;
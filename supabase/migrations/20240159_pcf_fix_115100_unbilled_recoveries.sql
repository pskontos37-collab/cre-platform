-- 20240159_pcf_fix_115100_unbilled_recoveries
-- Re-map TC `115100 Unbilled Rent Receivables` from `rent_adjustments` (non-cash) to
-- `bs_under_collect` "Under-Collection of Recovery Costs" (balance_sheet, cash-effective).
--
-- THIS IS THE "20240149 NON-CASH DEFECT" AT GATEWAY, AND IT IS A MISCLASSIFICATION, NOT A
-- FLAG PROBLEM. `115100` was sitting on the straight-line/deferred-rent line, whose other four
-- accounts form two EXACT pairs that net to zero every month (123500/402200 and 123503/402203).
-- `115100` appeared alone, so its whole movement was silently dropped from the bridge -- and its
-- year total IS each year's entire unexplained non-cash residue at Gateway:
--   2023 -6,935.64 · 2024 +81,253.67 · 2025 +9,101.36
-- Each equals that year's `non_cash_excluded` exactly. One account, three years.
--
-- WHAT IT ACTUALLY IS, FROM THE LEDGER RATHER THAN THE LABEL. The name says "Unbilled Rent
-- Receivables" but every entry is a recovery reconciliation accrual or a tenant billback:
--   "Accr 2024 CAM Estimate Billing" · "Accr 2024 INS Estimate Billing" · "Accr 2024 RET
--   Estimate Billing" and their "Rvs 2024 ..." reversals · "2025 YE INS/OPX/RET Rec estimate" ·
--   "Club Pilates-Pluming Billback" · "Old Navy-Pluming Billback" · "Rvs 2023 Accrued Reconciliations"
-- It is an unbilled RECOVERY receivable. A receivable's movement is the accrual->cash bridge; it
-- is not a straight-line rent adjustment and it is not non-cash.
--
-- 🔗 THE CLOSED LOOP THAT CONFIRMS IT: January 2025's billback accruals here are
-- "Club Pilates-Pluming Billback" 2,709.38 + "Old Navy-Pluming Billback" 1,350.00 = 4,059.38,
-- reversed in May. The VENDOR side of those same two jobs sits in `545400` as
-- "Antenucci Mechanical-Pilates Blockage" 2,709.38 and "NyConn - Target Sewer" 1,350.00, which
-- mig 20240158 just put into the bridge. Landlord pays the vendor, accrues the tenant billback:
-- both halves belong in the bridge, and until now only one was.
--
-- TARGET LINE -- BOTH SIGNALS AGREE:
--   crosswalk: MR `1065-00 "Under Collection of CAM Costs"` AND `1066-00 "Under Collect of
--     Recov Costs"` BOTH map to TC `115100`. Both are already on `bs_under_collect`, so the MR
--     and TC charts meet at the canonical line -- the same rule applied in migs 20240153/20240157.
--   contrast: TC `115000` pairs with MR `1061-00 "A/R - Tenants"` and is on `bs_ar_tenants`.
--     `115000` and `115100` are genuinely different accounts, so the adjacent code is NOT an
--     argument for filing this as ordinary tenant A/R.
--   The reverse also lists `1067-00`/`1067-01` (on `bs_ar_ret_lump`). That is a 4-to-1 reverse, so
--     the specific line is a presentation choice between two adjacent recovery-receivable lines --
--     but all four MR parents are cash-effective balance_sheet, so the load-bearing conclusion
--     (NOT non-cash) is unanimous. `bs_under_collect` chosen because the content is CAM/INS/RET
--     ESTIMATE accruals, i.e. under-collected recoveries, while the lump-sum line is for billed
--     lump sums.
--
-- ⚠️ NOTE THE CHANGE CLASS: this migration does NOT touch `is_non_cash` on any line. It moves a
-- misclassified account to where it belongs. That is safer than flipping a flag, and it leaves
-- the non-cash set STRONGER: `rent_adjustments` is reduced to exactly two matched pairs, so
-- every remaining member of Gateway's non-cash set is paired.
--
-- VERIFIED PER MONTH BEFORE APPLYING, across three years:
--   Gateway 2025: Jan, May, Jun and Dec -- the only four months still off -- ALL go to 0.00,
--     so FY2025 ties in ALL TWELVE MONTHS
--   Gateway 2024: 2024-05 -127,007.29 -> 98.30 and 2024-12 +45,851.92 -> 0.00; worst month for
--     the whole year becomes -1,950.15 and every month is under $2,000
--   Gateway 2023: 2023-08 -107,754.99 -> +10,568.96 and 2023-12 +128,301.80 -> +3,042.21
--   Three independent years all collapsing toward zero off ONE re-mapping is the evidence the
--   diagnosis is right; a wrong mapping cannot improve three unrelated years at once.
--
-- POST-APPLY, MEASURED IN PROD:
--   🎯 FY2025 NOW TIES IN ALL 12 MONTHS AT ALL FOUR PROPERTIES -- year 0.00, unmapped 0.00,
--      non_cash 0.00 at Gateway, KM East, KM West and Magnolia.
--   FY2026: Gateway / KM East / KM West 0.00; Magnolia 46.83 (5009-00 Other Utilities).
--   Gateway 2024: year -3,548.39, worst month 1,950.15, non_cash 0.00 -- the Gateway non-cash
--     defect is gone in 2024 as well; the remainder is unmapped `470000 Storage Space Income`.
--   Gateway 2023: year 2,276.57, worst month 10,568.96, non_cash -290.00.
--
-- ⛔ WHAT THIS DOES NOT FIX -- three SEPARATE unpaired non-cash defects, newly characterised and
-- deliberately left alone because each needs its own decision:
--   KM East 2024 `1631-00 A/A of Loan Acquisition Costs` -222,133.85 (= that year's entire
--     residue) -- unpaired because its expense half `7031-00 Financing Cost Amortization` is
--     UNMAPPED, having been one of the seven mappings mig 20240149 deliberately reverted.
--     Re-mapping it would re-open that decision.
--   KM West 2024 `1631-00` -124,493.15 -- identical shape.
--   Magnolia 2024 `1631-98` -439,373.65 + `7011-98` -65,199.97 = -504,573.62 -- here the pair
--     IS mapped and DID net in 2023 (+50,457.36 / -50,457.36) but does not in 2024, so it is a
--     third distinct cause, probably a loan-cost write-off on refinance.

update public.pcf_account_map
   set line_key = 'bs_under_collect',
       notes = coalesce(notes || ' | ', '') || 'Mig 20240159: moved off rent_adjustments (non-cash). MISCLASSIFIED -- the GL holds CAM/INS/RET recovery reconciliation accruals and tenant billbacks ("Accr 2024 CAM Estimate Billing", "2025 YE INS Rec estimate", "Club Pilates-Pluming Billback"), i.e. an unbilled RECOVERY receivable, whose movement is the accrual-to-cash bridge. Crosswalk pairs MR 1065-00 and 1066-00 with this TC code and both are already on bs_under_collect. Was the sole unpaired member of the non-cash set at Gateway and equalled the entire non_cash_excluded residue in 2023, 2024 AND 2025.'
 where account_code = '115100'
   and line_key = 'rent_adjustments';

do $$
declare
  v_new      int;
  v_old      int;
  v_ra       text;
  v_worst25  numeric;
  v_yr25     numeric;
  v_nc25     numeric;
  v_worst24  numeric;
  v_gw26     numeric;
  v_other25  numeric;
  v_mag26    numeric;
  v_over10k  int;
begin
  -- 1. the account moved, exactly once, and is gone from the old line
  select count(*) into v_new from public.pcf_account_map
   where account_code='115100' and line_key='bs_under_collect';
  if v_new <> 1 then raise exception '20240159: expected 115100 on bs_under_collect once, found %', v_new; end if;
  select count(*) into v_old from public.pcf_account_map
   where account_code='115100' and line_key='rent_adjustments';
  if v_old <> 0 then raise exception '20240159: 115100 still on rent_adjustments'; end if;

  -- 2. rent_adjustments must now be EXACTLY the two matched pairs -- this is the structural
  --    point of the migration, so assert the membership rather than just the count
  select string_agg(account_code, ',' order by account_code) into v_ra
    from public.pcf_account_map where line_key='rent_adjustments';
  if v_ra <> '123500,123503,402200,402203' then
    raise exception '20240159: rent_adjustments membership is "%" -- expected exactly 123500,123503,402200,402203', v_ra;
  end if;

  -- 3. THE HEADLINE, PER MONTH: Gateway FY2025 must now tie in EVERY month
  select round(max(abs(b.residual)),2), round(sum(b.residual),2), round(sum(b.non_cash_excluded),2)
    into v_worst25, v_yr25, v_nc25
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2025;
  if v_worst25 > 0.01 then
    raise exception '20240159: a Gateway 2025 month still fails to tie (worst %)', v_worst25;
  end if;
  if abs(v_yr25) > 0.01 or abs(v_nc25) > 0.01 then
    raise exception '20240159: Gateway FY2025 year % / non_cash % -- both must be 0.00', v_yr25, v_nc25;
  end if;

  -- 4. Gateway 2024 must collapse: every month under $2,000
  select round(max(abs(b.residual)),2) into v_worst24
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2024;
  if v_worst24 > 2000 then
    raise exception '20240159: Gateway 2024 worst month is % -- expected under 2000', v_worst24;
  end if;

  -- 5. nothing else may move
  select round(sum(residual),2) into v_gw26 from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id where p.name ilike '%Gateway%' and b.period_year=2026;
  if abs(coalesce(v_gw26,999)) > 0.01 then raise exception '20240159: Gateway FY2026 moved to %', v_gw26; end if;

  select round(max(abs(b.residual)),2) into v_other25
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where b.period_year=2025 and p.name not ilike '%Gateway%';
  if coalesce(v_other25,999) > 0.01 then
    raise exception '20240159: a non-Gateway FY2025 month stopped tying (worst %)', v_other25; end if;

  select round(sum(residual),2) into v_mag26 from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id where p.name ilike '%Magnolia%' and b.period_year=2026;
  if v_mag26 <> 46.83 then raise exception '20240159: Magnolia FY2026 moved to %', v_mag26; end if;

  select count(*) into v_over10k from public.v_pcf_cash_bridge_check
   where period_year=2026 and abs(residual) > 10000;
  if v_over10k <> 0 then raise exception '20240159: FY2026 no longer ties -- % month(s) over $10k', v_over10k; end if;

  raise notice '20240159 OK: Gateway FY2025 ties in all 12 months (year 0.00, non_cash 0.00); 2024 worst month now %; rent_adjustments reduced to two matched pairs', v_worst24;
end $$;

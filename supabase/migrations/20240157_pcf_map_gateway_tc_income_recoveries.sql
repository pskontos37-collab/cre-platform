-- 20240157_pcf_map_gateway_tc_income_recoveries
-- Map Gateway's three remaining active TC-chart income/recovery accounts:
--   470300 Tenant Service Income  -> other_income
--   448100 Prior Year Insurance   -> recovery_other
--   448900 Prior Year Taxes       -> recovery_other
--
-- BOTH SIGNALS AGREE ON ALL THREE this time (the previous two mapping migrations each had to
-- break a sibling-vs-crosswalk conflict):
--   470300: crosswalk reverse gives MR `4760-00 Tenant Services Income`, and 4760-00 is ALREADY
--           mapped to `other_income`, hand-judged in Phase 3b. Same economic item, same chart
--           pair, already decided -- so this is following an existing decision, not making a
--           new one. Its 476x neighbours (4761-00 Extended HVAC, 4769-00 Termination Fees) are
--           on other_income too.
--   448900: crosswalk reverse is 1:1 to MR `4791-03`, which mig 20240153 put on
--           `recovery_other`. The same item on two charts MUST meet at the same canonical line.
--   448100: crosswalk reverse is 1:1 to MR `4801-02 Recov - Insurance Reconciliation`; its
--           448x/449x siblings `448300` and `449300` are already on `recovery_other`, whose
--           label is literally "Recovery - Other / Prior Year" and whose name matches
--           "Prior Year Insurance" exactly on the prior-year dimension.
--
-- RE-SIMULATED PER MONTH AGAINST CURRENT STATE, NOT AGAINST THE EARLIER PROJECTION. The first
-- Tier-2 estimate was taken BEFORE mig 20240155 fixed the ground-lease intangible and was
-- therefore stale; 20240155 changed which months these accounts are the sole remaining cause of.
--
-- MEASURED EFFECT (per month):
--   Gateway 2025-09 -47,758.81 -> 0.00 and 2025-10 +47,780.88 -> 0.00, which together with
--     20240155's 07/08/11 gives FIVE CONSECUTIVE MONTHS (07-11) tying at exactly 0.00
--   Gateway FY2026 -> 0.00 EXACTLY (2026-03 -748.15 -> 0.00, 2026-04 -1,500.00 -> 0.00),
--     an improvement to the FY2026 tie, not a disturbance
--   Gateway FY2025 -74,662.86 -> +17,155.11; months over $10k 5 -> 3
--   ZERO effect on KM East / KM West / Magnolia in any month -- these are Gateway-only TC
--     accounts, so mig 20240153's exact FY2025 ties are untouched
--
-- MONTHS THAT GET WORSE, DISCLOSED: 2024-02, 2024-05, 2024-10, 2024-11, 2025-02, 2025-05 and
-- 2025-12. This is the same phenomenon as mig 20240153 and NOT a sign the mapping is wrong: in
-- those months a DIFFERENT unresolved gap dominates, and adding a correct mapping shifts the
-- residual instead of cancelling it. The evidence the mappings are right is that the months
-- where these accounts ARE the sole remaining cause land on EXACTLY 0.00 -- five of them in
-- 2025 plus all of FY2026. A wrong mapping cannot produce exact zeros.
--
-- WHAT IS DELIBERATELY LEFT UNMAPPED: `545400 Other Recoveries` (Gateway 2025 -26,256.47).
-- Its name says recovery but its cash effect is negative (expense-like), and its crosswalk
-- reverse is a 13-way NON-unanimous set of MR "Direct Reimbursable" EXPENSE accounts
-- (5031-01/5033-xx/5039-00/5040-xx/5041-00/5051-xx). Reverse crosswalk is only trustworthy
-- when unanimous, so this one stays loud pending a look at the actual GL entries. After this
-- migration it is the ONLY unmapped account left in Gateway FY2025, so the remaining
-- +17,155.11 residual decomposes as -26,256.47 unmapped (545400) plus 9,101.36 of unpaired
-- non-cash left over from mig 20240149 -- both now precisely isolated.
--
-- POST-APPLY, MEASURED IN PROD, PER MONTH:
--   Gateway 2025: 07/08/09/10/11 = 0.00 (five consecutive); Jan 4,059.38, Feb 15,250.00,
--     Mar 975.37, Apr 9,207.95, May -3,236.23, Jun -45,851.92, Dec 36,750.56; year +17,155.11;
--     unmapped -26,256.47 = 545400 exactly, the only account left
--   Gateway 2026: ALL TWELVE MONTHS 0.00, year 0.00, unmapped 0.00
--   FY2025 KM East / KM West / Magnolia still 0.00 in every month
--   FY2026 portfolio-wide: zero months over $10k; only Magnolia 46.83 remains (5009-00)

insert into public.pcf_account_map
  (property_id, account_code, line_key, sign_factor, section_override, effective_from, effective_to, notes)
values
  (null, '470300', 'other_income',    1, null, null, null,
   'Tenant service income. Crosswalk reverse gives MR 4760-00 Tenant Services Income, which Phase 3b already hand-judged onto other_income -- following that decision, not making a new one.'),
  (null, '448100', 'recovery_other',  1, null, null, null,
   'Prior-year insurance recovery true-up. Crosswalk reverse is 1:1 to MR 4801-02 Recov - Insurance Reconciliation; siblings 448300/449300 are already on recovery_other ("Recovery - Other / Prior Year").'),
  (null, '448900', 'recovery_other',  1, null, null, null,
   'Prior-year property-tax recovery true-up. Crosswalk reverse is 1:1 to MR 4791-03, which mig 20240153 put on recovery_other -- the same item on the TC and MR charts must meet at the same canonical line.')
on conflict do nothing;

do $$
declare
  v_cnt      int;
  v_loud     int;
  v_m        numeric;
  v_gw26     numeric;
  v_gw26w    numeric;
  v_over10k  int;
  v_mr25     numeric;
  v_mag26    numeric;
begin
  -- 1. all three landed on the intended lines
  select count(*) into v_cnt from public.pcf_account_map
   where property_id is null
     and ( (account_code='470300' and line_key='other_income')
        or (account_code='448100' and line_key='recovery_other')
        or (account_code='448900' and line_key='recovery_other') );
  if v_cnt <> 3 then raise exception '20240157: expected 3 mappings, found %', v_cnt; end if;

  -- 2. none may remain in the LOUD list
  select count(*) into v_loud from public.v_pcf_gl_unmapped_accounts
   where account_code in ('470300','448100','448900');
  if v_loud <> 0 then raise exception '20240157: % of the three still appear as unmapped', v_loud; end if;

  -- 3. PER MONTH: the four months these accounts are the sole remaining cause of must tie
  for v_m in
    select abs(b.residual) from public.v_pcf_cash_bridge_check b
      join public.properties p on p.id=b.property_id
     where p.name ilike '%Gateway%'
       and ((b.period_year=2025 and b.period_month in (9,10)) or (b.period_year=2026 and b.period_month in (3,4)))
  loop
    if v_m > 0.01 then raise exception '20240157: a target month still fails to tie (abs residual %)', v_m; end if;
  end loop;

  -- 4. Gateway FY2026 must now tie COMPLETELY
  select round(sum(residual),2), round(max(abs(residual)),2) into v_gw26, v_gw26w
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2026;
  if abs(coalesce(v_gw26,999)) > 0.01 or abs(coalesce(v_gw26w,999)) > 0.01 then
    raise exception '20240157: Gateway FY2026 did not reach zero (year % worst %)', v_gw26, v_gw26w;
  end if;

  -- 5. FY2026 must still tie portfolio-wide, and Magnolia must be untouched at 46.83
  select count(*) into v_over10k from public.v_pcf_cash_bridge_check
   where period_year=2026 and abs(residual) > 10000;
  if v_over10k <> 0 then raise exception '20240157: FY2026 no longer ties -- % month(s) over $10k', v_over10k; end if;
  select round(sum(residual),2) into v_mag26 from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Magnolia%' and b.period_year=2026;
  if v_mag26 <> 46.83 then raise exception '20240157: Magnolia FY2026 moved to % (expected 46.83)', v_mag26; end if;

  -- 6. THE THREE MR PROPERTIES' FY2025 TIES FROM MIG 20240153 MUST SURVIVE. These are global
  --    mappings, so a wrong target could bleed into another property; this proves it did not.
  select round(max(abs(b.residual)),2) into v_mr25
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where b.period_year=2025 and p.name not ilike '%Gateway%';
  if coalesce(v_mr25,999) > 0.01 then
    raise exception '20240157: a non-Gateway FY2025 month stopped tying (worst abs residual %)', v_mr25;
  end if;

  raise notice '20240157 OK: Gateway FY2026 ties completely; 2025-09/10 exact zeros (07-11 now five consecutive); KM East / KM West / Magnolia untouched';
end $$;

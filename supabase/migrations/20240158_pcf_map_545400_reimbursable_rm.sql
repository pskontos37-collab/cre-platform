-- 20240158_pcf_map_545400_reimbursable_rm
-- Map TC `545400 "Other Recoveries"` -> `rm_other` (opex / repairs_maintenance).
--
-- ⚠️ THE NAME IS WRONG AND THE NAME IS WHY THIS SAT UNMAPPED. "Other Recoveries" reads as
-- recovery INCOME. It is not: it is a REIMBURSABLE EXPENSE account. I had deferred it twice on
-- the grounds that its 13-way crosswalk reverse was "non-unanimous"; reading the GL settled it
-- and also showed that judgement was wrong -- the 13 MR parents disagree on TRADE but are
-- unanimous on CONCEPT (direct-reimbursable expense). Breadth is not disagreement.
--
-- WHAT THE GL ACTUALLY CONTAINS (the evidence, not the label): every entry is an AP DEBIT to a
-- vendor -- R & J Electrical Contractors, Antenucci Mechanical, Barreto Pest Control, Tully
-- Electric, NyConn, Village of Port Chester -- against tenant-specific descriptions:
-- "Antenucci Mechanical-Whole Foods", "NyConn - Old Navy blockage", "NyConn - Target Sewer",
-- "Antenucci Mechanical-Pilates Blockage", "Accr Fire Safety Renewal for Tenants". One entry
-- reads "Rcls 2023 Fire Safety Renewal to 545500" -- reclassified TO another 5xxxxx account,
-- confirming it lives in the expense family. Its cash effect is NEGATIVE, consistent with
-- expense, and inconsistent with the name.
--
-- STRUCTURAL CORROBORATION: EVERY mapped TC `5xxxxx` account is section `opex` -- utilities,
-- HVAC, elevator, roof, plumbing, life-safety, janitorial, trash, security, landscaping,
-- advertising, payroll. NOT ONE maps to income. In the TC chart 44xxxx/47xxxx is
-- income/recovery and 5xxxxx+ is expense. A 5-prefix account cannot be recovery income.
--
-- WHY `rm_other` AND NOT THE TWO NEARER-SOUNDING CANDIDATES:
--   * `util_tenant_rebill` "Tenant Re-Bill / Direct Reimbursed" (from TC 515600) is the closest
--     CONCEPTUAL match, but it sits in the UTILITIES subsection, and this account's content is
--     R&M trades (electrical, sewer, pest, fire safety, permits). Filing it there would
--     overstate the utilities subtotal, which each property's NOI must tie to.
--   * `clean_tenant_svcs` (from MR 5040-00 Contract Tenant Svcs) is cleaning, which this is not.
--   * `rm_other` "Other Repairs & Maintenance" already carries the two NEAREST TC code
--     neighbours, `543600` and `544100`, and the work genuinely is other R&M. Conservative and
--     consistent. A dedicated "Direct Reimbursable R&M" line was considered and rejected as
--     speculative -- the mechanism exists if a property ever presents it separately.
--
-- VERIFIED PER MONTH, and this is the cleanest result of the four mapping migrations:
--   Gateway 2025-02 15,250.00 -> 0.00 · 2025-03 975.37 -> 0.00 · 2025-04 9,207.95 -> 0.00
--   Gateway 2024-01 7,448.47 -> 98.47 · 2024-02 1,743.15 -> 98.13 · 2024-06 911.11 -> 98.30
--     (2024-02 was the one month mig 20240157 made worse -- this reverses it)
--   Gateway 2025-05 -3,236.23 -> -4,059.38, the only month worse, and it now EXACTLY cancels
--     January's +4,059.38: an accrual booked in Jan and reversed in May, which is real timing
--   ZERO effect on KM East / KM West / Magnolia in any month
--
-- THE PAYOFF, and the reason this is worth asserting below: Gateway FY2025 ends with
-- unmapped = 0.00 -- NO unmapped accounts left at all -- and a residual of exactly -9,101.36,
-- which is precisely the unpaired non-cash residue from mig 20240149. EIGHT of twelve 2025
-- months tie at 0.00. The mapping work for Gateway is finished; what remains is a single,
-- fully isolated non-cash pairing defect.
--
-- POST-APPLY, MEASURED IN PROD, PER MONTH:
--   Gateway 2025: 02/03/04/07/08/09/10/11 = 0.00 (8 of 12); Jan +4,059.38 and May -4,059.38
--     cancel exactly; Jun -45,851.92 and Dec +36,750.56 sum to -9,101.36 -- so the ENTIRE
--     remaining defect lives in Jun and Dec. Year -9,101.36, unmapped 0.00, non-cash 9,101.36.
--   Gateway 2024: months 01/02/03/04/06 all ~98; only 2024-05 (-127,007.29) and
--     2024-12 (+45,851.92) remain material.
--   Gateway 2026: 0.00 in every month. KM East / KM West / Magnolia FY2025: 12 of 12 months
--     tying, unmapped 0.00, non-cash 0.00. Magnolia FY2026 46.83 (5009-00) unchanged.
--   PORTFOLIO: unmapped_cash_effect_year is now 0.00 for EVERY property-year in 2025-2026
--     except Magnolia 2026 at -46.83.

insert into public.pcf_account_map
  (property_id, account_code, line_key, sign_factor, section_override, effective_from, effective_to, notes)
values
  (null, '545400', 'rm_other', 1, null, null, null,
   'MISNAMED: "Other Recoveries" is a REIMBURSABLE EXPENSE, not recovery income. GL shows only AP debits to trade vendors (electrical, mechanical, sewer, pest, fire-safety) against tenant-specific descriptions, plus a reclass to 545500. Every mapped TC 5xxxxx account is opex; none is income. Filed on rm_other with its nearest neighbours 543600/544100 rather than util_tenant_rebill, whose utilities subsection would misstate that subtotal.')
on conflict do nothing;

do $$
declare
  v_cnt      int;
  v_loud     int;
  v_m        numeric;
  v_gw25     numeric;
  v_gw25un   numeric;
  v_zeros    int;
  v_gw26     numeric;
  v_other25  numeric;
  v_mag26    numeric;
  v_over10k  int;
begin
  -- 1. the mapping landed and left the loud list
  select count(*) into v_cnt from public.pcf_account_map
   where account_code='545400' and line_key='rm_other' and property_id is null;
  if v_cnt <> 1 then raise exception '20240158: expected 1 mapping for 545400, found %', v_cnt; end if;
  select count(*) into v_loud from public.v_pcf_gl_unmapped_accounts where account_code='545400';
  if v_loud <> 0 then raise exception '20240158: 545400 still appears as unmapped'; end if;

  -- 2. PER MONTH: the three months 545400 was the sole remaining cause of must tie exactly
  for v_m in
    select abs(b.residual) from public.v_pcf_cash_bridge_check b
      join public.properties p on p.id=b.property_id
     where p.name ilike '%Gateway%' and b.period_year=2025 and b.period_month in (2,3,4)
  loop
    if v_m > 0.01 then raise exception '20240158: Gateway 2025-02/03/04 did not all tie (abs residual %)', v_m; end if;
  end loop;

  -- 3. THE HEADLINE INVARIANT: Gateway FY2025 has NO unmapped accounts left, and its entire
  --    remaining residual is the isolated non-cash defect from mig 20240149.
  select round(sum(b.residual),2), round(max(b.unmapped_cash_effect_year),2)
    into v_gw25, v_gw25un
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2025;
  if abs(coalesce(v_gw25un,999)) > 0.01 then
    raise exception '20240158: Gateway FY2025 still has unmapped cash effect % -- expected 0.00', v_gw25un;
  end if;
  if v_gw25 <> -9101.36 then
    raise exception '20240158: Gateway FY2025 residual is % -- expected exactly -9101.36 (the 20240149 non-cash residue)', v_gw25;
  end if;

  -- 4. eight of twelve 2025 months must now be exact zeros
  select count(*) into v_zeros from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2025 and abs(b.residual) <= 0.01;
  if v_zeros < 8 then
    raise exception '20240158: expected >= 8 zero months in Gateway 2025, found %', v_zeros;
  end if;

  -- 5. nothing else may move: Gateway FY2026 stays at zero, the other three properties' FY2025
  --    ties from mig 20240153 survive, Magnolia FY2026 stays 46.83, FY2026 still ties
  select round(sum(residual),2) into v_gw26 from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2026;
  if abs(coalesce(v_gw26,999)) > 0.01 then raise exception '20240158: Gateway FY2026 moved to %', v_gw26; end if;

  select round(max(abs(b.residual)),2) into v_other25
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where b.period_year=2025 and p.name not ilike '%Gateway%';
  if coalesce(v_other25,999) > 0.01 then
    raise exception '20240158: a non-Gateway FY2025 month stopped tying (worst %)', v_other25;
  end if;

  select round(sum(residual),2) into v_mag26 from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Magnolia%' and b.period_year=2026;
  if v_mag26 <> 46.83 then raise exception '20240158: Magnolia FY2026 moved to %', v_mag26; end if;

  select count(*) into v_over10k from public.v_pcf_cash_bridge_check
   where period_year=2026 and abs(residual) > 10000;
  if v_over10k <> 0 then raise exception '20240158: FY2026 no longer ties -- % month(s) over $10k', v_over10k; end if;

  raise notice '20240158 OK: Gateway FY2025 unmapped = 0.00, residual = -9101.36 (pure 20240149 non-cash residue), % zero months; nothing else moved', v_zeros;
end $$;

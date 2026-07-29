-- 20240155_pcf_ground_lease_intangible_in_bridge
-- Make the above-market GROUND-LEASE intangible participate in the cash bridge, the same
-- structural fix as bad debt (mig 20240152) -- but applied to a DEDICATED line, not to the
-- shared `lease_intangible_amort`.
--
-- THE FLAW, identical in shape to bad debt: `156301 Above market ground leases` sits on a
-- line flagged `is_non_cash`, but in the months that matter its counterpart is NOT in the
-- non-cash set -- it is the Gateway ground-lease BUYOUT (2025-11-12, $14.5M, ref 122650),
-- which is cash-effective and correctly captured via `188900 -> cap_acquisition`. Excluding
-- one half of an entry whose other half is cash-effective is exactly what the durable rule
-- forbids, and it left the bridge unable to explain Gateway 2025-08 and 2025-11.
--
-- ⚠️ WHY NOT SIMPLY FLIP `lease_intangible_amort.is_non_cash`, which is the literal analogue
-- of the bad-debt fix: that line carries ELEVEN accounts forming four CORRECTLY-NETTING pairs
-- (156000/177200 in-place, 156300/177300 favorable, 156700/177500 unfavorable, plus the
-- 400610/400620 P&L legs). Those pairs are why the non-cash SET nets to exactly 0.00 in
-- Gateway 2026-01/02/03/06 and most of 2025. Flipping the shared line would sweep all of them
-- into the bridge and break the netting that already works -- including FY2026, which
-- currently ties portfolio-wide. So the instrument gets its own line instead.
--
-- SCOPE VERIFIED BEFORE CHOOSING THAT: of the three accounts making up this instrument,
-- ONLY `156301` has any activity since 2024. `177301 A/A - Above Market Ground Leases` and
-- `125423 Acquired Above Market-Ground Lease` net to 0.00 in every month, so moving them
-- alongside 156301 keeps the instrument coherent and changes nothing today. All three move
-- together deliberately: if 177301 ever amortises against 156301 they must net on the SAME
-- line, whichever side of is_non_cash it sits on.
--
-- NET-ZERO-TRAP TEST APPLIED AND PASSED. `156301` nets to EXACTLY 0.00 over 2025 while
-- swinging across months (-52,683.15 Aug, -6,703.65 Sep, -17,869.05 Oct, +77,255.85 Nov), so
-- it is superficially the `154300` class the rule warns about. It is NOT: `154300` was a
-- balance-sheet RECLASS with BOTH halves inside the bridge, so mapping it invented monthly
-- movement. Here the counterpart is OUTSIDE the non-cash set, so including 156301 MATCHES an
-- existing bridge leg. The tell is decisive and was measured first: Gateway 2025-08 and
-- 2025-11 go to EXACTLY 0.00. A fabrication moves a residual away from zero, never onto it.
--
-- MEASURED EXPECTATION (per month, never per year): Gateway 2025-08 +52,683.15 -> 0.00 and
-- 2025-11 -77,255.85 -> 0.00; 2025-10 +65,649.93 -> +47,780.88 (better); 2025-09 -41,055.16
-- -> -47,758.81 (worse, because September's residual is dominated by the still-unmapped TC
-- accounts 470300/448100/448900 -- mapping those turns 09 and 10 into 0.00 too, and that is a
-- separate decision not taken here). FY2025 year total is UNCHANGED at -74,662.86 because the
-- account nets to zero over the year; this fix redistributes the residual onto its real
-- causes rather than shrinking it. FY2026 CANNOT move: zero 2026 activity on all three.
--
-- POST-APPLY, MEASURED IN PROD, PER MONTH:
--   Gateway 2025: 07/08/11 all 0.00; 09 -47,758.81; 10 +47,780.88; months over $10k 7 -> 5;
--                 year unchanged -74,662.86 exactly as predicted
--   FY2026 BYTE-IDENTICAL: Gateway -2,248.15 (worst 1,500.00), KM East 0.00, KM West 0.00,
--                 Magnolia 46.83 -- ZERO months over $10k at any property
--   FY2025 KM East / KM West / Magnolia still 0.00 (mig 20240153 intact)

insert into public.pcf_lines (line_key, section, subsection, label, sort_order, is_non_cash, escrow_key)
values ('lease_intangible_ground', 'income', null,
        'Above-Market Ground Lease Amortization', 135, false, null)
on conflict (line_key) do nothing;

update public.pcf_account_map
   set line_key = 'lease_intangible_ground',
       notes = coalesce(notes, '') || ' | Moved off lease_intangible_amort by mig 20240155: the Gateway ground-lease buyout (2025-11-12) made this instrument''s counterpart cash-effective, so excluding it as non-cash made the bridge unable to explain 2025-08 and 2025-11. Same flaw as bad debt (20240152). Kept on its OWN line so the four correctly-netting lease-intangible pairs are not swept in.'
 where account_code in ('125423', '156301', '177301')
   and line_key = 'lease_intangible_amort';

do $$
declare
  v_new_cnt   int;
  v_left      int;
  v_others    int;
  v_noncash   boolean;
  v_aug       numeric;
  v_nov       numeric;
  v_gw26      numeric;
  v_gw26w     numeric;
  v_over10k   int;
  v_set26     numeric;
begin
  -- 1. the new line exists and is CASH-EFFECTIVE (the entire point)
  select is_non_cash into v_noncash from public.pcf_lines where line_key='lease_intangible_ground';
  if v_noncash is null then raise exception '20240155: lease_intangible_ground was not created'; end if;
  if v_noncash then raise exception '20240155: lease_intangible_ground must have is_non_cash=false'; end if;

  -- 2. exactly the three instrument accounts moved, and none was left behind
  select count(*) into v_new_cnt from public.pcf_account_map where line_key='lease_intangible_ground';
  if v_new_cnt <> 3 then
    raise exception '20240155: expected 3 accounts on lease_intangible_ground, found %', v_new_cnt;
  end if;
  select count(*) into v_left from public.pcf_account_map
   where line_key='lease_intangible_amort' and account_code in ('125423','156301','177301');
  if v_left <> 0 then raise exception '20240155: % instrument account(s) left on lease_intangible_amort', v_left; end if;

  -- 3. THE OTHER EIGHT MUST BE UNTOUCHED -- this is the guard against the sweeping change
  select count(*) into v_others from public.pcf_account_map where line_key='lease_intangible_amort';
  if v_others <> 8 then
    raise exception '20240155: expected 8 accounts still on lease_intangible_amort, found %', v_others;
  end if;

  -- 4. PER MONTH, the two months this fix exists for must now tie exactly
  select round(abs(residual),2) into v_aug from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2025 and b.period_month=8;
  select round(abs(residual),2) into v_nov from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2025 and b.period_month=11;
  if coalesce(v_aug,999) > 0.01 then raise exception '20240155: Gateway 2025-08 still does not tie (%)', v_aug; end if;
  if coalesce(v_nov,999) > 0.01 then raise exception '20240155: Gateway 2025-11 still does not tie (%)', v_nov; end if;

  -- 5. FY2026 MUST BE BYTE-IDENTICAL -- it tied portfolio-wide before this and must after
  select round(sum(residual),2), round(max(abs(residual)),2) into v_gw26, v_gw26w
    from public.v_pcf_cash_bridge_check b join public.properties p on p.id=b.property_id
   where p.name ilike '%Gateway%' and b.period_year=2026;
  if v_gw26 <> -2248.15 or v_gw26w <> 1500.00 then
    raise exception '20240155: Gateway FY2026 MOVED (year % worst %) -- expected -2248.15 / 1500.00', v_gw26, v_gw26w;
  end if;
  select count(*) into v_over10k from public.v_pcf_cash_bridge_check
   where period_year=2026 and abs(residual) > 10000;
  if v_over10k <> 0 then
    raise exception '20240155: FY2026 no longer ties -- % month(s) over $10k', v_over10k;
  end if;

  -- 6. the non-cash SET must still net to zero in the months it did before (proves the
  --    remaining four pairs were not disturbed)
  select round(sum(g.cash_effect),2) into v_set26
    from public.v_pcf_gl_activity g
    join public.properties p on p.id=g.property_id
    join public.pcf_account_map m on m.account_code=g.account_code
     and (m.property_id=g.property_id or m.property_id is null)
     and (m.effective_from is null or make_date(g.period_year,g.period_month,1) >= m.effective_from)
     and (m.effective_to   is null or make_date(g.period_year,g.period_month,1) <  m.effective_to)
    join public.pcf_lines l on l.line_key=m.line_key
   where p.name ilike '%Gateway%' and l.is_non_cash
     and g.period_year=2026 and g.period_month in (1,2,3,6);
  if abs(coalesce(v_set26,999)) > 0.01 then
    raise exception '20240155: Gateway 2026 non-cash set no longer nets to zero (%)', v_set26;
  end if;

  raise notice '20240155 OK: ground-lease intangible now in the bridge; Gateway 2025-08 and 2025-11 tie exactly; FY2026 unchanged; the other 8 lease-intangible accounts untouched and still netting';
end $$;

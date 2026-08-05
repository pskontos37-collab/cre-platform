-- 20240195_pcf_pair_financing_cost_amortization
--
-- Closes the last three PCF cash-bridge defects. They looked like three problems and were
-- ONE: a write-off of fully-amortized deferred financing costs, split across the bridge
-- boundary. Each pair nets to EXACTLY zero and no cash moved, but one half was excluded as
-- non-cash while the other participated, so the bridge booked a pure book entry as real cash.
--
--   property   month     contra - EXCLUDED (is_non_cash)      gross - IN THE BRIDGE
--   KM East    2024-02   1631-00        -222,133.85           1331-01 Deferred Finance Cost +222,133.85
--   KM West    2024-02   1631-00        -124,493.15           1331-01 Deferred Finance Cost +124,493.15
--   Magnolia   2024-12   1631-98        -504,573.62           1331-00 Loan Acq Costs        +504,573.62
--
-- KM East and KM West wrote off in the SAME month => a joint Knightdale refinance.
-- This is the twin of the bad-debt flaw fixed by 20240152: RULE = only flag is_non_cash when
-- BOTH halves of the entry are non-cash. Here the counterpart 1331-xx also takes REAL cash
-- (Magnolia -107,236.90 of new loan costs in the same month), so bs_other cannot be flagged
-- instead. The contra has to come INTO the bridge to meet its gross half.
--
-- TWO CORRECTIONS TO THE RECORD, both of which had kept this parked:
-- 1. The `7031-00` decision was never a blocker. 7031-00 has NO 2024 activity at all - it is
--    the ongoing monthly amortization EXPENSE, unrelated to a write-off. Mapping it fixes
--    none of the three. The item waited on a decision that could not have helped.
-- 2. Magnolia was not "a third, different cause". Same cause as the other two; filing it
--    separately is what kept the shared fix invisible.
--
-- WHY THIS RE-ADDS WHAT 20240149 DELIBERATELY REMOVED. That migration released 7031-00
-- because "no matching accumulated-depreciation or allowance account appears anywhere in the
-- UNMAPPED SET". True - and that is exactly why the counterpart was missed: 1631-00 is not in
-- the unmapped set because it was ALREADY MAPPED, to this very line. The search looked in the
-- one place the answer could not be. 20240149's RULE 3 objection (a non-cash target with no
-- counterpart) is also now moot, because part (b) stops the line being non-cash at all.
--
-- BOTH PARTS OR NEITHER. Part (b) alone would BREAK 2019-2023: measured, this line fails to
-- net in 14 property-years, not one, because 7031-00 sits unmapped and therefore outside the
-- bridge. Flipping the flag without mapping it drops the contra in with no counterpart.
--
-- PREDICTED, THEN GUARDED BELOW (read-only replay before writing):
--   FIXED   KM East  2024   223,636.06 -> 1,502.21      KM East 2023  63,449.91 -> 0.00
--           KM West  2024   124,493.15 -> 0.00          KM West 2023  37,532.09 -> 0.00
--           Magnolia 2024   504,573.62 -> 0.00 (worst month 504,387.77 -> 7,007.54)
--   WORSE   KM East  2020     1,112.33 -> 4,491.63      KM West 2020   0.00 -> 1,900.86
--           Gateway  2020  +11,135 on a year already loud by $41.7M (acquisition era)
--           Magnolia 2014   +4,205 on a year already loud by $156.9M (acquisition era)
-- The 2020 movements are the REAL gross-vs-contra timing mismatch, previously hidden by
-- excluding both halves. Surfacing a small true gap beats concealing it.
--   UNTOUCHED  FY2025 and FY2026 - zero delta at every property. The years a live PCF uses
--              stay tied, which is the property that makes this safe to ship.
--
-- NOI IS UNAFFECTED (this line sits in non_operating, below NOI). NET INCOME DOES MOVE for
-- KM East/West 2019-2023 by the 7031-00 amounts - correct, financing-cost amortization is a
-- real expense that was simply unmapped and therefore missing from the statement.

-- ---------------------------------------------------------------------------------------
-- (a) Pair 7031-00 with its counterpart 1631-00 on the same line.
--     Global (property_id null) like every other row on this line: 7031-00 appears ONLY at
--     KM East (2019-2023) and KM West (2019-2024), verified portfolio-wide - no other
--     property carries the account, so a global row cannot reach one unintentionally.
--     sign_factor 1 matches 1631-00 / 1631-98 / 7011-98. v_pcf_gl_lines ignores sign_factor
--     anyway (RULE 2); it matters only if a budget ever carries this account.
--     Bare `on conflict do nothing`: the table's only uniqueness is the GiST EXCLUDE
--     constraint, and `on conflict on constraint <exclusion>` is invalid syntax.
-- ---------------------------------------------------------------------------------------
insert into public.pcf_account_map (property_id, account_code, line_key, sign_factor, notes)
values (null, '7031-00', 'nonop_interest_amort', 1,
        'GL: Financing Cost Amortization, pairs with 1631-00. Re-added by 20240195 after '
        || '20240149 released it: its counterpart was already mapped, not unmapped.')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------
-- (b) The line stops being non-cash, so both halves of every entry meet in the bridge.
--     Mirrors 20240152 (bad_debt_reserve). is_non_cash gates ONLY the bridge filter
--     (v_pcf_cash_bridge_check: `NOT is_non_cash`); section membership and therefore every
--     subtotal are untouched.
-- ---------------------------------------------------------------------------------------
update public.pcf_lines
   set is_non_cash = false
 where line_key = 'nonop_interest_amort';

-- ---------------------------------------------------------------------------------------
-- GUARDS. The predictions above are asserted here, so a wrong diagnosis rolls this back
-- instead of shipping a quietly-broken cash bridge.
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_missing   int;
  v_flag      boolean;
  v_live_worst numeric;
  v_kme_2024  numeric;
  v_kmw_2024  numeric;
  v_mag_2024  numeric;
  v_kme_2023  numeric;
  v_kmw_2023  numeric;
begin
  -- both halves must be on the line, or the pairing is not actually paired
  select count(*) into v_missing
    from (values ('1631-00'), ('7031-00')) as need(code)
   where not exists (
     select 1 from public.pcf_account_map m
      where m.account_code = need.code and m.line_key = 'nonop_interest_amort'
        and m.property_id is null);
  if v_missing > 0 then
    raise exception '20240195: nonop_interest_amort is missing % of the 1631-00/7031-00 pair', v_missing;
  end if;

  select is_non_cash into v_flag from public.pcf_lines where line_key = 'nonop_interest_amort';
  if v_flag is not false then
    raise exception '20240195: nonop_interest_amort.is_non_cash did not clear';
  end if;

  -- THE SAFETY PROPERTY: the years a live PCF uses must stay tied. Worst live
  -- property-month is 46.83 (Magnolia 2026) before this change and must not move.
  select max(abs(residual)) into v_live_worst
    from public.v_pcf_cash_bridge_check where period_year >= 2025;
  if v_live_worst > 100 then
    raise exception '20240195: FY2025+ bridge regressed - worst property-month is %', v_live_worst;
  end if;

  -- the three target defects, per YEAR, against the replay predictions
  select round(sum(c.residual),2) into v_kme_2024 from public.v_pcf_cash_bridge_check c
    join public.properties p on p.id=c.property_id
   where p.name like 'KM East%' and c.period_year=2024;
  select round(sum(c.residual),2) into v_kmw_2024 from public.v_pcf_cash_bridge_check c
    join public.properties p on p.id=c.property_id
   where p.name like 'KM West%' and c.period_year=2024;
  select round(sum(c.residual),2) into v_mag_2024 from public.v_pcf_cash_bridge_check c
    join public.properties p on p.id=c.property_id
   where p.name like 'Magnolia%' and c.period_year=2024;
  select round(sum(c.residual),2) into v_kme_2023 from public.v_pcf_cash_bridge_check c
    join public.properties p on p.id=c.property_id
   where p.name like 'KM East%' and c.period_year=2023;
  select round(sum(c.residual),2) into v_kmw_2023 from public.v_pcf_cash_bridge_check c
    join public.properties p on p.id=c.property_id
   where p.name like 'KM West%' and c.period_year=2023;

  if abs(v_kme_2024 - 1502.21) > 0.01 then
    raise exception '20240195: KM East 2024 predicted 1502.21, got %', v_kme_2024;
  end if;
  if abs(v_kmw_2024) > 0.01 then
    raise exception '20240195: KM West 2024 predicted 0.00, got %', v_kmw_2024;
  end if;
  if abs(v_mag_2024) > 0.01 then
    raise exception '20240195: Magnolia 2024 predicted 0.00, got %', v_mag_2024;
  end if;
  if abs(v_kme_2023) > 0.01 then
    raise exception '20240195: KM East 2023 predicted 0.00, got %', v_kme_2023;
  end if;
  if abs(v_kmw_2023) > 0.01 then
    raise exception '20240195: KM West 2023 predicted 0.00, got %', v_kmw_2023;
  end if;

  raise notice '20240195 OK: KM East 2024 %, KM West 2024 %, Magnolia 2024 %, 2023s % / %, FY2025+ worst %',
    v_kme_2024, v_kmw_2024, v_mag_2024, v_kme_2023, v_kmw_2023, v_live_worst;
end $$;

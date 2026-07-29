-- 20240153_pcf_map_ret_recon_recovery
-- Map MR `4791-03 Recov - Property Taxes Recon` -> `recovery_other`.
--
-- WHY THIS ACCOUNT: it was the single largest remaining bridge gap. The residual identity
-- `residual + unmapped + non_cash_excluded = 0` holds for every property-year, and for FY2025
-- at Magnolia / KM East / KM West `non_cash_excluded` is 0.00 -- so their ENTIRE 2025 residual
-- was this one unmapped account.
--
-- TARGET CHOSEN BY THE TWO INDEPENDENT SIGNALS, WHICH DISAGREED:
--   (A) sibling  -> `4791-00`/`4791-02` map to `recovery_ret`, `4791-01` to `recovery_ret_lump`,
--       which would put this on `recovery_ret`.
--   (B) crosswalk -> MR `4791-03` pairs with TC `448900 "Prior Year Taxes"`, NOT with the
--       `437700 Real Estate Tax Recovs` that 4791-00/01/02 all pair with. The reverse direction
--       is 1:1 (448900 has exactly ONE MR parent, `4791-03`), which is the unanimity condition
--       required to trust a reverse crosswalk read.
-- The crosswalk wins, as it has on every prior conflict: this is a PRIOR-PERIOD true-up, not a
-- current-year RET recovery. `recovery_other` is literally labelled "Recovery - Other / Prior
-- Year" and already carries the TC prior-year accounts `448300` and `449300`, so no new line is
-- needed and the MR and TC charts meet at the same canonical line.
--
-- sign_factor = 1 for consistency with the 479x family. It is inert here: `4791-03` has NO rows
-- in `budget_lines`, and `v_pcf_gl_lines` ignores sign_factor by design (RULE 2).
-- No date window: this account has meant the same thing throughout, unlike `188900` (mig 20240151).
--
-- VERIFIED PER MONTH BEFORE APPLYING, because a year roll-up once hid a $191M monthly
-- fabrication. Simulated month by month across 2024-2026: FY2025 goes to EXACTLY 0.00 in every
-- month at all three properties; Magnolia FY2026 9,435.17 -> 46.83; KM East / KM West FY2026 -> 0.00.
-- This is NOT the `154300` net-zero trap: that account was a balance-sheet RECLASS whose both
-- halves sit in the bridge, so mapping it invented cash movement. `4791-03` is recovery INCOME
-- whose counterpart is cash/AR, so mapping it makes the bridge explain movement that did happen.
--
-- KNOWN, ACCEPTED REGRESSION: Magnolia 2024-12 residual 492,559.38 -> 504,387.77. That month is
-- already broken by a SEPARATE unpaired non-cash gap (Magnolia FY2024 non_cash_excluded
-- = -504,573.62); the correct mapping unmasks more of that gap rather than causing it. 2024 is a
-- non-cash pairing problem and is deliberately left loud.
--
-- POST-APPLY, MEASURED IN PROD (per month, all years):
--   FY2025 KM East / KM West / Magnolia  -> worst month 0.00, year 0.00, unmapped 0.00
--   FY2026 Magnolia 9,435.17 -> 46.83; KM East 0.03 -> 0.00; KM West -0.01 -> 0.00
--   FY2026 still ties portfolio-wide: ZERO months over $10k at any property
--   Gateway untouched in every year (TC chart, no 4791-03 activity)
--   USEFUL SIDE EFFECT: KM West 2024 and Magnolia 2024 now show unmapped = 0.00, so their
--   residuals are provably 100% unpaired non-cash -- the remaining 2024 problem is now isolated.

insert into public.pcf_account_map
  (property_id, account_code, line_key, sign_factor, section_override, effective_from, effective_to, notes)
values
  (null, '4791-03', 'recovery_other', 1, null, null, null,
   'Prior-period property-tax recovery true-up. Crosswalk pairs MR 4791-03 with TC 448900 Prior Year Taxes (1:1 reverse, unanimous), NOT with 437700 like its 4791-00/01/02 siblings -- so it lands on recovery_other ("Recovery - Other / Prior Year") alongside TC 448300/449300 rather than on recovery_ret. Closed the entire FY2025 bridge residual at Magnolia, KM East and KM West. Verified per month, not per year.')
on conflict do nothing;

do $$
declare
  v_rows        int;
  v_still_loud  int;
  v_worst       numeric;
  v_prop        text;
begin
  -- 1. the mapping landed, exactly once, globally
  select count(*) into v_rows
    from public.pcf_account_map
   where account_code = '4791-03' and line_key = 'recovery_other' and property_id is null;
  if v_rows <> 1 then
    raise exception '20240153: expected exactly 1 global mapping for 4791-03, found %', v_rows;
  end if;

  -- 2. it must have left the LOUD list (else it is invisible in both places, the one
  --    outcome the unmapped view exists to prevent)
  select count(*) into v_still_loud
    from public.v_pcf_gl_unmapped_accounts
   where account_code = '4791-03';
  if v_still_loud <> 0 then
    raise exception '20240153: 4791-03 still appears in v_pcf_gl_unmapped_accounts (% rows)', v_still_loud;
  end if;

  -- 3. THE REAL ASSERTION, PER MONTH: every property that had 4791-03 activity in 2025 must now
  --    tie for EVERY month of 2025, not merely for the year.
  select max(abs(b.residual)), max(p.name)
    into v_worst, v_prop
    from public.v_pcf_cash_bridge_check b
    join public.properties p on p.id = b.property_id
   where b.period_year = 2025
     and b.property_id in (select distinct property_id
                             from public.v_pcf_gl_activity
                            where account_code = '4791-03' and period_year = 2025);
  if coalesce(v_worst, 0) > 0.01 then
    raise exception '20240153: a 2025 month still fails to tie after mapping 4791-03 (worst abs residual % at %)', v_worst, v_prop;
  end if;

  raise notice '20240153 OK: 4791-03 -> recovery_other; all FY2025 months tie at every affected property (worst abs residual %)', coalesce(v_worst, 0);
end $$;

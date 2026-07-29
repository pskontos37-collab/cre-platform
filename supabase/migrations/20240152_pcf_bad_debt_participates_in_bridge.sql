-- 20240152_pcf_bad_debt_participates_in_bridge
-- bad_debt_reserve stops being excluded from the cash bridge.
--
-- WHY THE ORIGINAL FLAG WAS WRONG. is_non_cash exists so a line that hits net income without
-- moving cash is kept out of the bridge. That works when BOTH halves of the entry are non-cash:
-- depreciation expense and accumulated depreciation are both excluded, so they cancel and the
-- bridge is untouched. Bad debt is different - its counterpart is A/R, which IS a
-- cash-effective working-capital line. Excluding only the bad-debt half means a write-off
-- reduces A/R (read by the bridge as cash collected) with nothing to offset it, so THE BRIDGE
-- BOOKS A WRITTEN-OFF RECEIVABLE AS IF IT WERE COLLECTED. The flag was applied by analogy to
-- depreciation, and the analogy does not hold.
--
-- FOUND VIA Magnolia 2026-03, residual +1,092,322.69 with non_cash_excluded -1,092,322.69 -
-- exactly the negative, and nothing unmapped, which ruled out a missing mapping immediately.
-- One Urban Air bad-debt write-off of 1,088,307.19: MRI's cash-receipts module wrote A/R off
-- against 7136-00 Provision for Bad Debts (source CM, refs 230858/230859, 2026-03-06), then a
-- manual journal (source GP, ref 127740, 2026-03-08, "Adj Urban Air bad debt") reclassified it
-- to 1076-00 Allow for Uncollect Tenant Rec, leaving 1076-00 unpaired on a non-cash line.
--
-- CHECKED FIRST that no other non-cash line has the same flaw, because fixing one instance of a
-- class is not fixing the class. In 2026 the non-cash set pairs ACROSS lines, not within them:
--   nonop_interest_amort  0.00        rent_adjustments  0.00
--   depreciation -1,866,646.89 + amortization +1,507,184.61 + lease_intangible_amort
--     +359,462.28  =  exactly 0.00
--   bad_debt_reserve -1,098,290.82    <- the only unpaired exposure
--
-- RESULT, measured after applying - FY2026 ties across the whole portfolio, ZERO months over
-- $10k at any property:
--   Gateway  -2,248.15 (worst month 1,500.00)      KM East  0.03 (worst 0.03)
--   Magnolia  9,435.17 (worst month 9,388.34)      KM West -0.01 (worst 0.01)
-- 2025 is unchanged in character and still carries other unresolved residuals.
--
-- NOI AND NET INCOME DO NOT CHANGE. is_non_cash controls bridge participation only; the line
-- stays in section 'income' and computeTotals sums whole sections for NOI and net income.

update public.pcf_lines
   set is_non_cash = false
 where line_key = 'bad_debt_reserve';

comment on column public.pcf_lines.is_non_cash is
  'Excluded from the cash bridge. ONLY set this when BOTH halves of the entry are non-cash (depreciation vs accumulated depreciation), so they cancel. If the counterpart is a cash-effective line - as bad debt''s counterpart A/R is - excluding one half makes the bridge treat the movement as real cash. See mig 20240152.';

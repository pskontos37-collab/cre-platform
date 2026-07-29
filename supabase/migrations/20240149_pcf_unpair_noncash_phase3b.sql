-- 20240149_pcf_unpair_noncash_phase3b
-- Remove the 7 Phase 3b mappings that landed on an is_non_cash line without their matched
-- counterpart. Applied immediately after 20240148 so the sequence rebuilds to prod's state.
--
-- WHY. Phase 2 RULE 3: non-cash lines must be excluded in MATCHED PAIRS, because the GL holds
-- both halves - marking only the expense removes it from the bridge while its balance-sheet
-- counterpart stays in, and the cash identity silently drifts by exactly that amount.
--
-- Measured before and after applying 20240148, the identity (residual + unmapped) moved on
-- exactly three property-years, each by the size of a newly-mapped non-cash account:
--   Magnolia 2024   452,125 -> 1,101,915   (+649,790 = 7136-19 Bad Debt W/O - Pandemic)
--   KM East  2023   -49,992 ->    63,450   (7031-00 Financing Cost Amortization)
--   KM West  2023   -28,010 ->    37,532   (7031-00, same account, other entity)
-- Every other property-year was unchanged, and that is the tell: an ordinary mapping just
-- moves value from the unmapped bucket into the residual bucket, so their SUM is invariant.
-- Only a non-cash target breaks the identity, because it leaves BOTH buckets at once.
--
-- The counterparts are not identifiable today - no matching accumulated-depreciation or
-- allowance account appears anywhere in the unmapped set - so these 7 go back to being LOUD
-- rather than half-mapped. Pairing them is Phase 3c.
--
-- Accounts released: 6042-98, 6051-01, 6081-00, 6081-98 (depreciation), 7011-01 (amortization),
-- 7031-00 (deferred financing amortization), 7136-19 (bad debt write-off).
-- VERIFIED after the delete: all 16 property-years 2023-2026 returned to their exact
-- pre-20240148 values.

delete from public.pcf_account_map am
using public.pcf_lines l
where l.line_key = am.line_key
  and l.is_non_cash
  and am.notes like 'Phase 3b%'
  and am.property_id is null;

-- 20240150_pcf_unmap_acquisition_reclass
-- Release the acquisition-basis accounts back to unmapped. The cap_acquisition LINE stays.
--
-- WHY. v_pcf_cash_bridge_check tests the identity PER MONTH - it has a period_month column.
-- Phase 3b was verified per YEAR, which averaged away the actual failure:
--   154300 Building - Acq   -191,000,000 in 2019-02   then   +191,000,000 in 2019-04
--   2020-09: 188900 -172,969,918 alongside 154300 +126,900,661
-- Those are RECLASSIFICATIONS - the basis being moved between accounts - not cash leaving and
-- returning. cap_acquisition is section 'capital' with is_non_cash=false, so it participates in
-- the bridge, and mapping these accounts fabricated monthly cash movement that never happened:
-- Gateway 2019-04 residual +53,901,854 and 2020-09 -39,706,604.
--
-- The contamination cannot be separated at account granularity - 188900 holds BOTH real
-- acquisition cost and reversing reclass entries - so no per-account mapping is safe here.
-- They go back to loud.
--
-- cap_acquisition is KEPT (user-approved, and the concept is right: no existing capital line
-- covers buying the asset). It simply has no source accounts until a feed exists that separates
-- real acquisition cash from basis reclassification.
--
-- LESSON: a net-zero or year-balancing account can still wreck a per-month invariant. Verify
-- the bridge at the SAME granularity the view checks it.

delete from public.pcf_account_map
where property_id is null
  and line_key = 'cap_acquisition'
  and notes like 'Phase 3b%';

comment on column public.pcf_account_map.line_key is
  'Canonical PCF line. WARNING: before mapping an account into a bridge-participating line, check it PER MONTH - an account that nets to zero over a year can still fabricate monthly cash movement (154300 Building-Acq swings -191M/+191M across two months of 2019). See mig 20240150.';

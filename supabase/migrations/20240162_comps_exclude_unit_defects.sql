-- 20240162  Exclude comps cells with a UNIT defect from the assumption rollup
--
-- HIS CALL, 2026-07-30: "exclude them like the misaligned cells."
--
-- These are the cells 20240161 deliberately left alone. Unlike the misaligned cells, the
-- extractor read the RIGHT cell here - the loader then normalized it to the wrong UNIT, so
-- the stored number measures a different quantity than its `unit` column claims:
--
--   market_rent      '$107k/Year', '$1,750/month', '$2,000/Mo.'  -> usd_psf 107 / 1 / 2
--                    (annual totals and monthly rents recorded as rent per square foot)
--   rental_rate_increase  raw '0.5' -> 50 pct. The normalizer reads a bare decimal as a
--                    fraction, which is right for the rest of the corpus (0.03 -> 3 pct,
--                    0.025 -> 2.5, 0.02 -> 2) but makes 0.5 a 50% ANNUAL escalation. The
--                    sibling rows at 209 West Jackson spell the same assumption
--                    '.50/sf/year', i.e. a 50-CENT step, so 50% is not what was meant.
--   management_fee   '$90k', '$99K' -> 90 / 99 pct;  '$1.22/SF' -> 1.22 pct
--   capital_reserves '$300K / year', '$20K / month' -> usd_psf 300 / 20
--   tenant_improvements  350000 and 10356 usd_psf - total project dollars, not PSF
--   renewal_probability  'Assumed to renew at flat rate of $100' -> 100 pct. The $100 is
--                    the RENT; nothing in that sentence is a probability.
--
-- WHY EVIDENCE-FIRST RATHER THAN A MAGNITUDE TEST
-- The rules key off a contradicting unit token in raw_value wherever one exists, and fall
-- back to magnitude only where no token can exist. A pure magnitude test would have deleted
-- real data: 500 N Michigan's ground-floor retail at 425 and 375 usd_psf is what Michigan
-- Avenue actually rents for, 830 N Michigan's storefronts are 200, and a small-footprint
-- ATM at 204 and a kiosk at 200 are genuine. All of those carry a bare numeric raw_value
-- with no contradicting token, and all are verified to survive this migration.
--
-- ⚠️ ONE FALSE POSITIVE WAS FOUND AND EXCLUDED FROM THE RULE, do not simplify it away:
-- raw '6% / $6%' is a CORRECT 6% leasing commission with a typo'd dollar sign. Testing for
-- '$' alone caught 20 such cells. Hence the `not like '%\%%'` guard - a per-cent sign
-- anywhere means the percent reading is the intended one.
--
-- The ceiling of 25 for rental_rate_increase is safe by inspection, not by guess: the
-- highest legitimate value in the corpus is 3 pct, and the defective ones are all exactly
-- 50, so any ceiling between about 5 and 45 selects the same rows.
--
-- EFFECT ON REPORTED NUMBERS: 28 of 1,786 rollup groups change, every one a correction.
-- Predicted before applying - Missouri rental_rate_increase median 26.5 -> 1.5 pct and p75
-- 50 -> 3; Nevada tenant_improvements max 350,000 -> 40; Chicago tenant_improvements p75
-- 5,228 -> 100; Pennsylvania management_fee max 99 -> 4 pct; New York capital_reserves max
-- 300 -> 0.20; Indiana leasing_commissions max 50 -> 6 pct; Arkansas market_rent had a
-- single cell at 200 and empties. A few medians move slightly UP, because low-side garbage
-- goes too ('$1,750/month' had become 1.00 usd_psf).
--
-- Nothing is deleted. raw_value and scope_label are preserved and exclusion_reason records
-- the rule that fired, so any of this is reversible once the units are decided properly.
-- Setting value_kind = 'unparsed' is what removes a cell from comps.v_assumption_rollup,
-- which filters on value_kind in ('scalar','new_renew_pair','range').

with classified as (
  select
    a.id,
    case
      -- a per-SF cell whose own raw value says annual total, thousands, or per month
      when a.unit = 'usd_psf'
           and a.raw_value ~* '(k\s*/\s*(yr|year)|/\s*(yr|year)\b|/\s*mo)'
        then 'unit:total_or_monthly_not_psf'
      -- a percent cell carrying a dollar / per-SF marker and NO per-cent sign
      when a.unit in ('pct','pct_of_rent')
           and a.raw_value ~* '(\$|/\s*sf|psf|per\s*sf)'
           and a.raw_value not like '%\%%'
        then 'unit:dollar_not_pct'
      -- magnitudes impossible for the assigned unit whatever the spelling
      when a.metric = 'rental_rate_increase' and a.unit = 'pct'
           and coalesce(a.num_value, a.num_new, a.num_min) > 25
        then 'unit:escalation_over_25pct'
      when a.metric = 'leasing_commissions' and a.unit = 'pct_of_rent'
           and coalesce(a.num_value, a.num_new, a.num_min) > 20
        then 'unit:commission_over_20pct'
      when a.metric = 'tenant_improvements' and a.unit = 'usd_psf'
           and coalesce(a.num_value, a.num_new, a.num_min) > 500
        then 'unit:ti_over_500_psf'
    end as reason
  from comps.assumption a
  where a.exclusion_reason is null   -- never re-stamp a cell 20240161 already handled
)
update comps.assumption a
set exclusion_reason = c.reason,
    value_kind = case when a.value_kind in ('scalar','new_renew_pair','range')
                      then 'unparsed' else a.value_kind end,
    num_value  = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_value end,
    num_new    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_new end,
    num_renew  = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_renew end,
    num_min    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_min end,
    num_max    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_max end
from classified c
where c.id = a.id
  and c.reason is not null;

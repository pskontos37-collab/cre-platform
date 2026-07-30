-- 20240163  Exclude the unit defects 20240162 MISSED, and fix the reason it missed them
--
-- ⚠️⚠️ THE BUG THIS EXISTS TO CORRECT, WORTH REMEMBERING:
-- 20240162's middle alternative was  '/\s*(yr|year)\b'  and it NEVER MATCHED ANYTHING.
-- In Postgres POSIX regular expressions \b means BACKSPACE (chr 8), not a word boundary -
-- the word-boundary escape is \y. So that branch demanded a literal backspace after "yr".
-- Only the 'k\s*/\s*(yr|year)' and '/\s*mo' branches actually fired, and a whole family of
-- annual-total cells stayed live: '$250,000/yr.' as market_rent 250 usd_psf,
-- '$150,000/yr.' as 150 across 16 cells, '$225,000/yr.', '175,000/Year', '$180K $/yr.'.
-- A regex that silently matches nothing is invisible - it looks exactly like "no such rows
-- exist". Test the pattern against a known-positive string before trusting a zero count.
--
-- THE DISCRIMINATOR IS THE THOUSANDS-SCALE AMOUNT, NOT THE '/yr' TOKEN.
-- Simply fixing \b to \y would have been wrong too: '49/Year', '38/Year' and '37/Year' are
-- genuine per-SF annual rents and must survive. What marks an annual TOTAL is a
-- comma-grouped thousands figure or a K suffix, so that is what this tests.
--
-- THREE RULES, all verified against 362 known-legitimate rows with ZERO of them caught:
--   1. unit:annual_total_not_psf   unit=usd_psf and raw carries N,NNN or NK
--                                  '$250,000/yr.' -> 250, '$180K $/yr.' -> 180
--   2. unit:capital_reserve_total  capital_reserves usd_psf > 5. Real reserves in this
--                                  corpus sit at $0.20 median, and the bare offenders
--                                  ('100000' x15, '84510.676', '27100') carry no comma or
--                                  K for rule 1 to see. The 342 properly typed
--                                  '$0.20 psf/annually' style rows are all below 5.
--   3. unit:leading_dot_100x       a LOADER PARSE BUG, not a unit confusion: '$.50 Annually'
--                                  and '$.50/Yr' became 50.00, while '$0.50 Annually'
--                                  correctly becomes 0.50. The leading-dot decimal lost its
--                                  point - a 100x error. 8 cells.
--
-- ⚠️ 'ANNUALLY' IS NOT A DEFECT SIGNAL. Extending the token list to the spelled-out period
-- word was the obvious next move and it would have destroyed ~342 CORRECT rows:
-- '$0.50 psf Annually' -> 0.50 usd_psf is exactly right, and it is the normal spelling for
-- a properly typed per-SF annual step. Only '$60,000/Annually' is wrong, and rule 1 and 2
-- already catch it on the amount.
--
-- EFFECT: 93 cells marked, 30 of them in a rank-1 row. 20 of 1,785 rollup groups change and
-- no group empties, so the row count stays 1,785 and cells go 27,636 -> 27,606. Predicted
-- before applying. Every change is a correction:
--   Massachusetts market_rent   median 83.50 -> 22.50, max 225 -> 55
--   California capital_reserves max 100,000 -> 1.00
--   Indiana    capital_reserves max  27,100 -> 0.50
--   Virginia   capital_reserves max      60 -> 0.25
--   Connecticut market_rent     max     175 -> 35
--   Illinois   market_rent      max     180 -> 55  and  175 -> 70
--
-- Same mechanism as 20240161/20240162: nothing deleted, raw_value and scope_label kept,
-- exclusion_reason records which rule fired, value_kind -> 'unparsed' is what drops a cell
-- out of comps.v_assumption_rollup.

with classified as (
  select
    a.id,
    case
      when a.unit = 'usd_psf'
           and (a.raw_value ~ '[0-9],[0-9]{3}' or a.raw_value ~* '[0-9]\s*k\y')
        then 'unit:annual_total_not_psf'
      when a.metric = 'capital_reserves' and a.unit = 'usd_psf'
           and coalesce(a.num_value, a.num_new, a.num_min) > 5
        then 'unit:capital_reserve_total'
      when a.raw_value ~ '^\$?\.[0-9]+'
           and coalesce(a.num_value, a.num_new, a.num_min) >= 10
        then 'unit:leading_dot_100x'
    end as reason
  from comps.assumption a
  where a.exclusion_reason is null
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

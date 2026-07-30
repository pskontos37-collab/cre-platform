-- 20240161  Exclude misaligned comps cells from the assumption rollup
--
-- WHY
-- scripts/dryrun_argus4.ps1 took its category columns from every non-empty cell on the
-- "Category" row out to the full Excel UsedRange width, and searched for each assumption
-- label starting AT that header row. Two consequences, fixed in the extractor by commits
-- 9a66070 and 4196440, but the rows they already produced are still in this table:
--
--   shape 1  a table sitting to the right of the assumptions block had its header row
--            line up, so Suite / Tenant / RSF / Start Date became "categories" and the
--            values were read out of the foreign table. Sullivan Center recorded
--            rent_abatements = 61956 MONTHS, which is the suite's RSF, and 44986 months,
--            which is an Excel date serial for 2023-02-15.
--   shape 2  an assumption-label name leaked into the Category row - 'Tenant
--            \nImprovements', 'Term (Yr.)', 'Rental Rate', 'Annual Step', and 'Category'
--            itself. These carry embedded newlines from wrapped cells.
--   shape 3  a spilled dollar total or ratio landed in the Category row - '10440000'
--            carried tenant_improvements = -2146826265, an Int32 underflow sentinel.
--
-- Separately, a handful of values are impossible under ANY unit reading and are excluded
-- on that basis alone, because their category label looks legitimate so the shape tests
-- above do not reach them: 3200 Central's rent_abatements = 148295 months (406 years of
-- free rent) arrived under the extractor's 'col4' fallback name, used when no Category
-- row is found at all.
--
-- WHAT THIS DOES NOT DO
-- It does not touch cells that were read from the RIGHT column but normalized to the
-- wrong UNIT. Those are a different defect and need a decision about the correct unit,
-- not deletion: '.50/sf/year' became rental_rate_increase = 50 pct when it is a 50-CENT
-- annual step (26 rows), '$500K/yr' and '$350k/Year' became market_rent = 500 and 350
-- usd_psf when they are annual totals, '$500/mo.' is monthly, and Silverado Ranch's
-- Kirkland TI of 350000 is a total dollar amount rather than PSF.
-- Nor does it touch legitimately high values: 500 N Michigan's ground-floor retail at
-- 425 and 375 usd_psf is what Michigan Avenue retail actually rents for.
--
-- EFFECT ON REPORTED NUMBERS: NONE.
-- comps.v_assumption_rollup filters to version_rank = 1, so it only reads the latest
-- model per property. Of the 255 affected value-bearing cells only 6 are in a rank-1 row,
-- and every median and p25 the rollup publishes is byte-identical before and after -
-- verified per metric before this migration was written. This is corpus hygiene that
-- brings the stored rows in line with the corrected extractor; it also stops these cells
-- from silently becoming live later if an older model ever becomes a property's latest.
--
-- Nothing is deleted. raw_value and scope_label are preserved so every excluded cell
-- stays auditable, and exclusion_reason records why. Setting value_kind = 'unparsed' is
-- what removes a cell from the rollup, which filters on
-- value_kind in ('scalar','new_renew_pair','range').

alter table comps.assumption
  add column if not exists exclusion_reason text;

comment on column comps.assumption.exclusion_reason is
  'Why this cell is excluded from the rollup. Set by 20240161 for cells the Argus '
  'extractor read out of the wrong column. raw_value is retained for audit.';

with lab as (
  -- the same label vocabulary the extractor uses, so this stays in step with $LABELS
  select unnest(array[
    'renewal\s*prob', 'down\s*time|downtime', '^market\s*rent', 'reimburse',
    'tenant\s*improve', 'leasing\s*comm', 'rent\s*abate|free\s*rent', 'term\s*length',
    'rental\s*rate\s*incr|rent\s*bump|increases'
  ]) as rx
),
classified as (
  select
    a.id,
    case
      when btrim(a.scope_label) ~* '^(suite|suite ?#|tenant|tenant name|start date|end date|expir\w*|rsf|sq\.? ?ft\.?|square feet|lease id|notes?|comments?|subtotal)$'
        then 'misaligned:structural_header'
      when btrim(a.scope_label) ~ '^\d{5}$'
           and btrim(a.scope_label)::int between 42000 and 46800
        then 'misaligned:date_serial_header'
      when exists (select 1 from lab where btrim(a.scope_label) ~* lab.rx)
        or btrim(a.scope_label) ~* '(^rental\s*rate$|annual\s*step|abate|^term\b|term\s*\(|^categor|reimburs|^market\s*rent$)'
        then 'misaligned:assumption_label_header'
      -- Numeric floor at 20000 keeps real category names: '8888', '9000', '8900' are
      -- suite-numbered categories and '48', '36', '27' are rent tiers.
      when btrim(a.scope_label) ~ '^\d+$'
           and length(btrim(a.scope_label)) <= 9
           and btrim(a.scope_label)::bigint >= 20000
        then 'misaligned:numeric_spill_header'
      when btrim(a.scope_label) ~ '^\d+\.\d+$'
        then 'misaligned:ratio_spill_header'
      -- impossible under any unit reading, regardless of how the label looks
      when a.metric = 'rent_abatements'     and a.unit = 'months'  and coalesce(a.num_value, a.num_new, a.num_min) > 600
        then 'impossible:abatement_over_50_years'
      when a.metric = 'downtime_months'     and a.unit = 'months'  and coalesce(a.num_value, a.num_new, a.num_min) > 600
        then 'impossible:downtime_over_50_years'
      when a.metric = 'term_length'         and a.unit = 'months'  and coalesce(a.num_value, a.num_new, a.num_min) > 1200
        then 'impossible:term_over_100_years'
      when a.metric = 'tenant_improvements' and a.unit = 'usd_psf' and coalesce(a.num_value, a.num_new, a.num_min) < 0
        then 'impossible:negative_ti'
    end as reason
  from comps.assumption a
)
update comps.assumption a
set exclusion_reason = c.reason,
    -- Only the three kinds the rollup reads are switched to 'unparsed'. 'vocab', 'at_year'
    -- and 'none' rows are already outside the rollup, so they are annotated but otherwise
    -- left intact rather than having their vocab_value discarded.
    value_kind = case when a.value_kind in ('scalar','new_renew_pair','range')
                      then 'unparsed' else a.value_kind end,
    num_value  = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_value end,
    num_new    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_new end,
    num_renew  = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_renew end,
    num_min    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_min end,
    num_max    = case when a.value_kind in ('scalar','new_renew_pair','range') then null else a.num_max end
from classified c
where c.id = a.id
  and c.reason is not null
  and a.exclusion_reason is distinct from c.reason;

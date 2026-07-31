-- 20240168  Burlington Coat Factory (KM WEST) - finish applying the controlling 2024
--           Minimum Rent scale to base_rent_schedule rows 11-15 and 16-20.
--
-- ⚠️ TARGETED BY property_id. There are TWO 'Burlington Coat Factory' abstracts:
--    KM West (00000000-0000-0000-0000-000000000011), 20,086 sf  <- THIS ONE
--    Gateway Port Chester (d5a4ed03-...), 25,000 sf, qa_status 'review', EMPTY schedule
--    A tenant_name-keyed update would hit both. See 20240167 for what a misdirected
--    write costs.
--
-- WHY: Lease Article 1.G contains TWO Minimum Rent tables, verified VERBATIM in three
-- independent lease_original documents (da6baba4, 0353e582, bf0a8c8c):
--
--   standard:  1-5 $16.50 | 6-10 $17.25 | 11-15 $18.00 | 16-20 $18.75 | 21-25 $19.50 | 26-30 $20.25
--   2024:      1-5 $16.50 | 6-10 $17.00 | 11-15 $17.75 | 16-20 $18.50 | 21-25 $19.25 | 26-30 $20.00
--
-- "Notwithstanding the foregoing to the contrary, in the event Tenant opens for business
--  in the Premises during the calendar year 2024, then 'Minimum Rent' shall mean: [2024]"
--
-- Rent Commencement Date is 2024-10-17 per the EXECUTED Commencement Date Agreement
-- (recital iii), confirmed by MRI. Tenant therefore opened during calendar 2024 and the
-- 2024 table controls every tier.
--
-- This is a CONTINUATION, not a new judgment: `overrides` already carried
-- base_rent_schedule.1.psf=17 / .annual=341462 / .monthly=28455.17, i.e. Years 6-10 were
-- already moved to the 2024 scale by an earlier pass that then stopped. Rows 11-15 and
-- 16-20 were left on the standard scale, so the stored schedule was MIXED across two
-- mutually exclusive tables - wrong under either reading.
--
-- Annual/monthly are the lease's OWN printed figures, and they tie to 20,086 sf exactly:
--   20,086 x 17.75 = 356,526.50 ; /12 = 29,710.54
--   20,086 x 18.50 = 371,591.00 ; /12 = 30,965.92
--
-- ⚠️ NOT TOUCHING options[].psf, AND THERE IS A STRUCTURAL DEFECT LEFT OPEN. The option
-- rents are also off-scale (18.75 / 19.50 / 20.25 are standard-table values), but which
-- 2024 tier each option maps to depends on an unresolved question that needs a human:
--
--   Article 1.H makes the Initial Term ~10 years (ending the last day of February after
--   the 10th anniversary of RCD = 2035-02-28, matching the executed CDA AND MRI, and the
--   abstract's own term_years=10). Article 1.I grants FOUR successive 5-year options.
--   10 + 20 = 30 years = exactly the table's six 5-year tiers. That implies:
--     Initial Term = Years 1-10 (two tiers) and the four options = Years 11-15, 16-20,
--     21-25, 26-30 - which would also SUPPLY the Option 4 rent the abstract flags as
--     unknown ($20.00), and would mean base_rent_schedule should hold only TWO rows.
--   BUT the table's own OCR'd grouping labels read "Initial Term:" over 1-5...16-20 and
--   "Extended Term(s) ... if exercised:" over only 21-25 and 26-30 - i.e. a 20-year
--   initial term with TWO options, which contradicts 1.H and 1.I. The abstractor followed
--   that visual grouping (its option[1] cites "Article 1.G (Extended Term rows 21-25)"),
--   which is the root cause of the off-by-two-tier option mapping.
--   Consequence today: base_rent_schedule asserts contractual rent through Year 20 even
--   though the abstract's own expiration is 2035-02-28, so Years 11-20 are double-booked
--   as both base term AND Option 1. That inflates committed term for WALT and forward
--   rent projections.
--   Resolving it means truncating a 30-year schedule on an OCR layout inference, so it is
--   deliberately left for a human read of the executed table's actual page layout.
--   ⚠️ QA half-saw this: it correctly computed "Initial 10 + four 5-yr = 30 yrs" and then
--   still mapped Option 1 to Years 21-25. Do not adopt QA's option mapping.

update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule.2.psf',     17.75,
      'base_rent_schedule.2.annual',  356526.50,
      'base_rent_schedule.2.monthly', 29710.54,
      'base_rent_schedule.3.psf',     18.50,
      'base_rent_schedule.3.annual',  371591.00,
      'base_rent_schedule.3.monthly', 30965.92
    )
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Burlington Coat Factory';

-- VERIFIED after applying, against a prediction made before writing (3 keys -> 9):
--   KM West Burlington  overrides = 9 keys (base_rent_schedule .1/.2/.3 x psf/annual/monthly)
--   Gateway Burlington  overrides = NULL, untouched

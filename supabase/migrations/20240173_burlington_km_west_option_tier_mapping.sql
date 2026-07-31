-- 20240173  Burlington Coat Factory (KM WEST) - SORT THE OPTION TIER MAPPING.
--           Closes the structural defect 20240168 deliberately left open.
--
-- THE DEFINITION THAT SETTLES IT, verified VERBATIM in all three lease_original copies
-- (0353e582 / bf0a8c8c / da6baba4, chunk 1004):
--
--   "All Extended Terms shall run from March 1st following the expiration of the Initial
--    Term or the applicable Extended Term. "Lease Year" means: (i) for the first Lease
--    Year, the period commencing on the Rent Commencement Date and ending on the last day
--    of the February next following the anniversary of the Rent Commencement Date; and
--    (ii) for each Lease Year thereafter, the twelve month period commencing on March 1st
--    and ending on the last day of the next February thereafter."
--
-- Lease Years therefore run March 1 - end of February, and so do the Extended Terms. With
-- RCD 2024-10-17 (executed CDA, confirmed by MRI):
--   LY1  = 2024-10-17 .. 2026-02-28   (long first year, ~16.4 months)
--   LY5  ends 2030-02-28 ; LY10 ends 2035-02-28
-- and 2035-02-28 is EXACTLY the Initial Term expiration in Article 1.H ("last day of
-- February next following the tenth anniversary of the Rent Commencement Date"), which
-- MRI and the abstract's own term_years=10 already agreed on.
--
-- => THE INITIAL TERM IS LEASE YEARS 1-10 = TWO rent tiers, not four.
-- => The four Article 1.I options map ONE-TO-ONE onto the remaining four tiers:
--      Option 1  2035-03-01..2040-02-29  LY11-15  $17.75  $356,526.50  $29,710.54
--      Option 2  2040-03-01..2045-02-28  LY16-20  $18.50  $371,591.00  $30,965.92
--      Option 3  2045-03-01..2050-02-28  LY21-25  $19.25  $386,655.50  $32,221.29
--      Option 4  2050-03-01..2055-02-28  LY26-30  $20.00  $401,720.00  $33,476.67
--    Every option is exactly one 5-lease-year tier - no straddling, no approximation.
--    This also SUPPLIES THE OPTION 4 RENT the abstract flagged as unknown: the table does
--    cover it ($20.00), the mapping was just off by two tiers.
--
-- All rates are from the controlling 2024 table (tenant opened in calendar 2024 - see
-- 20240168). Annual/monthly are the lease's own printed figures and tie to 20,086 sf.
--
-- WHAT WAS WRONG: base_rent_schedule asserted contractual rent through LY20 while the
-- abstract's own expiration was 2035-02-28, so LY11-20 were DOUBLE-BOOKED as both base
-- term and Option 1/2 - inflating committed term for WALT and forward rent. The option
-- PSFs were also standard-scale AND shifted two tiers (18.75/19.50/20.25). Root cause:
-- the abstractor followed the rent table's OCR-flattened column-group labels, which put
-- "Extended Term(s) if exercised:" over only the 21-25 and 26-30 rows; its option[1] even
-- cites "Article 1.G (Extended Term rows 21-25)". The Lease Year definition overrides that
-- visual grouping. QA's own mapping was ALSO wrong here (it kept Option 1 at LY21-25
-- while itself computing "Initial 10 + four 5-yr = 30 yrs") - do not adopt it.
--
-- ⚠️ THE 9 DOT-PATH KEYS FROM 20240168 MUST BE DELETED, NOT JUST SUPERSEDED. jsonb orders
-- object keys by (length, bytes) and applyOverrides() iterates in that order, so a whole
-- 'base_rent_schedule' key (18 chars) is applied BEFORE 'base_rent_schedule.1.psf' (24) -
-- the leftover dot-paths would re-create indices 2 and 3 on top of the new 2-row array and
-- silently restore the defect. Verified the key ordering before writing this.
--
-- Option 1's end date is corrected 2040-02-28 -> 2040-02-29 (2040 IS a leap year, and LY15
-- ends "the last day of the next February"). 2045/2050/2055 are not leap years.
--
-- notice_by for Options 2-4 were NULL; filled from Article 22's 9-months-before-expiration
-- mechanic and LABELLED as computed. Option 1 keeps MRI's RETAILRR-verified 2034-06-03 per
-- the MRI-is-system-of-record rule (Article 22 arithmetic would give 2034-05-28).
-- ⚠️ These options AUTO-EXERCISE unless Tenant serves notice of NON-exercise, so each date
-- is a TENANT DECLINE deadline, not a landlord action date - landlord_reminder_required
-- stays false.

update lease_abstracts
set overrides = (
      coalesce(overrides::jsonb, '{}'::jsonb)
        - 'base_rent_schedule.1.psf'     - 'base_rent_schedule.1.annual' - 'base_rent_schedule.1.monthly'
        - 'base_rent_schedule.2.psf'     - 'base_rent_schedule.2.annual' - 'base_rent_schedule.2.monthly'
        - 'base_rent_schedule.3.psf'     - 'base_rent_schedule.3.annual' - 'base_rent_schedule.3.monthly'
    ) || jsonb_build_object(

      'base_rent_schedule', jsonb_build_array(
        jsonb_build_object('start','2024-10-17','end','2030-02-28','psf',16.50,
                           'annual',331419.00,'monthly',27618.25,'months',64),
        jsonb_build_object('start','2030-03-01','end','2035-02-28','psf',17.00,
                           'annual',341462.00,'monthly',28455.17,'months',60)
      ),

      'options', jsonb_build_array(
        jsonb_build_object(
          'term','Extension Option 1 (5 years) - Lease Years 11-15',
          'start','2035-03-01','end','2040-02-29',
          'psf',17.75,'annual',356526.50,'monthly',29710.54,'status','open',
          'section','Lease Article 1.G (2024 Minimum Rent table, Lease Years 11-15); Article 1.I; Article 22',
          'notice_by','2034-06-03',
          'notice_period','9 months prior to expiration of the Initial Term (AUTOMATIC exercise unless Tenant serves notice of non-exercise)',
          'notice_by_basis','MRI Option Data (RETAILRR-verified notice_deadline 2034-06-03; notice_days_required 270). Article 22 arithmetic would give 2034-05-28, being 9 months before the 2035-02-28 Initial Term expiration; MRI governs as system of record.',
          'exercise_evidence',null,'landlord_reminder_required',false),
        jsonb_build_object(
          'term','Extension Option 2 (5 years) - Lease Years 16-20',
          'start','2040-03-01','end','2045-02-28',
          'psf',18.50,'annual',371591.00,'monthly',30965.92,'status','open',
          'section','Lease Article 1.G (2024 Minimum Rent table, Lease Years 16-20); Article 1.I; Article 22',
          'notice_by','2039-05-29',
          'notice_period','9 months prior to expiration of the preceding Extended Term (AUTOMATIC exercise unless Tenant serves notice of non-exercise)',
          'notice_by_basis','COMPUTED, NOT MRI-VERIFIED: 9 months before the 2040-02-29 expiration of Extended Term 1, per Article 22. MRI carries no notice_deadline for this option.',
          'exercise_evidence',null,'landlord_reminder_required',false),
        jsonb_build_object(
          'term','Extension Option 3 (5 years) - Lease Years 21-25',
          'start','2045-03-01','end','2050-02-28',
          'psf',19.25,'annual',386655.50,'monthly',32221.29,'status','open',
          'section','Lease Article 1.G (2024 Minimum Rent table, Lease Years 21-25); Article 1.I; Article 22',
          'notice_by','2044-05-28',
          'notice_period','9 months prior to expiration of the preceding Extended Term (AUTOMATIC exercise unless Tenant serves notice of non-exercise)',
          'notice_by_basis','COMPUTED, NOT MRI-VERIFIED: 9 months before the 2045-02-28 expiration of Extended Term 2, per Article 22. MRI carries no notice_deadline for this option.',
          'exercise_evidence',null,'landlord_reminder_required',false),
        jsonb_build_object(
          'term','Extension Option 4 (5 years) - Lease Years 26-30',
          'start','2050-03-01','end','2055-02-28',
          'psf',20.00,'annual',401720.00,'monthly',33476.67,'status','open',
          'section','Lease Article 1.G (2024 Minimum Rent table, Lease Years 26-30); Article 1.I; Article 22',
          'notice_by','2049-05-28',
          'notice_period','9 months prior to expiration of the preceding Extended Term (AUTOMATIC exercise unless Tenant serves notice of non-exercise)',
          'notice_by_basis','COMPUTED, NOT MRI-VERIFIED: 9 months before the 2050-02-28 expiration of Extended Term 3, per Article 22. MRI carries no notice_deadline for this option. NOTE: the abstract previously recorded this option as having no itemized rent; the Minimum Rent table DOES cover it at Lease Years 26-30 ($20.00 psf) once the tier mapping is corrected.',
          'exercise_evidence',null,'landlord_reminder_required',false)
      )
    )
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Burlington Coat Factory';

-- VERIFIED after applying, against a prediction made before writing (9 keys -> 2):
--   overrides          = 2 keys, ZERO leftover 'base_rent_schedule.%' dot-paths
--   base_rent_schedule = 4 rows -> 2 rows, last row ends 2035-02-28 = term.expiration
--                        exactly, so the LY11-20 double-booking is gone
--   options            = 4, psf 17.75 / 18.50 / 19.25 / 20.00
--                        annual 356,526.50 / 371,591.00 / 386,655.50 / 401,720.00
--   Gateway Burlington = untouched (0 override keys)

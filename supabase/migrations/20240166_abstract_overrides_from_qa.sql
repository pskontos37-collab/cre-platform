-- 20240166  Two QA-backed abstract corrections via the `overrides` mechanism
--
-- Working the 29 'issues' abstracts. This applies ONLY the two findings that are
-- unambiguous, currently live, and backed by a source that outranks the abstract.
-- Everything else in the queue is reported rather than written, because it needs either
-- a judgment call or a document nobody has yet located - see the notes at the bottom.
--
-- USES `overrides`, NOT a mutation of `abstract`. That is the designed correction path
-- (35 abstracts already carry overrides) and it survives regeneration - verified: all
-- five abstracts I regenerated on 2026-07-31 kept their pre-existing overrides.
-- Dot-path syntax with numeric segments for arrays, e.g. "options.0.notice_by",
-- "base_rent_schedule.1.psf" - NOT bracket syntax.
-- jsonb || merges, so existing keys are preserved; only the named paths are added.

-- 1. The Good Feet Store - term.expiration
--    ⚠️ THIS IS A REGRESSION I INTRODUCED TODAY. The 2026-07-31 re-abstraction (run
--    because OCR gave its source docs 43 new text chunks) moved expiration from
--    2029-03-31 to 2029-03-25, rent_commencement from 2024-04-01 to 2019-03-02, and
--    original_commencement from 2018-09-04 to 2018-08-04.
--    MRI is the system of record and shows commencement 2024-04-01 / expiration
--    2029-03-31. The PRIOR abstract had it right and explicitly flagged the tenant
--    exercise letters' "March 25, 2029" as a discrepancy; the regenerated one silently
--    ADOPTED the letters' date over MRI. QA independently reached the same conclusion:
--    "2029-03-25 is the abstractor's arithmetic (5yr - 1 day). MRI shows 2029-03-31."
--    This abstract's OWN options override already asserts end=2029-03-31 and
--    start=2024-04-01, so leaving term.expiration at 2029-03-25 made the record
--    internally contradictory.
update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(
      'term.expiration',            '2029-03-31',
      'term.rent_commencement',     '2024-04-01',
      'term.original_commencement', '2018-09-04'
    )
where tenant_name = 'The Good Feet Store';

-- 2. Woodhouse Day Spa - percentage_rent.breakpoint_type
--    The abstract says 'natural'. $2,650,000 is a STATED Percentage Rent Base from the
--    original lease's definitions, not a natural breakpoint derived from Minimum Rent
--    divided by the 4% rate - a natural breakpoint against current rent of $196,914
--    would be ~$4.9M. So it is artificial, and the distinction changes when percentage
--    rent starts accruing.
--    Precedent: Kirkland's already carries exactly this override key/value pair, so this
--    is the established treatment for this corpus rather than a new judgment.
update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(
      'percentage_rent.breakpoint_type', 'artificial'
    )
where tenant_name = 'Woodhouse Day Spa';

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT WRITTEN HERE, and why. Each is verified as still live against the
-- current abstract value, so these are open items, not stale noise:
--
--   Target  tenant_allowance.exists=false while QA cites an express $3,141,915.00 cash
--           Allowance payable 30 days after Delivery Date. A $3.1M allowance is too
--           material to assert from a QA note alone - read the Lease clause first.
--   Target  square_footage 89,781 vs the executed Lease's 89,297 (38,179 upper +
--           51,118 lower). Two defensible figures from different instruments; picking
--           one changes rent PSF everywhere. Needs his call on which governs.
--   Woodhouse options.0.notice_by - QA computes 2034-07-31 (12 months before the
--           2035-07-31 expiration); an EXISTING override deliberately sets 2035-07-31 to
--           match MRI. Durable rule 4 makes MRI the system of record for option dates,
--           but QA's point is that MRI's notice_deadline here IS the term end, i.e. the
--           wrong field. Flipping a deliberate override on that basis needs a human.
--   Shake Shack tenant_allowance.total 188,122 - QA calls it invented and computes
--           $40 x 3,350 = $134,000. But $134,000 + the $54,122 Additional Allowance =
--           188,122 EXACTLY, the same combined-figure pattern as Woodhouse's
--           237,900 + 10,000 = 247,900. The abstract is probably right and QA wrong.
--           DO NOT "correct" this without reading the allowance clauses.
--   Burlington Coat Factory - four rent tiers and three option PSFs allegedly mis-scaled
--           because the tenant opened in 2024 so the 2024 table controls. ⚠️ There are
--           TWO Burlington abstracts at different properties (SF 20,086 and 25,000);
--           any fix must target one by property_id, not by tenant_name.
--   VITAMIN SHOPPE 39 / Old Navy #4885 exclusives.exists=false while QA cites a real
--           covenant (Second Amendment §9 for Vitamin Shoppe; apparel exclusive for Old
--           Navy). Exclusives drive co-tenancy and leasing restrictions - confirm
--           against the instrument before flipping.
--   Rack Room Shoes #474 - QA reports the Second Amendment PDF appears EXECUTED
--           (signed, DocuSign) which would extend the term past 2027-01-31 and DELETE
--           the co-tenancy provisions. Whether that amendment is legally effective is a
--           legal determination, not a data fix.
--   BANK OF AMERICA PNY53240000 - its QA findings are OBSOLETE. They describe an
--           abstract naming Hudson Wine and Liquor with a BEV MAX trade name and a
--           2032-04-30 expiration; the live abstract correctly reads Bank of America,
--           N.A. with expiration 2027-08-31, matching MRI. Fixed ~7/29 by a direct edit.
--           ⚠️ THAT EDIT DID NOT MOVE generated_at, so `qa_at >= generated_at` is NOT a
--           valid staleness test for this table. Re-run abstract-verify to clear it.
-- ---------------------------------------------------------------------------

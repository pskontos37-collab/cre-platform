-- 20240176  Three more abstracts recorded tenant_allowance.exists=FALSE while their own
--           leases grant a landlord-funded allowance. Same failure mode as Target
--           (20240175), found by sweeping the whole corpus rather than one record.
--
-- HOW THEY WERE FOUND, and why this is systemic rather than three mistakes:
-- lease-abstract reads long documents through doc_briefs. Target's brief is 8,946 chars
-- summarising a 639,503-char lease (71:1), and THE BRIEF SCHEMA HAS NO ALLOWANCE FIELD AT
-- ALL - its keys are parties/premises/term_effects/rent_effects/option_effects/
-- guaranty_effects/assignment_effects/critical_dates/clauses/chain/quality etc. So a
-- landlord TI or construction allowance is structurally invisible to the abstractor
-- whenever the granting document is read via its brief. Re-abstracting does NOT fix it.
-- Sweep used: abstracts whose effective tenant_allowance.exists='false' but whose
-- source_doc_ids contain kind='text' chunks matching a grant pattern. 17 candidates, of
-- which 10 are BOILERPLATE FALSE POSITIVES and are correctly left as false:
--   * seven KM leases share renewal wording "...any articles which were intended to be one
--     time, initial provisions or concessions (such as free Rent, Landlord Work, or a
--     Tenant improvement allowance) shall be deemed to have been satisfied and shall not
--     apply to the Additional Term" - which CONFIRMS no allowance in the extension
--     (JEMBRO/DAVES DOLLAR, VERIZON 168503, Salt Grass, New Japanese Express, Best Buy,
--     Rainbow, Wade Jurney Home);
--   * Kirkland's #523 - reletting-damages boilerplate about a successor tenant's allowance;
--   * ULTA 594 - SNDA boilerplate that the LENDER is not obligated to fund any allowance;
--   * Kay Jewelers - its own lease summary says "Tenant Improvement Allowance N/A".
-- Do not "fix" those ten. The four below with explicit rates are real; three are written
-- here and the fourth (Bank of America) is left for a follow-up because its Construction
-- Allowance amount is defined by reference and no figure was located.
--
-- 1. REGAL CINEMAS (Magnolia) - THE LARGEST LANDLORD OBLIGATION FOUND IN THIS CORPUS.
--    Verbatim: "...by Eighty-Five Dollars ($85.00) per square foot. Based upon the estimate
--    that the Demised Premises will contain approximately 80,518 square feet, the projected
--    Construction Allowance will be Six Million Eight Hundred Forty Four Thousand Thirty
--    Dollars ($6,844,030.00). ... Should the Cost of Tenant's Construction exceed the
--    Construction Allowance, Landlord shall pay the excess ... not to exceed an additional
--    Ten Dollars ($10.00) per square foot of Floor Area, resulting in a maximum limit on
--    the Construction Allowance of Ninety-Five Dollars ($95.00) per square foot."
--    $85.00 x 80,518 = $6,844,030 exactly, matching the lease's own projection. Ceiling
--    $95.00 x 80,518 = $7,649,210.
--    ⚠️ OBSERVATION FOR THE OWNER, NOT A CLAIM: Magnolia's JV carries a $6.84M preferred
--    equity piece. $6,844,030 is the same number. That may be coincidence or the pref may
--    have been sized to fund this TI - worth checking, not asserting.
--
-- 2. BLUE CROSS BLUE SHIELD (Magnolia) - SS3.3: "Landlord shall contribute ... an amount
--    equal to Fifty and 00/00 Dollars ($50.00) per square foot of the Premises (the
--    'Construction Allowance')". Paid 50% at 50% completion (on contractor certification)
--    with the balance later. $50.00 x 2,200 sf = $110,000.
--
-- 3. EMBASSY NAILS (KM West) - "Landlord agrees to provide a monetary Tenant Improvement
--    Allowance ('TIA') equal to thirty seven and 50/100 Dollars ($37.50) per square foot".
--    Conditional on Tenant delivering an insurance certificate naming Landlord and
--    Crosland LLC, the building permit and CO, the contractor's final pay application, and
--    a final lien waiver. $37.50 x 1,996 sf = $74,850.
--
-- ⚠️ THESE RECORD LEASE TERMS, NOT OPEN LIABILITIES. All three are older leases and the
-- allowances were most likely funded years ago; nothing here asserts an unpaid balance.
-- Confirming payment needs an AP/GL check. What was wrong is the abstract stating no
-- allowance exists, which understates the deal economics and the landlord's obligations.
--
-- Square footage: for all three the abstract SF equals the latest rent-roll SF (80,518 /
-- 2,200 / 1,996), so there is no SF conflict to resolve under the owner's rent-roll rule.
-- None of the three is locked or human_verified; none already had a tenant_allowance
-- override, so the || merge adds the key and preserves their existing overrides.

update lease_abstracts
set overrides = coalesce(overrides::jsonb,'{}'::jsonb) || jsonb_build_object(
      'tenant_allowance', jsonb_build_object(
        'exists', true, 'total', 6844030.00, 'psf', 85.00,
        'notes', $q$Construction Allowance, Lease SS4.x: "...by Eighty-Five Dollars ($85.00) per square foot. Based upon the estimate that the Demised Premises will contain approximately 80,518 square feet, the projected Construction Allowance will be Six Million Eight Hundred Forty Four Thousand Thirty Dollars ($6,844,030.00)." The allowance scales with actual remeasured Floor Area at $85.00/sf. ESCALATION: if the Cost of Tenant's Construction exceeds the allowance, Landlord pays the excess up to an additional $10.00/sf, capping the allowance at $95.00/sf = $7,649,210 on 80,518 sf. This is a LEASE TERM, not an assertion of an unpaid balance - this is an older lease and the allowance was most likely funded long ago; confirm against AP/GL. Missed originally because the abstractor reads this lease via its doc_brief and the brief schema has no allowance field.$q$
      ))
where property_id = 'd4f08824-2d88-472d-b7aa-a703310c2aaf' and tenant_name = 'Regal Cinemas';

update lease_abstracts
set overrides = coalesce(overrides::jsonb,'{}'::jsonb) || jsonb_build_object(
      'tenant_allowance', jsonb_build_object(
        'exists', true, 'total', 110000.00, 'psf', 50.00,
        'notes', $q$Construction Allowance, Lease SS3.3: "Landlord shall contribute, subject to the terms hereof, towards the costs incurred by Tenant to construct Tenant's Initial Work an amount equal to Fifty and 00/00 Dollars ($50.00) per square foot of the Premises (the 'Construction Allowance')." Applied only to labor and materials for Tenant's Initial Work; any excess cost is at Tenant's sole cost. DISBURSEMENT: 50% due 30 days after Tenant's contractor certifies the Initial Work is at least 50% complete per Tenant's Plans, balance on the stated later milestone; conditional on Tenant not being in default. total 110,000 = $50.00 x 2,200 sf (abstract SF, which equals the latest rent-roll SF). LEASE TERM, not an assertion of an unpaid balance - confirm funding against AP/GL.$q$
      ))
where property_id = 'd4f08824-2d88-472d-b7aa-a703310c2aaf' and tenant_name = 'Blue Cross Blue Shield';

update lease_abstracts
set overrides = coalesce(overrides::jsonb,'{}'::jsonb) || jsonb_build_object(
      'tenant_allowance', jsonb_build_object(
        'exists', true, 'total', 74850.00, 'psf', 37.50,
        'notes', $q$Tenant Improvement Allowance: "Landlord agrees to provide a monetary Tenant Improvement Allowance ('TIA') equal to thirty seven and 50/100 Dollars ($37.50) per square foot ('PSF')." CONDITIONS PRECEDENT - the TIA is provided only after Landlord receives (1) Tenant's liability insurance certificate naming Landlord and Crosland, LLC as additional insureds, (2) the Building Permit and Certificate of Occupancy for the Premises, (3) the bill or final pay application from Tenant's general contractor for the completed work, and (4) a final lien waiver in the Exhibit B-1 form. total 74,850 = $37.50 x 1,996 sf (abstract SF, which equals the latest rent-roll SF). LEASE TERM, not an assertion of an unpaid balance - confirm funding against AP/GL.$q$
      ))
where property_id = '00000000-0000-0000-0000-000000000011' and tenant_name = 'Embassy Nails';

-- VERIFIED after applying, against predictions made before writing:
--   Blue Cross Blue Shield  3 -> 4 override keys ; exists true, total 110,000.00,  psf 50.00
--   Embassy Nails           2 -> 3 override keys ; exists true, total  74,850.00,  psf 37.50
--   Regal Cinemas           2 -> 3 override keys ; exists true, total 6,844,030.00, psf 85.00
--   every pre-existing override key preserved on all three, and an independent
--   SF x psf recomputation reproduced each stored total exactly.

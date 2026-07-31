-- 20240175  Target (GATEWAY) - record the $2,842,335 Allowance, and point the "not
--           located" open items at the full lease that was in the corpus all along.
--
-- 1. tenant_allowance.exists was FALSE. That is a material error - the executed Lease
--    grants a cash allowance. VERIFIED VERBATIM in the full lease (doc
--    27b9739f-7c63-4db4-9722-0c3fa2eac4d1, chunks 1056-1057), SS6.3(C):
--
--      "Allowance. As an inducement for Tenant to consummate this Lease, Landlord shall
--       pay to Tenant a cash allowance (the "Allowance") in the amount of Two Million
--       Eight Hundred Forty-Two Thousand Three Hundred [Thirty]-Five and 00/100 Dollars
--       ($2,842,335.00). ... Landlord must disburse the entire Allowance to Tenant within
--       thirty (30) days after the Delivery Date. Landlord shall provide reasonably
--       satisfactory evidence to Target for Landlord's actual out-of-pocket costs
--       (including contractor fees) for performance of Exhibit C, Part 3.3. If and to the
--       extent that such cost is less than $300,000.00, the Allowance shall be increased
--       by the amount of such savings."
--
--    ⚠️ THE STATED FIGURE IS $2,842,335.00 - NOT the $3,141,915.00 the QA note asserts.
--    QA was RIGHT that the allowance exists and WRONG by $299,580 on the amount. Writing
--    QA's number would have overstated a landlord obligation by that much. The two are
--    related, which is almost certainly where QA's figure came from:
--        2,842,335 + 299,580 = 3,141,915
--    i.e. $3,141,915 is the TRUED-UP allowance if Landlord's Exhibit C Part 3.3 costs came
--    in $299,580 below the $300,000 threshold. That is a contingent increase requiring the
--    cost reconciliation as evidence; no such reconciliation is in the corpus. So the
--    STATED amount goes in the field and the increase mechanism goes in notes.
--
-- 2. ROOT CAUSE, and it unlocks several other open items. The abstract was built from a
--    TRUNCATED excerpt: its own open_items say the raw-text excerpt "was truncated at
--    40,000 of 99,615 characters; full Articles 4, 5, 6 (Improvements/Alterations), 7-16
--    were not fully captured". Article 6 is exactly where SS6.3 Allowance lives - hence
--    exists=false. But a COMPLETE copy of the same lease was in the corpus the whole time:
--    doc 27b9739f, 213 pages, 468 text chunks, 639,503 characters. Confirmed present in
--    it: Article 9 (Assignment and Subletting), Article 13 (Insurance and Indemnities),
--    and the Exclusive Use provisions - all three of which the abstract reports as "not
--    located ... obtain full text". Those open items are rewritten to name the document
--    instead of asking for one. (The Rent Commencement Date Confirmation Agreement really
--    is absent - checked - so that item stands.)
--
-- 3. square_footage stays 89,781. Owner direction 2026-07-31: the RENT ROLL's RSF governs.
--    The 2026-06 rent roll shows suite 038 at 89,781 sf, and its own $20.40 psf x 89,781 =
--    $1,831,532.40 ties to the annual rent, so the figure is internally corroborated. The
--    executed Lease recital's 89,297 sf (38,179 upper + 51,118 lower) is a known variance.
--    The open item is converted from CONFIRM to RESOLVED so it stops asking.
--
-- 4. base_rent_schedule[0].annual $1,831,532.40 / .monthly $152,627.70 are flagged by QA as
--    "fabricated" because Exhibit E is blank in the document. They are NOT fabricated -
--    they are MRI's, matching the 2026-06 rent roll exactly ($20.40 x 89,781; /12 =
--    152,627.70). abstract-verify cannot see MRI, so this is the known verifier/abstractor
--    source asymmetry, not a data defect. Recorded as an informational open item.
--
-- parseOpenItems() only treats a leading "DISCREPANCY:" or "CONFIRM:" as flagging; any
-- other prefix parses as severity 'info'. RESOLVED:/NOTE: are therefore safe and will not
-- raise red worklist items.

update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(

      'tenant_allowance', jsonb_build_object(
        'exists', true,
        'total',  2842335.00,
        'psf',    31.66,
        'notes',  $q$Lease SS6.3(C): "As an inducement for Tenant to consummate this Lease, Landlord shall pay to Tenant a cash allowance (the 'Allowance') in the amount of ... $2,842,335.00." Disbursement: Landlord must pay the ENTIRE Allowance within thirty (30) days after the Delivery Date (Delivery was 2021-06-01 per the Certificate of Completion, so this obligation is long since due - confirm it was paid). Usable by Tenant for planning, developing, constructing and installing Tenant's Improvements and Tenant's Property. CONTINGENT INCREASE: Landlord must give Target satisfactory evidence of Landlord's actual out-of-pocket costs for Exhibit C Part 3.3; to the extent that cost is less than $300,000.00, the Allowance INCREASES by the savings - so the maximum is $3,142,335.00. ⚠️ The QA note asserts $3,141,915.00; that is NOT the stated figure. It equals $2,842,335 + $299,580, i.e. the trued-up amount if Exhibit C Part 3.3 came in $299,580 under the threshold. No cost reconciliation is in the corpus, so the STATED $2,842,335.00 is recorded here and the increase is flagged rather than assumed. psf 31.66 = 2,842,335 / 89,781 sf (rent-roll RSF, which governs per owner direction); on the Lease recital's 89,297 sf it would be $31.83.$q$
      ),

      'open_items', jsonb_build_array(
        'DISCREPANCY: [term.original_commencement] Lease Effective Date is stated as 2020-06-15 in the Lease recitals, Memorandum of Lease, and both SNDA/attornment agreements with DPPC Holdings and NYLIC, but one raw-text draft excerpt and one Space Tenant SNDA brief instead state the Lease/Agreement date as 2020-07-15. The 2020-06-15 date is used here as it is corroborated by the greater number of executed, recorded instruments (MOL, First Amendment to MOL, and the NYLIC SNDA).',
        'DISCREPANCY: [term.expiration] Initial Term Expiration is stated as 2035-12-31 in one base-lease brief and as 2035-11-30 in the unbriefed raw-text lease excerpt, while MRI system of record shows current lease_end as 2038-01-31 (reflecting RCD of 2021-06-01 + 15 Lease Years measured on a Feb-Jan Lease Year cycle). MRI governs per abstraction method; document-stated Initial Term Expiration dates are noted as superseded/inconsistent with the RCD-driven calculation.',
        'RESOLVED: [square_footage] 89,781 sf governs. Owner direction 2026-07-31 is that the RENT ROLL''s RSF controls over a lease-stated figure. The 2026-06 rent roll carries suite 038 at 89,781 sf, and its own $20.40 psf x 89,781 = $1,831,532.40 ties exactly to the annual rent, so the figure is internally corroborated. The executed Lease recital states 89,297 sf (38,179 upper + 51,118 lower) and an older Q1 2020 asset report says 89,769 sf; both are recorded variances, not defects. Expect abstract-verify to keep raising this - it reads documents only.',
        'NOTE: [base_rent_schedule] The $1,831,532.40 annual / $152,627.70 monthly figures are MRI-sourced, NOT fabricated. Exhibit E is blank in the executed document, so abstract-verify (which sees documents but not MRI) reports them as unsupported. They match the 2026-06 rent roll exactly: $20.40 psf x 89,781 sf = $1,831,532.40, and /12 = $152,627.70. Known verifier/abstractor source asymmetry.',
        'CONFIRM: [assignment_subletting] Article 9 (Assignment and Subletting) was not captured when this abstract was built - but it IS present in the full lease, doc 27b9739f-7c63-4db4-9722-0c3fa2eac4d1 (213 pages, 468 text chunks). Re-abstract against that document rather than requesting the text.',
        'CONFIRM: [insurance] Article 13 (Insurance and Indemnities) was not captured when this abstract was built - but it IS present in the full lease, doc 27b9739f-7c63-4db4-9722-0c3fa2eac4d1. Re-abstract against that document rather than requesting the text.',
        'CONFIRM: [exclusives.remedies] The Tenant Exclusive remedy language was not captured when this abstract was built - but Exclusive Use provisions ARE present in the full lease, doc 27b9739f-7c63-4db4-9722-0c3fa2eac4d1. Re-abstract against that document rather than requesting the text.',
        'NOTE: [method] ROOT CAUSE OF THE GAPS ABOVE - this abstract was built from a TRUNCATED excerpt (the "[pp.1-12]" raw-text copy, cut at 40,000 of 99,615 characters, missing Articles 4, 5, 6 and 7-16) while a COMPLETE copy of the same lease was already in the corpus: doc 27b9739f-7c63-4db4-9722-0c3fa2eac4d1, 213 pages / 468 text chunks / 639,503 characters. That truncation is why tenant_allowance.exists was false - Article 6 holds SS6.3. RE-ABSTRACTING TARGET AGAINST THE FULL DOCUMENT is the single highest-value remaining action on this record.',
        'MISSING FROM FILE: No executed Rent Commencement Date Confirmation Agreement (per Lease SS3.1(C) / Exhibit L template) was located - re-checked against the full lease document and it is genuinely absent. RCD is therefore sourced from MRI system of record rather than an executed confirmation.',
        'MISSING FROM FILE: No Certificate of Occupancy or standalone Landlord''s Work Letter (dated December 6, 2019, referenced repeatedly) was located as a standalone document in the file inventory beyond references within the Certificates of Completion.',
        'CONFIRM: [percentage_rent], [sales_reporting] - though the Lease clearly states no percentage rent/sales reporting obligation, confirm this remains unchanged as no amendment altering Article 3 was located.'
      )
    )
where property_id = 'd5a4ed03-0b60-4168-9208-83822dd24884'
  and tenant_name = 'Target';

-- VERIFIED after applying, against a prediction made before writing (0 keys -> 2):
--   tenant_allowance = exists true, total 2842335.00, psf 31.66
--   open_items       = 10 -> 11 ; 2 DISCREPANCY, 4 CONFIRM, 3 RESOLVED/NOTE, 2 MISSING
--   the $3,141,915 figure is NOT asserted anywhere in the record

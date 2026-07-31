-- 20240174  Burlington Coat Factory (KM WEST) - drop two now-FALSE self-flags and fix
--           two miscategorised correspondence items. Cleanup after 20240173.
--
-- The 20240173 re-verify (2026-07-31 23:39) CONFIRMED the whole corrected mapping -
-- base_rent_schedule[0] and [1], options[0].psf 17.75, options[3].psf 20.00,
-- term.expiration 2035-02-28, term_years 10, four options - and QA independently restated
-- the same tier mapping: "the four options map to Years 11-15, 16-20, 21-25, 26-30, fully
-- covered". What it flagged instead were two stale self-flags and a taxonomy slip.
--
-- 1. open_items[0] claimed the 4th option's rent (as "Years 31-35") is not itemized
--    because the table stops at Years 26-30. THAT PREMISE DIED WITH THE OFF-BY-TWO-TIER
--    MAPPING. The options are Years 11-15 / 16-20 / 21-25 / 26-30, so all four ARE
--    itemized and Option 4 is $20.00 psf. QA: "the 2024 table does cover Years 26-30 at
--    $20.00, so all four option tiers are itemized (contra the open_item suggesting a
--    Years 31-35 gap)". Removed.
--
-- 2. open_items[6] said 'exclusives.exists=true but exact_language does not quote a
--    landlord-restricting covenant ... this must be exists=false'. QA rejects that:
--    the bath-and-linen and infant-furniture-and-accessories covenants DO restrict the
--    landlord/other occupants for this Tenant's benefit, so exists=true is correct and
--    "No change to exclusive substance needed - the flag is the error." Removed.
--    ⚠️ Note this is the OPPOSITE conclusion to Vitamin Shoppe / Old Navy, where
--    exists=false was correct. The test is whether a covenant BINDS THE LANDLORD for this
--    tenant's benefit - not whether the word "exclusive" appears.
--
-- 3. lease_documents[5] and [6] are categorised 'operative'. Both are correspondence and
--    their own notes say so ("correspondence, not separately abstracted as an amendment"
--    and "(correspondence)"): the Section 1(E) Target Delivery Date extension election
--    letter and the Section 21(E) delivery notice. Recategorised to 'ancillary' so they
--    stop counting as operative instruments. The Memorandum of Lease, MetLife SNDA and
--    AT&T ROE were already correctly 'ancillary' and are left alone.
--
-- Whole-value overrides for open_items and lease_documents; every retained entry is
-- reproduced verbatim. No economic field is touched by this migration.

update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(

      'open_items', jsonb_build_array(
        'CONFIRM: [rea_pma.pma_manager] Property management agreement term on file (2019-07-15 to 2020-07-31) predates the Burlington lease (2024) - confirm current PMA term/fee with M&J Wilkow Properties, LLC.',
        'CONFIRM: [estoppel.executed_on_file] No tenant estoppel certificate specific to this Lease was located in the file (only the REA-level estoppels and the executed SNDA); confirm whether a Tenant estoppel has since been delivered in connection with any subsequent financing/sale.',
        'CONFIRM: [tenant_allowance] Landlord''s Work is a turnkey buildout obligation (Exhibit C/C-1) rather than a stated cash TI allowance; no specific dollar or PSF allowance figure is stated in the file - confirm whether a supplemental cash allowance exists.',
        'CONFIRM: [additional_rights_notes] Verify current status/payment of the $29,694.76 settlement amount from the 2025-06-10 Settlement Agreement to ensure no continuing default exists. The 2025-04-29 default notice, the settlement agreement itself and the CBRE invoices are referenced but are NOT in the document corpus - obtain them.',
        'NOT FULLY REVIEWED: [none] - all documents in the file inventory were reviewed via briefs or attached PDFs; no items are flagged as title-only or truncated beyond the noted OCR quality issues (see quality notes in briefs, e.g., garbled Exhibit C-2/C-3/C-4/E sign-fabrication OCR and partially illegible CDA source scan) which did not prevent abstraction of substantive terms.'
      ),

      'lease_documents', jsonb_build_array(
        jsonb_build_object('date','2024-04-16','type','Lease Agreement','signed','Y','category','operative',
          'notes','Base lease between BBK Midtown Commons, LLC (Landlord) and Burlington Coat Factory Warehouse Corporation (Tenant); Guaranty by Burlington Stores, Inc. at Article 38, signed by Michael Shanahan, SVP-Real Estate.'),
        jsonb_build_object('date','2024-04-16','type','Commencement Date Agreement','signed','Y','category','operative',
          'notes','Fixes Commencement Date 2024-09-18, initial term expiration 2035-02-28, and Rent Commencement Date 2024-10-17. Signed by Marc R. Wilkow (Landlord) and Jeff Morrow, VP of Real Estate (Tenant, DocuSigned).'),
        jsonb_build_object('date','2024-05-06','type','Memorandum of Lease','signed','Y','category','ancillary',
          'notes','Recorded notice of the Lease; recites 10-year initial term with four 5-year options; restrictive covenants (Section 4) run with land; notarized 2024-04-26 (Tenant) and 2024-05-06 (Landlord).'),
        jsonb_build_object('date','2024-05-09','type','Subordination, Nondisturbance and Attornment Agreement (MetLife)','signed','Y','category','ancillary',
          'notes','Subordinates Lease to MetLife Real Estate Lending LLC first mortgage (up to $34,000,000); preserves Tenant''s co-tenancy Alternate Rent/termination rights and casualty termination rights; executed by Lender, Tenant (4/12/2024), and Landlord (5/21/2024).'),
        jsonb_build_object('date','2024-07-22','type','Right of Entry (ROE) Agreement - AT&T Services Inc.','signed','partial','category','ancillary',
          'notes','Grants AT&T fiber install rights to serve Tenant''s service order at no cost; signature lines appear blank in copy on hand though names are printed.'),
        jsonb_build_object('date','2024-07-09','type','Landlord Notice - Target Delivery Date Extension Election','signed','Y','category','ancillary',
          'notes','Landlord''s notice exercising the Section 1(E) option to extend the Target Delivery Date from 9/27/2024 to 1/3/2025. CORRESPONDENCE, not an operative instrument - recategorised from operative to ancillary per taxonomy discipline (it amends no lease term).'),
        jsonb_build_object('date','2024-09-13','type','Landlord Delivery Notice (Section 21(E))','signed','Y','category','ancillary',
          'notes','Notice of intended substantial completion/delivery date of 10/4/2024. CORRESPONDENCE, not an operative instrument - recategorised from operative to ancillary per taxonomy discipline.')
      )
    )
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Burlington Coat Factory';

-- VERIFIED after applying, against a prediction made before writing (2 keys -> 4):
--   open_items      7 -> 5 ; no "31-35" text ; no "must be exists=false" self-flag
--   lease_documents operative 4 -> 2, ancillary 3 -> 5
--   20240173 mapping untouched: 2 rent rows, option psf 17.75/18.50/19.25/20.00

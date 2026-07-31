-- 20240172  Rack Room Shoes #474 - make the NARRATIVE fields agree with the data fields.
--
-- 20240169 adopted the Second Amendment in term/rent/co_tenancy/exclusives but left
-- critical_dates, open_items and termination_kickout still describing it as "unexecuted".
-- The re-verify (2026-07-31 22:59) confirmed every corrected data field AND flagged the
-- leftover contradiction twice: "The abstract's own open_items and critical_dates
-- repeatedly hedge this as 'unexecuted' - internally inconsistent with the abstracted
-- expiration and rent schedule which adopt the Second Amendment terms."
--
-- ⚠️ THE OPERATIONAL BUG THIS FIXES: critical_dates still carried 2027-01-31 as
-- "Lease expiration", so anything reading the abstract's dates (critical-dates radar,
-- renewal workflow) would show a 2027 expiry and raise renewal work that no longer
-- exists - while term.expiration already said 2037-01-31. A stale narrative field is not
-- cosmetic when a workflow reads it.
--
-- Whole-value overrides again (dotless key = replace whole value, per applyOverrides()).
-- All six critical_dates and all pre-existing open_items are reproduced; only the four
-- hedging dates are rewritten, and only the now-answered execution question is dropped.
-- One open item is ADDED for the real remaining gap found while verifying: MRI has the
-- extension term but not the extension rent.

update lease_abstracts
set overrides = overrides || jsonb_build_object(

      'critical_dates', jsonb_build_array(
        jsonb_build_object('date','2020-06-30',
          'event','Guaranteed Minimum Rent Abatement Period Expiration (rent recommences 7/1/2020)',
          'source','First Lease Amendment SS1(h), SS2'),
        jsonb_build_object('date','2022-02-01',
          'event','First Amendment Extension Period commences; GMR $144,095/yr begins',
          'source','First Lease Amendment SS3(b); MRI system of record'),
        jsonb_build_object('date','2027-01-31',
          'event','End of the First Amendment Extension Period rent tier - NOT a lease expiration. The Second Amendment (EFFECTIVE, owner-confirmed 2026-07-31) continues the Term without a gap to 2037-01-31.',
          'source','First Lease Amendment SS3(a), superseded by Second Amendment R-2'),
        jsonb_build_object('date','2027-02-01',
          'event','Second Amendment Extension Term commences; GMR steps to $187,950.00/yr ($15,662.50/mo)',
          'source','Second Amendment R-2 and SS3(a) (executed)'),
        jsonb_build_object('date','2032-02-01',
          'event','GMR steps to $210,504.00/yr ($17,542.00/mo)',
          'source','Second Amendment SS3(a) (executed)'),
        jsonb_build_object('date','2037-01-31',
          'event','LEASE EXPIRATION (Second Amendment Revised Expiration Date). No further extension options are granted.',
          'source','Second Amendment R-2 (executed)')
      ),

      'open_items', jsonb_build_array(
        'CONFIRM: [percentage_rent.breakpoint] First Lease Amendment (current 2022-2027 term) does not restate a percentage-rent breakpoint for the Extension Period; natural breakpoint of $4,385,500 (Original Lease SS3.03, Years 11-15) may not be current - obtain updated breakpoint calculation for the 2022-2027 term. (The 2027-2037 extension breakpoints ARE stated: $6,265,000 then $7,016,800 per Second Amendment SS3(b).)',
        'CONFIRM: [rea_pma] License Agreement for Unit F storage (2022-12-15) - end date truncated in file metadata (''January...''); confirm exact expiration date and full executed copy (one signature line appears blank in copy on hand).',
        'DISCREPANCY: [term.rent_commencement] Estoppels (2019, 2024) both state rent commenced 2006-10-12, but no executed Commencement Date Agreement/Addendum (contemplated under Original Lease SS2.07) was located in the file to independently confirm this date against the lease formula (earlier of 60 days after Completion Date or store opening).',
        'MISSING FROM FILE: Executed Commencement Date Agreement/Lease Addendum referenced in Original Lease SS2.07 (to formally establish commencement/expiration dates) does not appear in the file inventory.',
        'CONFIRM: [exclusives / use_restrictions_on_tenant] The Second Amendment SS5 revised tenant-exclusive schedule does not name its granting exhibit legibly - the exhibit letter is lost to OCR truncation. Confirm the exact exhibit reference against the executed original.',
        'MRI GAP: [base_rent_schedule] MRI carries the extension TERM (2026-07 rent roll has a second future-term row for suite D3 running 2027-02-01 to 2037-01-31) but NOT the extension RENT - that row has NULL base rent, so the Second Amendment SS3(a) steps ($187,950.00 then $210,504.00) still need loading into MRI.'
      ),

      'termination_kickout', jsonb_build_object(
        'exists', true,
        'section', 'Original Lease SS5.02 (surviving); SS2.10 and SS1.09-1.11 no longer available',
        'details', $q$TENANT HAS NO REMAINING TERMINATION RIGHT. (1) The SS2.10 economic kickout was a one-time Year-3 right (Gross Sales under $750,000) measured from a 2006 commencement - long since lapsed. (2) The co-tenancy cancellation right under SS1.09-1.11 is GONE: Second Amendment SS4 deletes those sections in their entirety, and that amendment is EFFECTIVE (owner-confirmed 2026-07-31). (3) The Family Shoe Store exclusive termination remedy in SS5.04(c) is also deleted, by Second Amendment SS5(y); the SS5.04(b) abatement remedy survives but is a rent remedy, with termination available only if a violation continues 90 days after notice. WHAT SURVIVES IS A LANDLORD RIGHT, NOT A TENANT ONE: Original Lease SS5.02 recapture if Tenant goes dark 90+ consecutive days after the first year of operation, exercisable within 60 days on 30 days' notice, voidable if Tenant reopens within 30 days of notice. exists=true reflects that surviving SS5.02 landlord recapture right only.$q$
      )
    )
where property_id = '00000000-0000-0000-0000-000000000010'
  and tenant_name = 'Rack Room Shoes #474';

-- VERIFIED after applying, against a prediction made before writing (7 keys -> 10):
--   overrides                 = 10 keys
--   "unexecuted" appears NOWHERE in critical_dates / open_items / termination_kickout
--   2037-01-31 event          = "LEASE EXPIRATION (Second Amendment Revised Expiration Date)..."
--   2027-01-31 event          = "End of the First Amendment Extension Period rent tier - NOT a
--                                lease expiration..."
--   term.expiration still 2037-01-31 ; co_tenancy.exists still false ; 6 dates, 6 open items

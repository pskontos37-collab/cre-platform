-- 20240169  Rack Room Shoes #474 (KM EAST) - give effect to the Second Amendment.
--
-- DECISION: the owner confirmed on 2026-07-31 that the Second Amendment IS EFFECTIVE.
-- The abstract had treated it as UNEXECUTED ("Tenant signature blank, effective date
-- blank") and therefore kept the First Amendment's 2027-01-31 expiration and the
-- Original Lease co-tenancy. QA read the same PDF as SIGNED (John Dolson, VP Real
-- Estate, DocuSign; Landlord Marc R. Wilkow; Effective Date "May 5, 2026"). The owner
-- resolved that conflict in favour of executed. Everything written below is verified
-- VERBATIM against the Second Amendment text (doc e6275a4f-3374-4f1b-bc76-b56be5835fa6),
-- not taken from the QA note.
--
--   R-2  "...for one (1) additional period of one hundred twenty (120) full calendar
--         months ... commencing on February 1, 2027 ... and expiring on January 31, 2037"
--   3(a) "February 1, 2027 to January 31, 2032  $187,950.00  $15,662.50
--         February 1, 2032 to January 31, 2037  $210,504.00  $17,542.00"
--   3(b) "The Breakpoint for (i) the period of February 1, 2027 [to] January 31, 2032 is
--         $6,265,000; and (ii) the period of February 1, 2032 [to] January 31, 2037 is
--         $7,016,800."
--   4    "Co-Tenancy. Section 1.09, Section 1.10, and Section 1.11 of the Original Lease
--         are hereby deleted in their entirety and shall be of no further force or effect."
--   5    Restrictive Covenant rewritten: Landlord shall not lease to another tenant
--         occupying LESS than 19,000 sf for Family Shoe Store use; may lease to occupants
--         over 19,000 sf even if a Family Shoe Store; Section 5.04(c) DELETED; "Family
--         Shoe Store" redefined as >50% of that store's annual Gross Sales from
--         name-brand footwear; three tenants/categories expressly permitted.
--
-- ARITHMETIC TIES (independent corroboration that the quoted table is real):
--   187,950 / 6,265 sf = $30.00 psf exactly ; 187,950 / 12 = 15,662.50
--   210,504 / 6,265 sf = $33.60 psf exactly ; 210,504 / 12 = 17,542.00
--   Breakpoints are each rent / 3%: 187,950/.03 = 6,265,000 ; 210,504/.03 = 7,016,800
--
-- WHOLE-VALUE overrides are used for base_rent_schedule / co_tenancy / percentage_rent /
-- exclusives rather than indexed dot-paths, because two rent rows must be APPENDED and a
-- whole-array write sets every field atomically. Verified against the real merge in
-- src/pages/AbstractsPage.tsx applyOverrides(): it splits the key on "." and assigns
-- o[last] = val, so a DOTLESS key replaces the whole value, and a JSON null is honoured.
-- Precedent: Old Navy and Vitamin Shoppe both carry a whole-array "base_rent_schedule"
-- override. Every pre-existing sub-field is reproduced so nothing is silently dropped.
--
-- term_years 5 -> 15: current_term_start stays 2022-02-01 and expiration becomes
-- 2037-01-31, which is 15 years - this is arithmetic, not a new judgment. (If the field
-- is ever redefined to mean "length of the newest extension period only", it should read
-- 10 for the 120-month Second Amendment Extension Term.)
--
-- ⚠️ CO-TENANCY IS THE CONSEQUENTIAL ONE. Deleting Original Lease 1.09-1.11 removes the
-- Key Tenant (Target / Ross / Bed Bath & Beyond / Michael's) abatement-to-4%-of-sales
-- remedy AND Tenant's right to cancel on 60 days' notice. That is a RISK REDUCTION for
-- the landlord and it must stop showing on the co-tenancy radar for this lease.
--
-- ⚠️ DOWNSTREAM, NOT DONE HERE: MRI / the rent roll still carry lease_end 2027-01-31 and
-- the `leases` row is unchanged, so WALT and the critical-dates radar still see a 2027
-- expiry. Those need updating separately - this migration only corrects the abstract.

update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(
      'term.expiration', '2037-01-31',
      'term.term_years', 15,
      'term.expiration_basis', $q$Second Amendment to Lease R-2 (EXECUTED - owner-confirmed 2026-07-31): Lease Term extended one additional period of 120 full calendar months commencing 2027-02-01 and expiring 2037-01-31. Supersedes the First Lease Amendment 2027-01-31 date. NOTE: MRI rent roll still shows lease_end 2027-01-31 and needs updating to 2037-01-31.$q$,

      'base_rent_schedule', jsonb_build_array(
        jsonb_build_object('start','2022-02-01','end','2023-01-31','psf',23,'annual',144095,'monthly',12007.92,'months',12),
        jsonb_build_object('start','2023-02-01','end','2024-01-31','psf',23,'annual',144095,'monthly',12007.92,'months',12),
        jsonb_build_object('start','2024-02-01','end','2025-01-31','psf',23,'annual',144095,'monthly',12007.92,'months',12),
        jsonb_build_object('start','2025-02-01','end','2026-01-31','psf',23,'annual',144095,'monthly',12007.92,'months',12),
        jsonb_build_object('start','2026-02-01','end','2027-01-31','psf',23,'annual',144095,'monthly',12007.92,'months',12),
        jsonb_build_object('start','2027-02-01','end','2032-01-31','psf',30.00,'annual',187950.00,'monthly',15662.50,'months',60),
        jsonb_build_object('start','2032-02-01','end','2037-01-31','psf',33.60,'annual',210504.00,'monthly',17542.00,'months',60)
      ),

      'co_tenancy', jsonb_build_object(
        'exists', false,
        'section', 'Second Amendment SS4 (deletes Original Lease SS1.09, SS1.10, SS1.11)',
        'exact_language_and_remedies', $q$DELETED. Second Amendment SS4: "Section 1.09, Section 1.10, and Section 1.11 of the Original Lease are hereby deleted in their entirety and shall be of no further force or effect." The Second Amendment is EFFECTIVE (owner-confirmed 2026-07-31), so there is NO operative co-tenancy provision for the current or future term. Removed by that deletion: the Key Tenant condition (Target 110,000 sf, Ross 28,000 sf, Bed Bath & Beyond 20,000 sf, Michael's 20,000 sf), the abatement of GMR/Percentage Rent to 4% of Gross Sales after 180 consecutive days of two-or-more Key Tenant closure, the Landlord termination right after 360 days of abatement, and Tenant's right to cancel on 60 days' notice. HISTORICAL ONLY - do not surface on the co-tenancy radar. The Adjacent Tenancy restriction in Original Lease SS5.03 (no food/beverage, pet shop, beauty salon, amusement arcade, adult book store or movie theater within 60 feet of the Premises) was NOT deleted and remains in force.$q$,
        'replacement_tenants_permitted', 'Moot - the co-tenancy provisions are deleted.'
      ),

      'percentage_rent', jsonb_build_object(
        'applicable', true,
        'rate_pct', 3,
        'start', '2022-02-01',
        'end', '2037-01-31',
        'section', 'Original Lease SS3.03; Second Amendment SS3(b)',
        'breakpoint', $q$Second Amendment SS3(b) sets STATED dollar Breakpoints for the extension term: $6,265,000 for 2027-02-01 to 2032-01-31, and $7,016,800 for 2032-02-01 to 2037-01-31. Each happens to equal that period's annual GMR divided by the 3% rate ($187,950/.03 and $210,504/.03), so they are numerically natural but are STATED in the instrument. For the current First Amendment period (2022-02-01 to 2027-01-31) no dollar breakpoint is restated in any executed document; Original Lease SS3.03 gave $4,385,500.00 for Option Lease Years 11-15.$q$,
        'breakpoint_type', 'artificial',
        'notes', $q$Original Lease SS3.03 sets 3% of Gross Sales in excess of Breakpoint; the 2024-01-05 estoppel confirms 3% over the breakpoint "as set forth in the Lease" without restating the dollar figure for the current term. Sales reported annually per correspondence on file. Second Amendment SS3(b) fixes the breakpoints for the 2027-2037 extension.$q$
      ),

      'exclusives', jsonb_build_object(
        'exists', true,
        'section', 'Original Lease SS5.04(a)-(b) as REWRITTEN by Second Amendment SS5 (SS5.04(c) deleted)',
        'exact_language', $q$Second Amendment SS5 (controlling): "Notwithstanding anything to the contrary contained in Section 5.04 of the Original Lease, so long as Tenant is open and operating in the Premises for the Permitted Use ... Landlord shall not lease space to any other tenant which occupies less than 19,000 [square feet of gross leasable area for a Family Shoe Store]. For the avoidance of doubt, (x) Landlord may lease space within the Landlord's Parcel to any tenant or occupant occupying more than 19,000 square feet of gross leasable area notwithstanding that such tenant's primary use may constitute a Family Shoe Store; and (y) Section 5.04(c) of the Original Lease is hereby deleted in its entirety." "Family Shoe Store" is redefined to mean a retail store whose primary use is the display and sale of name-brand footwear for men, women and/or children, where such footwear sales constitute more than fifty percent (50%) of that tenant's annual Gross Sales from the applicable premises.$q$,
        'remedies', $q$Original Lease SS5.04(b) remedy survives: if Landlord leases to a Family Shoe Store operator, GMR and Additional Rent abate and Tenant instead pays monthly in arrears the lesser of 2% of Gross Sales or the GMR otherwise due, for as long as the violating use continues; if the violation continues 90 days after notice Tenant may elect to terminate on 60 days' notice (voidable if Landlord cures), and Landlord must reimburse Tenant's unamortized construction/fixturing costs (5-year straight line) on termination. ⚠️ The Original Lease SS5.04(c) remedy - termination on 180 days' notice where any tenant operates a Family Shoe Store over 2,000 sf - is DELETED by Second Amendment SS5(y).$q$,
        'conditions', $q$NARROWED BY THE SECOND AMENDMENT, WHICH IS EFFECTIVE. The covenant now bites only on occupants of LESS than 19,000 sf, is personal to Rack Room Shoes, Inc. (not transferable to assignees), and carries an expanded carve-out list (Nike, Adidas, Foot Locker, Birkenstock, UGG, Crocs and similar single-brand/athletic concepts). Original carve-outs also persist: Payless ShoeSource (permitted in Building C) and the Target / Ross / Bed Bath & Beyond premises unless primarily operated as a Family Shoe Store. LEASING CONSEQUENCE: a large-format shoe retailer over 19,000 sf may now be leased to WITHOUT breaching this exclusive.$q$
      )
    )
where property_id = '00000000-0000-0000-0000-000000000010'
  and tenant_name = 'Rack Room Shoes #474';

-- VERIFIED after applying, against a prediction made before writing (0 keys -> 7):
--   overrides                    = 7 keys
--   effective term.expiration    = 2037-01-31
--   effective term.term_years    = 15
--   effective co_tenancy.exists  = false
--   base_rent_schedule           = 5 rows -> 7 rows
--     row 6 = 2027-02-01..2032-01-31  psf 30    annual 187950  monthly 15662.50
--     row 7 = 2032-02-01..2037-01-31  psf 33.6  annual 210504  monthly 17542.00
--   percentage_rent.breakpoint_type = artificial

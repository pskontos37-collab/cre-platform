-- 20240177  Krispy Kreme (KM EAST) - radius_clause.exists was FALSE; the lease contains a
--           real 3-mile radius restriction with a 25% Base Rent penalty.
--
-- Found by sweeping exclusives / co-tenancy / radius the same way as the allowance sweep
-- (20240176). Of the three, radius produced the ONLY defect: 1 of 47 abstracts saying
-- exists=false. Verbatim, doc 697e0167-f040-4583-a267-a58143dd7fd0 (chunks 1089 and 1096):
--
--   "...neither Tenant, nor any stockholder owning more than five (5%) percent of Tenant
--    if Tenant is a corporation, nor any person, corporation, partnership, trust, other
--    firm or entity which controls or is controlled by Tenant or is under common control
--    with Tenant, nor any subsidiary of Tenant, nor any business organization affiliated
--    with Tenant (including but not limited to any so-called "parent company" of Tenant),
--    nor any guarantor of this Lease, will, directly or indirectly conduct business at, or
--    sell from, any other place situated within a radius of three (3) miles of the Leased
--    Premises any merchandise or services which Tenant is permitted to sell or engage in
--    any business which Tenant is permitted to conduct in the Leased Premises. In addition
--    to, and not in exclusion of, any remedy available to Landlord for breach of the
--    foregoing covenant, so long as this covenant is being breached, Tenant's annual Base
--    Rent shall be increased by twenty-five (25%) percent."
--
-- ⚠️ THE TEXT IMMEDIATELY AFTER THAT IS STRUCK THROUGH AND IS NOT OPERATIVE. The OCR of it
-- is characteristically mangled ("aad ie additiea one-half (1/2) e( all ef the 'Gi-ess
-- Sales'...") because strikethrough garbles character recognition. It would have added
-- one-half of the other location's Gross Sales into the Percentage Rent computation, and
-- attributed ALL of them if Tenant went dark here. Deliberately NOT abstracted as live.
-- Recognising struck text by its OCR garbling matters - transcribed naively it reads as a
-- second, much harsher remedy that the parties actually negotiated OUT.
--
-- ⚠️⚠️ MRI IS WRONG HERE, AND THE ABSTRACT DEFERRED TO IT. The prior value carried
-- details: "MRI cross-check confirms has_radius_restriction=false; no radius covenant
-- located in file". MRI's flag is simply not populated for this lease, and "no covenant
-- located" was a search miss - the clause is in the original lease, twice. The
-- MRI-is-system-of-record rule is about OPTION DATES (where RETAILRR is authoritative);
-- it does not make an unset MRI boolean evidence that a negotiated covenant does not
-- exist. Verbatim lease text outranks an empty MRI flag.
--
-- WHY THIS WAS THE ONLY HIT, i.e. the sweep is sound rather than under-powered:
--   * RADIUS   - 47 abstracts said false. ~28 keyword hits, and all but this one were
--     surveyor metes-and-bounds ("a curve having a radius of 500.00 feet"), a Builder's
--     Risk "radius of 100'", a demographics blurb ("within a 5-mile radius, the
--     population..."), and a truck turn radius. One real defect.
--   * CO-TENANCY - 66 said false. Every hit was boilerplate: Kimco deal-approval
--     checklists ("Exclusive, co-tenancy and termination rights, if applicable,
--     approved"), estoppel certificates ("Tenant has no knowledge of any violations of any
--     exclusive use, co-tenancy, parking ratio or similar restrictions"), and SNDA
--     carve-outs. ZERO defects.
--   * EXCLUSIVES - 29 said false. Every hit was a SCHEDULE OF OTHER TENANTS' exclusives
--     bound onto this tenant (Nordstrom Rack's hit is Jared's jewelry exclusive; Blue
--     Cross's is Sports Authority's; Bober Tea's is Allen Tate / Urban Air; Old Navy's is
--     the sporting-goods SS4.03), plus "for Tenant's exclusive use" in trash-enclosure and
--     recordable-memorandum boilerplate. ZERO defects - and this independently RECONFIRMS
--     the Vitamin Shoppe and Old Navy conclusions from earlier today.
--     POSITIVE CONTROL: the nine tenants whose documents carry an own-exclusive remedy
--     mechanism (Restore Hyper Wellness, V Nail Bar, European Wax Center, Tropical
--     Smoothie, Cold Stone, Results Physiotherapy, Avance Primary Care, Academy Ltd,
--     Athlete's Foot) ALL already read exclusives.exists = true. The abstractor handles an
--     own-covenant correctly; what it cannot do is tell a third-party schedule apart, and
--     it errs toward false, which is the safe direction.
--
-- OPEN, NOT WRITTEN - KOHLS 397 (Gateway). Its COVID deferment agreement has Tenant
-- "forever waive[] and release[] Landlord from any claims ... which relate to co-tenancy
-- under the Lease", which implies the Kohl's lease HAS co-tenancy provisions. But no
-- co-tenancy provision text appears anywhere in its 36 source documents (3 of them
-- lease_originals), so there is nothing to abstract from and a waiver reference alone is
-- not evidence enough to flip co_tenancy.exists on an anchor lease. Left as a document
-- gap to chase, not a data change.

update lease_abstracts
set overrides = coalesce(overrides::jsonb,'{}'::jsonb) || jsonb_build_object(
      'radius_clause', jsonb_build_object(
        'exists', true,
        'section', 'Original Lease - Radius/Non-Competition covenant (see doc 697e0167, chunks 1089 and 1096); article number not legible in the OCR',
        'details', $q$THREE (3) MILE RADIUS RESTRICTION. Verbatim: "...neither Tenant, nor any stockholder owning more than five (5%) percent of Tenant if Tenant is a corporation, nor any person, corporation, partnership, trust, other firm or entity which controls or is controlled by Tenant or is under common control with Tenant, nor any subsidiary of Tenant, nor any business organization affiliated with Tenant (including but not limited to any so-called 'parent company' of Tenant), nor any guarantor of this Lease, will, directly or indirectly conduct business at, or sell from, any other place situated within a radius of three (3) miles of the Leased Premises any merchandise or services which Tenant is permitted to sell or engage in any business which Tenant is permitted to conduct in the Leased Premises." REMEDY: "In addition to, and not in exclusion of, any remedy available to Landlord for breach of the foregoing covenant, so long as this covenant is being breached, Tenant's annual Base Rent shall be increased by twenty-five (25%) percent." The covenant binds a wide group - Tenant, any >5% stockholder, controlling/controlled/common-control entities, subsidiaries, affiliates, any parent company, and any guarantor. ⚠️ The passage immediately following the 25% remedy is STRUCK THROUGH in the executed document (its OCR is garbled, which is the signature of strikethrough) and is NOT operative: it would have added one-half of the other location's Gross Sales into the Percentage Rent computation, and all of them if Tenant ceased operating here. Do not abstract that as live. ⚠️ MRI carries has_radius_restriction=false for this lease; that flag is simply unpopulated and does not override the executed lease text.$q$
      ))
where property_id = '00000000-0000-0000-0000-000000000010'
  and tenant_name = 'Krispy Kreme';

-- VERIFIED after applying, against a prediction made before writing (1 key -> 2):
--   Krispy Kreme overrides = 2 keys, pre-existing 'critical_dates.3.date' preserved
--   effective radius_clause.exists = true, 25% remedy recorded, strikethrough flagged
--   portfolio-wide count of radius_clause.exists='false' went 47 -> 46, so exactly one
--   abstract changed and nothing else was touched

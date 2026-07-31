-- 20240170  Cheddar's Casual Cafe #0202058 (MAGNOLIA) - the $130,000 is a TENANT PAYMENT
--           TO LANDLORD, not a tenant improvement allowance. The sign was inverted.
--
-- The abstract carried tenant_allowance = {exists: true, total: 130000, psf: null}, which
-- reads as $130,000 of LANDLORD-funded TI. The Work Letter says the opposite, and the
-- section is literally titled "Tenant Contribution". Verified VERBATIM in TWO independent
-- lease_original documents (e646104d-f8ab-4ee4-9f18-f5c13c30e50b chunk 1178 and
-- 06b366ef-5e01-4637-bcdb-d6d706685c63 chunk 1356), Work Letter SSII.D:
--
--   "D. Tenant Contribution: Tenant shall pay Landlord $130,000.00 toward Landlord's
--    sitework costs (the "Landlord Reimbursement") ..."
--   "... Failure of Tenant to pay the Landlord Reimbursement as required shall be a
--    Tenant Event of Default."
--
-- So the cash flows FROM tenant TO landlord. Leaving it in tenant_allowance misstated
-- $130,000 of capital in the wrong direction - a $260,000 swing if anyone netted it.
--
-- exists -> false because there is NO landlord-funded allowance anywhere in this file.
-- BUT the obligation is NOT discarded: it is preserved in tenant_allowance.notes, because
-- deleting a real economic term (one whose non-payment is an Event of Default, and which
-- gates the Land Delivery Date) would trade one defect for another. `notes` is an
-- ESTABLISHED key on tenant_allowance elsewhere in this corpus, so this follows precedent
-- rather than inventing a field.
--
-- A DOTLESS key replaces the whole object and a JSON null is honoured - verified against
-- the real merge in src/pages/AbstractsPage.tsx applyOverrides(), which splits the key on
-- "." and assigns o[last] = val.
--
-- NOT CHANGED - square_footage 8,380. The lease documents describe "approximately 16,236
-- square feet", but that is the LAND/parcel area for this restaurant pad; the rent roll
-- (2026-06, suite B01) reports 8,380 sf at $17.33 psf, matching the abstract. Per the
-- owner's 2026-07-31 direction that the rent roll RSF governs, 8,380 stands.

update lease_abstracts
set overrides = coalesce(overrides::jsonb, '{}'::jsonb) || jsonb_build_object(
      'tenant_allowance', jsonb_build_object(
        'exists', false,
        'total',  null,
        'psf',    null,
        'notes',  $q$NO landlord-funded tenant improvement allowance exists in this file. The $130,000.00 previously recorded here runs the OTHER WAY: Work Letter SSII.D "Tenant Contribution" requires TENANT to pay LANDLORD $130,000.00 toward Landlord's sitework costs (the "Landlord Reimbursement"). If Landlord's Lender requires it, Tenant deposits the full amount in escrow within 5 days after notice that Landlord will commence Landlord's Work, disbursed per the Lender's instructions; otherwise it is paid to Landlord within 5 days after Tenant's receipt of Freeland & Kauffman, Inc.'s certification that Landlord's Work is complete (minor punchlist excepted). Late deposit extends the Land Delivery Date one day per day of delay, and failure to pay is a Tenant Event of Default. Verified verbatim in two independent copies of the lease.$q$
      )
    )
where property_id = 'd4f08824-2d88-472d-b7aa-a703310c2aaf'
  and tenant_name = 'Cheddar''s Casual Café #0202058';

-- VERIFIED after applying (1 override key):
--   effective tenant_allowance.exists = false
--   effective tenant_allowance.total  = null (JSON null present, key retained)
--   notes preserved with the full Tenant Contribution mechanics
-- ⚠️ NOTE ON VERIFYING THIS ONE: a check written as
--     coalesce(overrides->'tenant_allowance'->>'total', abstract->'tenant_allowance'->>'total')
--   FALSELY reports 130000, because ->>'total' on a JSON null yields SQL NULL and coalesce
--   then falls through to the abstract. Test jsonb_typeof(...->'total') = 'null' instead.

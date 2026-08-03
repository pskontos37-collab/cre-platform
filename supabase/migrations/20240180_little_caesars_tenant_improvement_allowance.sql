-- 20240180  Little Caesars (KM EAST) - record the $24,000 Tenant Improvement Allowance.
--
-- FOUND BY THE RE-BRIEF PAYING OFF. This is the first allowance surfaced by the new
-- allowance_effects slot on a freshly re-briefed document, and it is one the earlier
-- raw-text sweep could NOT reach: back on 2026-07-31 that sweep flagged Little Caesars
-- only because a doc mentioned "a written request for payment of the Tenant Improvement
-- Allowance" - procedural language with no figure - so it was left as an open item. The
-- re-briefed document now carries the granting clause itself.
--
-- VERIFIED VERBATIM in the tenant's own source documents (kind='text'), not taken from
-- the brief: "...upon completion of its construction work in accordance with Tenant's
-- Plans approved by Landlord ("Work"), Landlord agrees to contribute, towards the costs
-- of the Work, but excluding any costs incurred for Tenant's personal property,
-- furniture, trade fixtures, equipment, inventory, signs and/or architect's, engineering,
-- or permitting fees, a sum equal to the lesser of (i) the actual cost of the Work, or
-- (ii) the sum of Twenty Four Thousand Dollars ($24,000.00) (the "Tenant Improvement
-- Allowance"). In the event that the cost of the Work exceeds the Tenant Improvement
-- Allowance, such excess amount shall be borne solely by Tenant. Landlord agrees to pay
-- Tenant the Tenant Improvement Allowance, provided that Tenant is not in default, within
-- approximately thirty (30) days after Tenant has accomplish[ed the stated conditions]."
--
-- The abstract carried exists=false with total=0 - an explicit zero, which reads as
-- "checked, there is none" rather than "not looked at", and is the worse kind of wrong.
--
-- ⚠️ IT IS A CEILING, NOT A FIXED SUM: the landlord owes the LESSER of actual Work cost
-- or $24,000, with a defined exclusion list, so the real exposure can be lower. psf is
-- left NULL deliberately - $24,000 / 1,200 sf = $20.00 would imply a rate the lease does
-- not state, and this allowance is a capped reimbursement, not a per-foot grant.
--
-- NOT WRITTEN - GNC. The same sweep proposed $7.50/sf for GNC, but its quoted clause
-- appears NOWHERE in that tenant's kind='text' chunks, so there is no positive evidence
-- for the figure. Absence from the text layer is not proof of fabrication (abstract-verify
-- and doc-brief can read attached PDFs the chunk layer misses), but it is not grounds to
-- write a dollar figure either. Left for a document read.

update lease_abstracts
set overrides = coalesce(overrides::jsonb,'{}'::jsonb) || jsonb_build_object(
      'tenant_allowance', jsonb_build_object(
        'exists', true,
        'total',  24000.00,
        'psf',    null,
        'notes',  $q$Tenant Improvement Allowance, capped: "Landlord agrees to contribute, towards the costs of the Work ... a sum equal to the lesser of (i) the actual cost of the Work, or (ii) the sum of Twenty Four Thousand Dollars ($24,000.00) (the 'Tenant Improvement Allowance')." ⚠️ A CEILING, NOT A FIXED SUM - the landlord owes the LESSER of actual cost or $24,000, so exposure can be lower. EXCLUDED from the reimbursable Work: Tenant's personal property, furniture, trade fixtures, equipment, inventory, signs, and architect's/engineering/permitting fees. Any excess over the allowance is borne solely by Tenant. PAYMENT: within approximately 30 days after Tenant satisfies the stated completion conditions, and only while Tenant is not in default. psf deliberately left null - 24,000/1,200 sf = $20.00 would imply a per-foot rate the lease does not state. Surfaced by the 2026-08-02 re-brief via the new allowance_effects slot; the earlier raw-text sweep saw only the procedural "request for payment of the Tenant Improvement Allowance" language with no figure.$q$
      ))
where property_id = '00000000-0000-0000-0000-000000000010'
  and tenant_name = 'Little Caesars';

-- VERIFIED after applying: 1 override key; effective tenant_allowance.exists = true,
-- total = 24000.00, psf NULL as intended (was exists=false / total=0).

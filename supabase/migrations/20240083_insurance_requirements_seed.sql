-- 20240083_insurance_requirements_seed.sql
-- Seed insurance_requirements for the 3 JV assets so coi-extract's matching
-- engine grades parsed certificates instead of leaving them 'pending'.
--
-- VENDOR requirements = the per-property "Exhibit B Insurance Requirements"
-- standard. KM East / KM West are the EXACT text from the two BBK Exhibit B
-- docs (source='exhibit_import'). Gateway + Magnolia reuse the same coverage /
-- endorsement STANDARD (source='manual') but their additional-insured entity
-- names + lender are placeholders pending each property's own Exhibit B (the
-- deficiency check keys off the AI/waiver/primary booleans, not name-matching,
-- so grading works today; the names matter for the collection letters later).
--
-- TENANT requirements = a conservative documented retail DEFAULT (CGL 1M/2M +
-- property). Real per-lease limits (umbrella, higher CGL, liquor, etc.) come
-- from each lease's insurance article via the abstractor extension - do NOT
-- treat this default as authoritative per tenant.
--
-- Re-runnable: clears prior seeded rows for these properties first.

do $$
declare
  gw  uuid := 'd5a4ed03-0b60-4168-9208-83822dd24884';  -- Gateway Port Chester
  kme uuid := '00000000-0000-0000-0000-000000000010';  -- KM East (Midway Plantation)
  kmw uuid := '00000000-0000-0000-0000-000000000011';  -- KM West (Midtown Commons)
  mag uuid := 'd4f08824-2d88-472d-b7aa-a703310c2aaf';  -- Magnolia Park
  wilkow_holder text := 'c/o M&J Wilkow Properties, LLC, 20 South Clark Street #3000, Chicago IL 60603';
  rid uuid;
  pid_t uuid;
begin
  -- fresh start for these four properties
  delete from public.insurance_requirements
   where property_id in (gw, kme, kmw, mag) and source in ('exhibit_import','manual');

  -- ── VENDOR requirement (one per property) + its coverage lines ──
  -- helper values shared across all four vendor requirements
  -- CGL $2M/occ + $2M agg; Auto $2M CSL; WC statutory; EL $500k.
  perform 1;

  -- KM East (exact Exhibit B)
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (kme, 'vendor', 'property_default',
     array['BBK Midway Plantation LLC d/b/a Knightdale Marketplace East (owner)',
           'M & J Wilkow Properties, LLC, Series SSS (management agent)',
           'MetLife Real Estate Lending, LLC and its successors, assigns, affiliates, partners and participants (mortgagee)'],
     'CG 20 10', true, true, 'A:X', 30, 10000,
     'BBK Midway Plantation, LLC. ' || wilkow_holder, 'exhibit_import',
     'BBK Midway Plantation (KM East) Exhibit B Insurance Requirements', null)
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 2000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory - State of NC; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 500000, true, 'Not less than $500k per accident/illness');

  -- KM West (exact Exhibit B)
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (kmw, 'vendor', 'property_default',
     array['BBK Midtown Commons LLC d/b/a Knightdale Marketplace West (owner)',
           'M & J Wilkow Properties, LLC, Series RRR (management agent)',
           'MetLife Real Estate Lending, LLC and its successors, assigns, affiliates, partners and participants (mortgagee)'],
     'CG 20 10', true, true, 'A:X', 30, 10000,
     'BBK Midtown Commons, LLC. ' || wilkow_holder, 'exhibit_import',
     'BBK Midtown Commons (KM West) Exhibit B Insurance Requirements', null)
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 2000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory - State of NC; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 500000, true, 'Not less than $500k per accident/illness');

  -- Gateway (standard assumed; AI names + lender pending Gateway Exhibit B)
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (gw, 'vendor', 'property_default',
     array['Gateway property-owner entity (owner) - CONFIRM exact LLC from Gateway Exhibit B',
           'M & J Wilkow Properties, LLC (management agent)',
           'Mortgagee/lender - CONFIRM (Gateway loan = NY Life)'],
     'CG 20 10', true, true, 'A:X', 30, 10000,
     'Gateway owner entity ' || wilkow_holder, 'manual',
     'Standard assumed from KM Exhibit B', 'CONFIRM Gateway-specific additional insureds + lender from its own Exhibit B')
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 2000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 500000, true, 'Not less than $500k per accident/illness');

  -- Magnolia (standard assumed; AI names + lender pending Magnolia Exhibit B)
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (mag, 'vendor', 'property_default',
     array['Magnolia Park property-owner entity (owner) - CONFIRM exact LLC from Magnolia Exhibit B',
           'M & J Wilkow Properties, LLC (management agent)',
           'Mortgagee/lender - CONFIRM (Magnolia = MetLife pref equity position)'],
     'CG 20 10', true, true, 'A:X', 30, 10000,
     'Magnolia Park owner entity ' || wilkow_holder, 'manual',
     'Standard assumed from KM Exhibit B', 'CONFIRM Magnolia-specific additional insureds + lender from its own Exhibit B')
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 2000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 500000, true, 'Not less than $500k per accident/illness');

  -- ── TENANT default requirement (conservative; refine per lease) ──
  -- Applied to all four properties. CGL 1M/2M + property (TI/BPP). AI + waiver
  -- + primary/non-contributory required. Umbrella/liquor/higher limits are
  -- lease-specific and intentionally omitted from the default.
  foreach pid_t in array array[gw, kme, kmw, mag]
  loop
    insert into public.insurance_requirements
      (property_id, party_type, scope, additional_insureds, additional_insured_form,
       requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
       cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
    values
      (pid_t, 'tenant', 'property_default',
       array['Landlord / owner entity','M & J Wilkow Properties, LLC (management agent)','Mortgagee/lender'],
       'CG 20 10', true, true, 'A:X', 30, null,
       'Owner entity ' || wilkow_holder, 'manual',
       'Retail tenant DEFAULT', 'DEFAULT ONLY - confirm actual limits/endorsements per lease insurance article; umbrella/liquor/higher CGL are lease-specific')
    returning id into rid;   -- note: rid reused as the new requirement id below
    insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
      (rid, 'cgl', 1000000, 2000000, null, true, 'Default retail minimum - confirm per lease'),
      (rid, 'property', null, null, null, true, 'Special form on tenant improvements + business personal property');
  end loop;
end $$;

notify pgrst, 'reload schema';

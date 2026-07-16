-- 20240087_insurance_requirements_gw_mag.sql
-- Replace the placeholder Gateway + Magnolia VENDOR requirement rows (seeded in
-- 20240083 with "CONFIRM" notes) with the exact terms from each property's own
-- Exhibit B:
--   Gateway  = "Port Chester Insurance Requirements Exhibit B - Updated 3.11.26"
--              (owner ML-MJW Port Chester SC Owners LLC; mortgagee New York Life;
--               CGL $2M, Auto $1M, WC + EL $500k; A:X; 30-day; no deductible cap)
--   Magnolia = "Magnolia Insurance Requirements.doc"
--              (owner Magnolia Park Greenville LLC; mortgagee Midland National
--               Life; CGL $2M, Auto $1M, Umbrella/Excess $1M, WC + EL $1M;
--               A:VII (not A:X); 30-day; deductible <= $10k)
-- Only the vendor property_default rows for these two properties are touched;
-- KM East/West and all tenant defaults are left intact.

do $$
declare
  gw  uuid := 'd5a4ed03-0b60-4168-9208-83822dd24884';
  mag uuid := 'd4f08824-2d88-472d-b7aa-a703310c2aaf';
  rid uuid;
begin
  delete from public.insurance_requirements
   where property_id in (gw, mag) and party_type = 'vendor' and scope = 'property_default';

  -- ── Gateway Port Chester ──
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (gw, 'vendor', 'property_default',
     array['ML-MJW Port Chester SC Owners LLC (owner)',
           'M & J Wilkow Properties, LLC (managing agent)',
           'New York Life Insurance Company and its successors and assigns (mortgagee)'],
     'CG 20 10', true, true, 'A:X', 30, null,
     'M&J Wilkow Properties, LLC, c/o Management Office, 421 Boston Post Road, Port Chester, NY 10573',
     'exhibit_import', 'Port Chester Insurance Requirements Exhibit B - Updated 3.11.26', null)
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 1000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory - State of NY; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 500000, true, 'Not less than $500k per accident/disease');

  -- ── Magnolia Park (Greenville SC) ──
  insert into public.insurance_requirements
    (property_id, party_type, scope, additional_insureds, additional_insured_form,
     requires_primary_noncontrib, requires_waiver_subrogation, min_am_best_rating,
     cancellation_notice_days, max_deductible, certificate_holder, source, source_section, notes)
  values
    (mag, 'vendor', 'property_default',
     array['Magnolia Park Greenville, LLC (owner)',
           'M & J Wilkow Properties, LLC (managing agent)'],
     'CG 20 10', true, true, 'A:VII', 30, 10000,
     'M&J Wilkow Properties, LLC, 20 South Clark, Suite 3000, Chicago, IL 60603',
     'exhibit_import', 'Magnolia Park Shopping Center Insurance Requirements',
     'Mortgage PAID OFF - no mortgagee additional insured (Exhibit B on file lists Midland National Life, but the loan has since been satisfied; owner + managing agent only).')
  returning id into rid;
  insert into public.insurance_requirement_coverages (requirement_id, coverage_type, min_each_occurrence, min_aggregate, min_other, required, notes) values
    (rid, 'cgl', 2000000, 2000000, null, true, 'CSL per occurrence'),
    (rid, 'auto', 1000000, null, null, true, 'Owned/hired/non-owned; CSL per accident'),
    (rid, 'umbrella_excess', 1000000, null, null, true, 'Excess/Umbrella liability'),
    (rid, 'workers_comp', null, null, null, true, 'Statutory - State of SC; waiver of subrogation in favor of AIs'),
    (rid, 'employers_liability', null, null, 1000000, true, 'Not less than $1,000,000 per accident/disease');
end $$;

notify pgrst, 'reload schema';

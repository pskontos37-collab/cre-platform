-- 20240171  Correct a FALSE claim I wrote into Rack Room's term.expiration_basis in
--           20240169: that MRI still showed lease_end 2027-01-31 and needed updating.
--
-- MRI ALREADY CARRIES THE SECOND AMENDMENT. The 2026-07 rent-roll snapshot holds TWO
-- rows for suite D3:
--     2022-02-01 -> 2027-01-31   $144,095.04   $23.00 psf   (current term)
--     2027-02-01 -> 2037-01-31   NULL          NULL         (future extension term)
-- and `leases` already reads expiration_date 2037-01-31 with has_co_tenancy_clause=false,
-- so WALT and the critical-dates radar were already correct - there was no downstream gap.
--
-- I based the original claim on the ABSTRACT's own note ("confirmed by MRI rent roll
-- (lease_end 2027-01-31)"), written 2026-07-21, instead of querying the rent roll. That is
-- the documented trap in reverse: MRI records an extension as a SEPARATE FUTURE-TERM ROW,
-- so looking only at the current-term row makes MRI look out of date when it is not.
-- Lesson: read ALL rent-roll rows for a suite, never one row and never max(lease_end).
--
-- THE ONLY REAL GAP LEFT IS SMALLER: MRI has the extension TERM but not the extension
-- RENT - the 2027-02-01 row carries NULL annual_base_rent / NULL psf, so the $187,950
-- and $210,504 steps from Second Amendment SS3(a) are not yet in MRI.

update lease_abstracts
set overrides = overrides || jsonb_build_object(
      'term.expiration_basis',
      $q$Second Amendment to Lease R-2 (EXECUTED - owner-confirmed 2026-07-31): Lease Term extended one additional period of 120 full calendar months commencing 2027-02-01 and expiring 2037-01-31. Supersedes the First Lease Amendment 2027-01-31 date. CORROBORATED, not contradicted, by the systems of record: the 2026-07 MRI rent roll carries a second future-term row for suite D3 running 2027-02-01 to 2037-01-31, and `leases`.expiration_date is already 2037-01-31 with has_co_tenancy_clause=false. Remaining gap: that MRI future-term row has NULL base rent, so the Second Amendment SS3(a) steps ($187,950.00 then $210,504.00) are not yet loaded in MRI.$q$
    )
where property_id = '00000000-0000-0000-0000-000000000010'
  and tenant_name = 'Rack Room Shoes #474';

-- VERIFIED after applying, against a prediction made before writing:
--   override key count stays 7 (expiration_basis REPLACED, not added)
--   term.expiration_basis no longer contains "needs updating"; now contains "CORROBORATED"
--   term.expiration still 2037-01-31 ; co_tenancy.exists still false

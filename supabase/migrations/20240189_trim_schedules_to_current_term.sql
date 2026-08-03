-- 20240189 — trim base_rent_schedule to the CURRENT term on 10 unambiguous cases.
--
-- Each carried rows that are either explicitly labelled option/renewal terms, dated
-- entirely before the current term start, or (T-Mobile) a duplicate subset row - and
-- every one already carries those periods in options[]. Keep-indices were determined
-- per tenant from the row dates/labels. Cleared 10 of the 19 schedule_vs_term
-- findings outright.
with keep(tenant, pid, idx) as (values
  -- rows 3-4 are literally labelled "(First Option Term)" / "(Second Option Term)"
  ('CONDADO TACOS 44, LLC',   'd4f08824-2d88-472d-b7aa-a703310c2aaf', array[0,1]),
  -- rows 3-4 labelled "(1st Renewal Term)" / "(2nd Renewal Term)"
  ('MyEyeDr.',                'd4f08824-2d88-472d-b7aa-a703310c2aaf', array[0,1]),
  -- row 0 = prior term (2023-01..2024-09); rows 2-3 = 2029+ and 2034+ options
  ('Destination XL',          'd4f08824-2d88-472d-b7aa-a703310c2aaf', array[1]),
  -- row 1 = 2032-09 onward, past the 2032-08-31 expiration
  ('Mimosa Nail Spa',         'd4f08824-2d88-472d-b7aa-a703310c2aaf', array[0]),
  -- row 2 = 2027-01-01..2031-12-31, entirely past the 2026-12-31 expiration
  ('Kay Jewelers',            '00000000-0000-0000-0000-000000000010', array[0,1]),
  -- row 0 = 2022-02..2023-07 prior term, before the 2023-08-01 current start
  ('Mattress Warehouse',      '00000000-0000-0000-0000-000000000010', array[1]),
  -- row 2 = 2027-02-01..2032-01-31, past the 2027-01-31 expiration
  ('Salt Grass',              '00000000-0000-0000-0000-000000000010', array[0,1]),
  -- row 0 = calendar 2021, before the 2022-01-01 current start
  ('Slice of NY Pizza',       '00000000-0000-0000-0000-000000000010', array[1,2,3,4,5,6,7]),
  -- row 0 (2025-03-01..2026-02-28) is a DUPLICATE subset of row 1
  -- (2025-03-01..2030-02-28) at the identical 40 psf / 88,000 - not a rent step
  ('T-Mobile',                '00000000-0000-0000-0000-000000000010', array[1]),
  -- row 2 = 2031-02-01..2036-01-31, past the 2031-01-31 expiration
  ('DSW 29193',               'd5a4ed03-0b60-4168-9208-83822dd24884', array[0,1])
)
update lease_abstracts la
set overrides = coalesce(la.overrides, '{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule',
      (select jsonb_agg(t.e order by t.ord)
         from jsonb_array_elements(
                apply_abstract_overrides(la.abstract, la.overrides)->'base_rent_schedule'
              ) with ordinality t(e, ord)
        where (t.ord - 1) = any(k.idx))),
    updated_at = now()
from keep k
where la.tenant_name = k.tenant and la.property_id = k.pid::uuid;

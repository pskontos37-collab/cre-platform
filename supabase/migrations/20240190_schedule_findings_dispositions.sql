-- 20240190 — the last 9 schedule_vs_term findings: one correction + 8 dispositions.
-- Closes the schedule_vs_term class portfolio-wide (0 open / 9 settled).

-- Another Broken Egg: row 0 carried months=60 while its dates (2024-12-01 ..
-- 2025-11-30) span 12. The schedule is otherwise exactly right - 5 contiguous
-- 12-month rows covering 2024-12-01 -> 2029-11-30, the full 60-month term. One bad
-- months field made it read as 108 months. Set it to 12.
update lease_abstracts la
set overrides = coalesce(la.overrides,'{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule',
      (select jsonb_agg(case when t.ord = 1 then jsonb_set(t.e, '{months}', '12'::jsonb) else t.e end
                        order by t.ord)
         from jsonb_array_elements(apply_abstract_overrides(la.abstract,la.overrides)->'base_rent_schedule')
              with ordinality t(e, ord))),
    updated_at = now()
where la.tenant_name = 'Another Broken Egg Café';

insert into abstract_item_resolutions (abstract_id, item_key, kind, status, note, resolved_by, archived)
select la.id, 'field:base_rent_schedule', 'data_quality', v.status,
       '[AI-prepared disposition] ' || v.note, null, false
from (values
  ('Another Broken Egg Café', 'corrected',
   'Row 0 carried months=60 while its own dates (2024-12-01..2025-11-30) span 12. The schedule was otherwise exactly right: 5 contiguous 12-month rows covering 2024-12-01 -> 2029-11-30, the full 60-month term, escalating 136,386.48 -> 147,629.04 (38.97 -> 42.18 psf on 3,500 sf). MRI corroborates at 11,592.85/mo. Set months to 12; sum now ties the term.'),
  ('Athlete''s Foot', 'accepted',
   'NOT a schedule defect. The 10 rows price 2026-05-01 onward and MRI confirms the first row (93,000/yr = 7,750/mo at 31 psf) is what is billing now. The 198-month span comes from term.current_term_start = 2019-11-10, the ORIGINAL commencement rather than the current term start - the same artifact as Grow Pediatric at KM West. Fix belongs on the term field, not the schedule.'),
  ('Five Guys Burgers and Fries', 'accepted',
   'Same pattern as Athlete''s Foot: the 10 rows price 2026-12-01 onward against a term.current_term_start of 2021-12-01 (original commencement). Schedule is right for the current renewal; the 180-month span is a term-field artifact. MRI 6,346.49/mo sits just under the first row (78,000/yr = 6,500/mo) - within a partial-month/CAM-timing difference, not a conflict.'),
  ('Subway #37092', 'needs_doc',
   'Genuinely short: rows price 2022-02-01..2027-01-31 (5 x 12 = 60 months) of a 2022-02-01 -> 2032-01-31 term. Years 6-10 are absent. MRI 3,969.46/mo is consistent with the final priced row. NEEDS: the rent exhibit or amendment covering 2027-02 onward.'),
  ('BEV MAX LIQUORS', 'needs_doc',
   '17 rows covering 204 of a ~229-month term (2013-04-05 -> 2032-04-30), short by ~25 months. Long escalation history starting 259,200/yr; MRI currently 31,314.56/mo (52.19 psf on 7,200 sf). NEEDS: the tail of the rent schedule - most likely an amendment extending to 2032 that is not in the priced rows.'),
  ('Burlington Coat Factory', 'needs_doc',
   'Empty schedule, and the reason is subtle: term.current_term_start is 2027-02-01, the EXERCISED option term per the 2026-04-16 exercise letter, while MRI is still billing the pre-option rent (32,812.50/mo, 15.75 psf on 25,000 sf) through 2027-01-31. So the abstract is pointed at a term whose rent nobody has recorded. NEEDS: the option rent from the exercise letter or lease rent exhibit. NOTE this is the GATEWAY Burlington - the KM West one is a separate abstract.'),
  ('Restore Hyper Wellness of Port Chester', 'needs_doc',
   'One row (Year 1, 60.00 psf / 168,180) against a ~120-month term. Deliberately NOT overwritten: this row came from a reviewer override, and MRI now bills 14,435.45/mo (61.8 psf) - a later lease year than the single priced row, so the row is stale rather than wrong. NEEDS: the full escalation schedule; then the Year-1 row should be replaced, not appended to.'),
  ('V NAIL BAR AND LASH INC', 'needs_doc',
   'Rows price only Lease Years 1, 3 and 10 - non-contiguous, 7 of 10 years absent. The rows are internally CONSISTENT (235,380 / 3,923 sf = exactly 60.00 psf). The real problem is upstream: the abstract carries square_footage 3,923 while the MRI rent roll carries 2,300 sf at 78.5 psf (15,045.83/mo). Every psf figure here is suspect until the SF conflict is settled. NEEDS: the demised-premises measurement, then re-derive the schedule.'),
  ('Dave and Busters', 'needs_doc',
   'Three rows totalling 180 months against a ~120-month term, of which rows 0-1 (2014-12-01..2024-11-30) are SUPERSEDED prior terms and row 2 (2024-12-01..2029-11-30, 27.95 psf / 722,898.80) is current. Deliberately NOT trimmed: these rows came from a reviewer override, and the abstract already records the committed-term-vs-MRI question (committed term 20 years while MRI 2034 reaches into an open 3rd renewal). Trimming to row 2 alone would still leave 60 of 120 months unpriced. NEEDS: his call on which term window governs, then re-tier.')
) as v(tenant, status, note)
join lease_abstracts la on la.tenant_name = v.tenant
join v_property_data_quality dq on dq.abstract_id = la.id
     and dq.check_code = 'schedule_vs_term'
on conflict (abstract_id, item_key) do update
  set status = excluded.status, note = excluded.note, kind = excluded.kind,
      archived = false, updated_at = now();

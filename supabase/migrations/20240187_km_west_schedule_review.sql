-- 20240187 — KM West review pass: the 4 schedule_vs_term findings + the 4
-- override_no_op findings, worked to disposition.
--
-- Corrections go in `overrides` (the human-correction layer, non-destructive and
-- surviving regeneration). Dispositions go in abstract_item_resolutions with notes
-- prefixed "[AI-prepared disposition]" and resolved_by LEFT NULL — the same pattern
-- the 2026-07-22 golden-set prep used. Final human sign-off is deliberately NOT
-- forged: nothing here sets human_verified.

-- ── 1. STARBUCK'S — real defect, the Burlington option-tier pattern exactly ────
-- Current term = the EXERCISED First Extension, 2026-08-01 -> 2031-07-31 (60 mo).
-- The schedule carried 6 rows x 60 = 360 months (Lease Years 1-30):
--   rows 1-2 (Yrs 1-10,  psf 45.95 / 50.54) = the ORIGINAL term -> SUPERSEDED
--   row  3   (Yrs 11-15, psf 55.59)         = the current term  -> THE ONLY ONE THAT BELONGS
--   rows 4-6 (Yrs 16-30, psf 61.15/67.27/74)= option periods, ALREADY carried in
--                                             options[] as Extension Terms 2/3/4
-- Abstraction standard rule 10: current controlling schedule only, never carry
-- superseded rows, option rent lives in options[].
-- Arithmetic cross-check: 8,570.83 x 12 = 102,849.96 ~ 102,850 stated;
-- 55.59 psf x 1,850 sf = 102,841.50 (psf is the rounded derivative). Consistent.
-- MRI corroborates the window: the 2026-07 roll carries the extension as a SECOND
-- future-term row (2026-08-01 -> 2031-07-31, rent null) alongside the expiring row
-- at 7,791.67/mo - the documented MRI extension-row pattern, not a conflict.
update lease_abstracts
set overrides = coalesce(overrides, '{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule', jsonb_build_array(jsonb_build_object(
        'start',   '2026-08-01',
        'end',     '2031-07-31',
        'months',  60,
        'psf',     55.59,
        'monthly', 8570.83,
        'annual',  102850.00
      ))),
    updated_at = now()
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Starbuck''s';

-- ── 2. QDOBA — no schedule at all for a 10-year term; MRI supplies CURRENT rent ─
-- Term 2025-09-01 -> 2035-08-31 with base_rent_schedule absent entirely.
-- MRI rent roll (latest, 2026-07) is the system of record for CURRENT rent:
-- 9,583.33/mo, 114,999.96/yr, 50.15 psf on 2,293 sf - stable across the 2025-09,
-- 2025-10 and 2026-07 snapshots.
-- ⚠️ DELIBERATELY NOT asserting a 120-month flat schedule: the Second Amendment's
-- Third Renewal rent steps are NOT in the file, and a 10-year QSR renewal at a flat
-- rate is not credible. months/end are left NULL so the row states exactly what is
-- substantiated - the current billing rate - and nothing more. The companion
-- resolution is needs_doc, not corrected.
update lease_abstracts
set overrides = coalesce(overrides, '{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule', jsonb_build_array(jsonb_build_object(
        'start',   '2025-09-01 (current period per MRI rent roll 2026-07)',
        'end',     null,
        'months',  null,
        'psf',     50.15,
        'monthly', 9583.33,
        'annual',  114999.96
      ))),
    updated_at = now()
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Qdoba';

-- ── 3. AVANCE PRIMARY CARE — the stored rent is a YEAR STALE ──────────────────
-- The abstract's single row held 72,109.74/yr (6,009.14/mo), which its own open item
-- flags as matching "Lease Year 7 (2018 base schedule)". The 2026-07 rent roll has
-- since stepped to 6,159.37/mo (73,912.44/yr, 23.77 psf) - so the abstract was
-- showing last year's rent. Updated to the current MRI figure.
-- The schedule remains ONE year of a ~125-month term: the file substantiates only
-- the current Lease Year, which is what the existing CONFIRM open item already says.
-- Disposition is needs_doc for that reason - the value is now right, the schedule is
-- still incomplete and the missing years need the base-lease rent exhibit.
update lease_abstracts
set overrides = coalesce(overrides, '{}'::jsonb) || jsonb_build_object(
      'base_rent_schedule', jsonb_build_array(jsonb_build_object(
        'start',   'Lease Year 8 (current period per MRI rent roll 2026-07)',
        'end',     null,
        'months',  null,
        'psf',     23.77,
        'monthly', 6159.37,
        'annual',  73912.44
      ))),
    updated_at = now()
where property_id = '00000000-0000-0000-0000-000000000011'
  and tenant_name = 'Avance Primary Care';

-- ── 4. GROW PEDIATRIC DENTISTRY — NOT a schedule defect; my check misattributed ─
-- 10 rows x 12 = 120 months against a ~168-month term looks like missing tiers, but
-- the schedule is CORRECT: it prices the Second Amendment's Revised Term (10 years
-- 3 months of "Extension Lease Year 1-10"), and the 2026-07 roll confirms the
-- Extension Lease Year 1 rate 7,317.67/mo is what is actually being billed.
-- The 168-month span comes from term.current_term_start = 2021-09-01, which is the
-- PRIOR (First Amendment) start - exactly what the abstract's own DISCREPANCY open
-- item already records. The true blocker is the Second Amendment's undetermined
-- "Effective Date" (needs the executed Closing Notice per §7).
-- NO value written. ⚠️ LESSON FOR THE CHECK: schedule_vs_term measures the schedule
-- against term.current_term_start, so a term field pointing at a SUPERSEDED start
-- yields a false schedule finding. The schedule was never the problem.

-- ── 5-8. THE FOUR override_no_op FINDINGS — false positives I created ─────────
-- Burlington, Starbuck's, TJ Maxx and Tropical Smoothie each carry an override on
-- rea_pma.pma_manager that now equals the raw value. Cause: those overrides were
-- correcting the x100 management fee (310.00% -> 3.10%) and were doing real work
-- until migration 20240182 fixed the RAW abstract value underneath them. They are
-- now redundant but harmless - and deleting them would be pure churn, so they stay.
-- No value change; recorded as accepted with the cause named.

-- ── Dispositions ──────────────────────────────────────────────────────────────
insert into abstract_item_resolutions (abstract_id, item_key, kind, status, note, resolved_by, archived)
select la.id, v.item_key, 'data_quality', v.status,
       '[AI-prepared disposition] ' || v.note, null, false
from (values
  ('Starbuck''s',               'field:base_rent_schedule', 'corrected',
   'Trimmed 6 rows (Lease Years 1-30, 360 months) to the single current-term row 2026-08-01 -> 2031-07-31 @ 55.59 psf / 102,850 annual. Rows 1-2 were the superseded original term; rows 4-6 were option periods already carried in options[] as Extension Terms 2/3/4. Arithmetic ties (8,570.83 x 12 = 102,849.96).'),
  ('Qdoba',                     'field:base_rent_schedule', 'needs_doc',
   'Was empty for a 2025-09-01 -> 2035-08-31 term. Wrote the CURRENT billing rate from the MRI rent roll (9,583.33/mo, 114,999.96/yr, 50.15 psf), the system of record for current rent. Deliberately did NOT assert a 120-month flat schedule - the Second Amendment Third Renewal rent steps are not in the file. NEEDS: the Second Amendment rent exhibit or a Closing Notice.'),
  ('Avance Primary Care',       'field:base_rent_schedule', 'needs_doc',
   'The stored row was a YEAR STALE: 72,109.74/yr matched Lease Year 7 (2018 base schedule) while the 2026-07 rent roll had stepped to 6,159.37/mo (73,912.44/yr, 23.77 psf). Value updated to current MRI. Schedule still covers only the current Lease Year of a ~125-month term. NEEDS: the base-lease rent exhibit for the remaining years.'),
  ('Grow Pediatric Dentistry',  'field:base_rent_schedule', 'accepted',
   'NOT a schedule defect - no value changed. The 10 rows correctly price the Second Amendment Revised Term (10 yr 3 mo), and the 2026-07 roll confirms Extension Lease Year 1 at 7,317.67/mo is being billed. The 168-month span is an artifact of term.current_term_start = 2021-09-01 (the PRIOR First Amendment start), already recorded in the abstract''s own DISCREPANCY open item. Real blocker: the Second Amendment undetermined Effective Date (executed Closing Notice per §7).'),
  ('Burlington Coat Factory',   'text:no-op override',      'accepted',
   'Benign. The rea_pma.pma_manager override was correcting the x100 management fee (310.00% -> 3.10%) and was doing real work until migration 20240182 fixed the raw abstract value underneath it. Now redundant, not wrong; left in place rather than churned.'),
  ('Starbuck''s',               'text:no-op override',      'accepted',
   'Benign - same cause as Burlington: the rea_pma.pma_manager override became redundant when 20240182 corrected the raw x100 fee value.'),
  ('TJ Maxx',                   'text:no-op override',      'accepted',
   'Benign - same cause: rea_pma.pma_manager override made redundant by 20240182. Note TJ Maxx also holds base_rent_schedule.0.annual / .0.monthly overrides which are NOT no-ops (they supply values the raw abstract lacks); the check does not evaluate 3-segment paths, so it under-reports rather than over-reports.'),
  ('Tropical Smoothie Cafe''',  'text:no-op override',      'accepted',
   'Benign - same cause: rea_pma.pma_manager override made redundant by 20240182.')
) as v(tenant, item_key, status, note)
join lease_abstracts la
  on la.property_id = '00000000-0000-0000-0000-000000000011'
 and la.tenant_name = v.tenant
on conflict (abstract_id, item_key) do update
  set status = excluded.status, note = excluded.note,
      kind = excluded.kind, archived = false, updated_at = now();

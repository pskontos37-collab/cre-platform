-- 20240181 — Standing per-property data-quality checks.
--
-- The 8/01-8/02 sweeps found real defects by hand-running SQL: allowance
-- direction, third-party exclusive schedules, compression outliers, inflated
-- management fees, MRI-flag-only rights, rent schedules that disagree with
-- their own term. Every one of those is deterministic SQL over data we already
-- store, so it costs nothing to run and should not depend on someone
-- remembering to run it. This view turns them into a standing check: a new
-- property surfaces its defects on day one instead of months later.
--
-- Keyed to the EXISTING resolution model on purpose. item_key uses the same
-- 'field:<dotted path>' convention as v_abstract_open_items, so a finding here
-- and the generator's own open item about the same field share one key and ONE
-- human resolution clears both (abstract_item_resolutions). No parallel
-- worklist, no second inbox.
--
-- severity vocabulary matches the Review Center: discrepancy | confirm | info.
--
-- NOTE ON THE MGMT-FEE REGEX: it is anchored with (^|[^0-9.]). Unanchored,
-- '([2-9][0-9]|[0-9]{3,})(\.[0-9]+)?%' matches the "75%" inside a perfectly
-- correct "1.75%", which reported 22 phantom findings during development. A
-- standing check that cries wolf is worse than no check.

create or replace view v_property_data_quality
with (security_invoker = true) as
with abs_base as (
  select la.id as abstract_id, la.property_id, la.tenant_name, la.abstract, la.qa, la.overrides,
         la.source_doc_ids,
         case when jsonb_typeof(la.abstract->'base_rent_schedule') = 'array'
              then la.abstract->'base_rent_schedule' else '[]'::jsonb end as sched,
         coalesce(nullif(la.abstract->'term'->>'current_term_start',''),
                  nullif(la.abstract->'term'->>'rent_commencement',''),
                  nullif(la.abstract->'term'->>'original_commencement','')) as term_start,
         nullif(la.abstract->'term'->>'expiration','') as term_end
  from lease_abstracts la
  where la.abstract is not null
),

-- (1) A tenant right whose presence or absence rests on an MRI right-flag alone.
-- leases.has_* are NOT NULL with a false default (92 of 112 read
-- has_radius_restriction=false, none null), so they are data-entry state, not
-- evidence. Requires the ABSENCE of document-side reasoning: 70 fields mention a
-- flag but only ~11 do so as their only support, and flagging all 70 would bury
-- the real ones.
mri_flag_only as (
  select b.property_id, b.abstract_id, b.tenant_name, f.field,
         (b.abstract->f.field->>'exists')::bool as ex,
         concat_ws(' | ', b.abstract->f.field->>'details',
                          b.abstract->f.field->>'exact_language',
                          b.abstract->f.field->>'exact_language_and_remedies',
                          b.abstract->f.field->>'notes',
                          b.abstract->f.field->>'conditions',
                          b.abstract->f.field->>'remedies',
                          b.abstract->f.field->>'replacement_tenants_permitted',
                          b.abstract->f.field->>'section') as txt
  from abs_base b
  cross join unnest(array['radius_clause','co_tenancy','exclusives','termination_kickout',
                          'continuous_operations','recapture_rights','option_to_purchase',
                          'relocation_rights']) as f(field)
),

-- (7) Rent-roll recency. Never trust a snapshot's recency: check max(period) PER
-- PROPERTY, because one stale property hides behind a portfolio-wide max.
-- period lives on rent_roll_snapshots as period_year/period_month (rent_roll_rows
-- has only created_at, which is load time, not the period the roll describes).
rr as (
  select property_id, max(make_date(period_year, period_month, 1)) as latest_period
  from rent_roll_snapshots
  where period_year is not null and period_month is not null
  group by property_id
),

-- (8) Brief compression outliers -- the "document reading a fraction of itself"
-- cohort. Re-briefing moved large-doc compression from 20.4:1 to 6.5:1, so a
-- ratio above 15:1 on a substantial document means the brief under-read it.
doc_chars as (
  select db.document_id, d.property_id, d.title, d.file_name,
         length(db.brief::text) as brief_chars,
         (select coalesce(sum(length(c.content)), 0)
            from document_chunks c where c.document_id = db.document_id) as doc_chars
  from doc_briefs db
  join documents d on d.id = db.document_id
  where db.status = 'complete' and db.brief is not null
),

findings as (
  -- (1) MRI-flag-only rights
  select m.property_id, 'abstract'::text as scope, m.abstract_id, m.tenant_name,
         'mri_flag_only_right'::text as check_code,
         'discrepancy'::text as severity,
         'field:' || lower(m.field) as item_key,
         case when m.ex then
           m.field || ' exists=true rests on an MRI right-flag while the field itself records that no covenant was located. Set exists=false + a CONFIRM item naming the granting instrument to obtain.'
         else
           m.field || ' exists=false cites an MRI right-flag with no statement that the documents were searched. A false flag means "never populated" and cannot establish absence.'
         end as detail
  from mri_flag_only m
  where m.txt ~* 'has_(radius_restriction|exclusives|co_tenancy_clause|percentage_rent)\y|\yMRI\y[^.]{0,40}\yflag'
    and ( (m.ex is true  and      m.txt ~* '\y(not|no|none|nothing|never|absent|silent)\y[^.]{0,60}(locat|found|identified|stated|appear|exist|contain)|(locat|identif)\w*[^.]{0,25}\y(not|no|none)\y')
       or (m.ex is false and NOT (m.txt ~* '\y(not|no|none|nothing|never|absent|silent)\y[^.]{0,60}(locat|found|identified|stated|appear|exist|contain)|(locat|identif)\w*[^.]{0,25}\y(not|no|none)\y')) )

  union all
  -- (2) Verifier "confirmed" a field while quoting text that is not in the sources.
  -- Measured flat at ~20.6% whether or not the full source text fit the verifier's
  -- window, so truncation does not explain it.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'citation_not_confirmed',
         case when bool_or(fc->>'severity' = 'high') then 'discrepancy' else 'confirm' end,
         'text:citation not confirmed',
         count(*) || ' verifier field check(s) marked "confirmed" carry a quote that cannot be located in the source documents'
           || case when bool_or(fc->>'severity' = 'high') then ' (includes HIGH severity)' else '' end
  from abs_base b, jsonb_array_elements(b.qa->'field_checks') fc
  where b.qa ? 'citation_summary'
    and fc->>'verdict' = 'confirmed' and fc->>'citation_check' = 'not_found'
  group by b.property_id, b.abstract_id, b.tenant_name

  union all
  -- (3) The rent schedule must span the term the lease DEFINES. An OCR'd rent
  -- table prints option tiers in the same grid, so they get absorbed into the
  -- base schedule (Burlington KM West: 240 months against a ~124-month term).
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'schedule_vs_term', 'discrepancy', 'field:base_rent_schedule',
         case
           when s.n_rows = 0 then
             'base_rent_schedule is empty while the current term runs ' || b.term_start || ' -> ' || b.term_end
             || ' (~' || round(t.term_months) || ' months)'
           when s.sched_months > t.term_months + 12 then
             'base_rent_schedule covers ' || s.sched_months || ' months against a ~' || round(t.term_months)
             || '-month term (' || s.n_rows || ' rows, +' || round(s.sched_months - t.term_months)
             || '): option-period tiers appear to have been absorbed into the base schedule'
           else
             'base_rent_schedule covers only ' || s.sched_months || ' months of a ~' || round(t.term_months)
             || '-month term (-' || round(t.term_months - s.sched_months) || '): tiers are missing'
         end
  from abs_base b
  cross join lateral (
    select (select count(*) from jsonb_array_elements(b.sched)) as n_rows,
           (select count(*) from jsonb_array_elements(b.sched) e
              where (e->>'months') ~ '^[0-9]+(\.[0-9]+)?$' and (e->>'months')::numeric > 0) as n_numeric,
           (select coalesce(sum((e->>'months')::numeric), 0) from jsonb_array_elements(b.sched) e
              where (e->>'months') ~ '^[0-9]+(\.[0-9]+)?$') as sched_months
  ) s
  cross join lateral (
    select case when b.term_start ~ '^\d{4}-\d{2}-\d{2}$' and b.term_end ~ '^\d{4}-\d{2}-\d{2}$'
                     and b.term_end::date > b.term_start::date
                then ((b.term_end::date - b.term_start::date) / 30.4375)::numeric end as term_months
  ) t
  where t.term_months is not null
    and ( s.n_rows = 0
       or (s.n_rows = s.n_numeric and abs(s.sched_months - t.term_months) > 12) )

  union all
  -- (4) A landlord-to-tenant allowance carrying an actual figure sits in a source
  -- brief while the abstract reports no allowance (the Little Caesars $24,000
  -- class). The brief field OVER-extracts, so the filter is deliberately strict:
  -- direction=landlord_to_tenant AND a real total/psf AND kind <> 'other', which
  -- is what excludes landlord's-work scope and renewal boilerplate.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'allowance_missed', 'confirm', 'field:tenant_allowance',
         'a source brief records a landlord-to-tenant ' || (x->>'kind')
           || ' allowance (' || coalesce('total ' || (x->>'total'), 'psf ' || (x->>'psf'))
           || ', ' || coalesce(x->>'section','section n/s') || ') but tenant_allowance.exists is not true - verify the quote and record or reject it'
  from abs_base b
  join doc_briefs db on db.document_id = any(b.source_doc_ids)
                    and db.status = 'complete'
                    and jsonb_typeof(db.brief->'allowance_effects') = 'array'
  cross join lateral jsonb_array_elements(db.brief->'allowance_effects') x
  where coalesce((b.abstract->'tenant_allowance'->>'exists')::bool, false) is false
    and x->>'direction' = 'landlord_to_tenant'
    and coalesce(x->>'kind','other') <> 'other'
    and (nullif(x->>'total','') is not null or nullif(x->>'psf','') is not null)

  union all
  -- (5) exclusives.exists=true demands a quoted covenant by which the LANDLORD
  -- restricts other occupants. A paraphrase, an MRI note code, or another
  -- tenant's exhibit schedule belongs in use_restrictions_on_tenant. This
  -- poisons leasing decisions, hence discrepancy.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'exclusive_not_landlord_restricting', 'discrepancy', 'field:exclusives',
         'exclusives.exists=true but exact_language does not quote a landlord-restricting covenant ('
           || coalesce(length(b.abstract->'exclusives'->>'exact_language'), 0)
           || ' chars, landlord/lessor '
           || case when (b.abstract->'exclusives'->>'exact_language') ~* '(landlord|lessor)' then 'present' else 'ABSENT' end
           || ') - per the abstraction standard this is exists=false + CONFIRM unless the covenant is quoted'
  from abs_base b
  where (b.abstract->'exclusives'->>'exists')::bool is true
    and ( coalesce(length(b.abstract->'exclusives'->>'exact_language'), 0) < 60
       or (b.abstract->'exclusives'->>'exact_language') !~* '(landlord|lessor)' )

  union all
  -- (6) management_agreements.mgmt_fee_pct STORES A PERCENT, not a decimal
  -- (Gateway 1.75, KM 3.1, Magnolia 2.75). A x100 in the abstractor once wrote
  -- "175.00%" into 32 stored abstracts, reaching the UI and the exported PDFs.
  -- Producer fixed; this is the standing regression guard.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'mgmt_fee_implausible', 'discrepancy', 'field:rea_pma.pma_manager',
         'rea_pma.pma_manager states an impossible management fee: '
           || (b.abstract->'rea_pma'->>'pma_manager')
           || ' - mgmt_fee_pct is already a percent, so a x100 has been applied somewhere'
  from abs_base b
  where (b.abstract->'rea_pma'->>'pma_manager') ~ '(^|[^0-9.])([2-9][0-9]|[0-9]{3,})(\.[0-9]+)?%'

  union all
  -- (9) An override that equals the value it overrides is a no-op: it hides a
  -- field from the worklist without changing anything, and a mis-pathed override
  -- (the Bank of America class) looks identical to a real correction in the UI.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'override_no_op', 'info', 'text:no-op override',
         count(*) || ' reviewer override(s) set a field to the value it already held - confirm the path was correct'
  from abs_base b, jsonb_each_text(b.overrides) o(path, val)
  where b.overrides is not null and b.overrides <> '{}'::jsonb
    and val = (case when array_length(string_to_array(o.path, '.'), 1) = 1
                    then b.abstract->>o.path
                    when array_length(string_to_array(o.path, '.'), 1) = 2
                    then b.abstract->(split_part(o.path,'.',1))->>(split_part(o.path,'.',2))
               end)
  group by b.property_id, b.abstract_id, b.tenant_name

  union all
  -- (7) Rent-roll recency, per property.
  select p.id, 'property', null::uuid, null::text,
         'rentroll_stale', 'confirm', 'text:rent roll stale',
         'latest rent-roll period is ' || coalesce(rr.latest_period::text, 'NONE LOADED')
           || case when rr.latest_period is not null
                   then ' (' || (date_part('day', now() - rr.latest_period::timestamp))::int || ' days old)' else '' end
  from properties p
  left join rr on rr.property_id = p.id
  where p.is_pipeline is not true
    and exists (select 1 from leases l where l.property_id = p.id)
    and (rr.latest_period is null or rr.latest_period < (current_date - interval '75 days'))

  union all
  -- (8) Brief compression outliers.
  select dc.property_id, 'property', null::uuid, coalesce(dc.title, dc.file_name),
         'brief_under_read', 'confirm', 'text:brief under-read',
         'brief is ' || round(dc.doc_chars::numeric / nullif(dc.brief_chars,0), 1)
           || ':1 compression over ' || dc.doc_chars || ' chars of text - the document may have been read only in part; re-brief it'
  from doc_chars dc
  where dc.doc_chars > 20000 and dc.brief_chars > 0
    and dc.doc_chars::numeric / dc.brief_chars > 15
)
select f.property_id,
       p.name as property_name,
       f.scope,
       f.abstract_id,
       f.tenant_name,
       f.check_code,
       f.severity,
       f.item_key,
       f.detail,
       (r.id is not null) as resolved,
       r.status as resolution_status
from findings f
join properties p on p.id = f.property_id
left join abstract_item_resolutions r
       on f.abstract_id is not null
      and r.abstract_id = f.abstract_id
      and r.item_key = f.item_key
      and r.archived = false;

comment on view v_property_data_quality is
  'Standing deterministic data-quality checks per property (no AI cost). Keyed with the same item_key convention as v_abstract_open_items so one resolution in abstract_item_resolutions clears the finding everywhere. Added 2026-08-02 from the 8/01-8/02 manual sweeps.';

revoke all on v_property_data_quality from public, anon;
grant select on v_property_data_quality to authenticated, service_role;

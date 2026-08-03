-- 20240185 — allowance_missed: one row per abstract, naming every allowance found.
--
-- The check exploded doc_briefs.allowance_effects, so a tenant with TWO qualifying
-- allowances emitted TWO rows with the SAME (abstract_id, item_key) =
-- 'field:tenant_allowance'. Harmless on the property panel (it groups by
-- check_code and shows both) but the Review Center de-dupes one row per
-- (abstract, field) across every detection layer, so the second figure was
-- silently dropped from the queue. Exactly the two real cases:
--
--   Little Caesars — tenant_improvement 24000 @35(A) AND @Rider B §35
--   Target         — tenant_improvement 2842335 @6.3 AND 3141915 @6.3
--                    (the base figure and the contingent-increase figure)
--
-- Aggregating per abstract keeps the shared item_key (so one resolution still
-- settles the field everywhere) while putting EVERY figure in the detail text,
-- which is what the reviewer needs in order to pick the right one.
--
-- Row counts: allowance_missed 6 -> 4, dq abstract-scoped 135 -> 133, internal
-- (abstract_id, item_key) collisions 2 -> 0. The queue total is unchanged at 119
-- because those 2 were already being de-duped away; what changes is that the
-- surviving row now names both figures instead of one.
--
-- Only the allowance_missed branch differs from 20240183.
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
rr as (
  select property_id, max(make_date(period_year, period_month, 1)) as latest_period
  from rent_roll_snapshots
  where period_year is not null and period_month is not null
  group by property_id
),
doc_chars as (
  select db.document_id, d.property_id, d.title, d.file_name,
         length(db.brief::text) as brief_chars,
         db.text_chars          as doc_chars
  from doc_briefs db
  join documents d on d.id = db.document_id
  where db.status = 'complete' and db.brief is not null and db.text_chars is not null
),
findings as (
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
  -- ONE row per abstract, naming EVERY qualifying allowance (see header).
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'allowance_missed', 'confirm', 'field:tenant_allowance',
         'source briefs record ' || count(distinct a.descriptor)
           || ' landlord-to-tenant allowance(s) while tenant_allowance.exists is not true: '
           || string_agg(distinct a.descriptor, '; ')
           || ' - verify each quote, then record the governing figure or reject it'
  from abs_base b
  join doc_briefs db on db.document_id = any(b.source_doc_ids)
                    and db.status = 'complete'
                    and jsonb_typeof(db.brief->'allowance_effects') = 'array'
  cross join lateral jsonb_array_elements(db.brief->'allowance_effects') x
  cross join lateral (
    select concat_ws(' ', x->>'kind',
                     coalesce('total ' || (x->>'total'), 'psf ' || (x->>'psf')),
                     '@' || coalesce(nullif(x->>'section',''), 'section n/s')) as descriptor
  ) a
  where coalesce((b.abstract->'tenant_allowance'->>'exists')::bool, false) is false
    and x->>'direction' = 'landlord_to_tenant'
    and coalesce(x->>'kind','other') <> 'other'
    and (nullif(x->>'total','') is not null or nullif(x->>'psf','') is not null)
  group by b.property_id, b.abstract_id, b.tenant_name
  union all
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
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'mgmt_fee_implausible', 'discrepancy', 'field:rea_pma.pma_manager',
         'rea_pma.pma_manager states an impossible management fee: '
           || (b.abstract->'rea_pma'->>'pma_manager')
           || ' - mgmt_fee_pct is already a percent, so a x100 has been applied somewhere'
  from abs_base b
  where (b.abstract->'rea_pma'->>'pma_manager') ~ '(^|[^0-9.])([2-9][0-9]|[0-9]{3,})(\.[0-9]+)?%'
  union all
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
  'Standing deterministic data-quality checks per property (no AI cost). Keyed with the same item_key convention as v_abstract_open_items so one resolution in abstract_item_resolutions clears the finding everywhere, and every check emits at most ONE row per (abstract_id, item_key) so the Review Center de-dupe cannot drop a finding. Added 2026-08-02 from the 8/01-8/02 manual sweeps.';

revoke all on v_property_data_quality from public, anon;
grant select on v_property_data_quality to authenticated, service_role;

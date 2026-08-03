-- 20240191 — refine the mri_flag_only_right and exclusives predicates after USING them.
--
-- Working the 14 remaining findings by hand showed 11 were the CHECK misfiring, from
-- two precise causes:
--
--  1. "document-side reasoning" was detected only by a negative within 60 chars of a
--     located/found verb. Real sentences run longer - "no landlord covenant restricting
--     other occupants for Tenant's benefit was located" is ~70 - so five abstracts that
--     plainly DID search the documents read as "no search stated" (Verizon, Vitamin
--     Shoppe, Best Buy, Grow Pediatric, Starbuck's). Window widened to 140, and an
--     explicit section citation (Article 8, §23.22, First Amendment §3(d)) or a
--     substantial quotation now also counts as document-side reasoning.
--
--  2. The exists=true arm fired whenever the field mentioned something not being found,
--     even when it QUOTED the covenant. Now it also requires the ABSENCE of operative
--     covenant language (HomeGoods, Regal, Krispy Kreme cleared).
--
--  3. The exclusives check required the literal token "landlord"/"lessor". Real
--     covenants are routinely PASSIVE and never say it: "no other premises shall
--     contain...", "the other stores shall not be leased, used or occupied by...",
--     "No portion of the Shopping Center shall be used for...", "all other tenants or
--     other occupants ... shall". Three good covenants were flagged (Burlington KMW,
--     Woodhouse, ULTA).
--
-- Result: those two classes went 14 open -> 4, and the 4 survivors are genuine.
-- Body is 20240186's, with only the two predicates and one detail string changed.

create or replace view v_property_data_quality
with (security_invoker = true) as
with eff as (
  select la.id, la.property_id, la.tenant_name, la.qa, la.overrides, la.source_doc_ids,
         la.abstract as raw_abstract,
         apply_abstract_overrides(la.abstract, la.overrides) as eff_abstract
  from lease_abstracts la
  where la.abstract is not null
),
abs_base as (
  select e.id as abstract_id, e.property_id, e.tenant_name,
         e.eff_abstract as abstract,     -- OVERRIDE-MERGED: what a human sees
         e.raw_abstract,                 -- RAW: for override_no_op ONLY (see header)
         e.qa, e.overrides, e.source_doc_ids,
         case when jsonb_typeof(e.eff_abstract->'base_rent_schedule') = 'array'
              then e.eff_abstract->'base_rent_schedule' else '[]'::jsonb end as sched,
         coalesce(nullif(e.eff_abstract->'term'->>'current_term_start',''),
                  nullif(e.eff_abstract->'term'->>'rent_commencement',''),
                  nullif(e.eff_abstract->'term'->>'original_commencement','')) as term_start,
         nullif(e.eff_abstract->'term'->>'expiration','') as term_end
  from eff e
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
           m.field || ' exists=true rests on an MRI right-flag: the field records that no covenant was located and quotes no operative language. Set exists=false + a CONFIRM naming the granting instrument to obtain.'
         else
           m.field || ' exists=false cites an MRI right-flag with no statement that the documents were searched. A false flag means "never populated" and cannot establish absence.'
         end as detail
  from mri_flag_only m
  where m.txt ~* 'has_(radius_restriction|exclusives|co_tenancy_clause|percentage_rent)\y|\yMRI\y[^.]{0,40}\yflag'
    and (
      (m.ex is true
        and m.txt ~* '\y(not|no|none|nothing|never|absent|silent)\y[^.]{0,140}(locat|found|identified|stated|appear|exist|contain|reviewed)'
        and m.txt !~* '(shall (not )?(be )?(deemed|leased|used|occupied|contain|deliver|deem)|agrees that|covenants that|shall have the exclusive|no other (premises|stores|tenant|occupant)|no portion of the)')
      or
      (m.ex is false
        and m.txt !~* '\y(not|no|none|nothing|never|absent|silent)\y[^.]{0,140}(locat|found|identified|stated|appear|exist|contain|reviewed)'
        and m.txt !~* '(§|\y(article|section|exhibit|rider|addendum|amendment|work letter)\y\s*[0-9IVX])'
        and m.txt !~* '"[^"]{40,}"')
    )
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
         'exclusives.exists=true but exact_language does not quote a covenant restricting the landlord or other occupants ('
           || coalesce(length(b.abstract->'exclusives'->>'exact_language'),0)
           || ' chars) - per the abstraction standard this is exists=false + CONFIRM unless the covenant is quoted verbatim'
  from abs_base b
  where (b.abstract->'exclusives'->>'exists')::bool is true
    and ( coalesce(length(b.abstract->'exclusives'->>'exact_language'),0) < 60
       or (b.abstract->'exclusives'->>'exact_language') !~* '(landlord|lessor|shall not be (leased|used|occupied)|no portion of the shopping center|all other (tenants|occupants)|(no|not)\y[^.]{0,80}other (stores|premises|tenants|occupants)|other (tenants|occupants|stores|premises)[^.]{0,80}(shall|may|will) (not|be prohibited|be precluded))' )
  union all
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'mgmt_fee_implausible', 'discrepancy', 'field:rea_pma.pma_manager',
         'rea_pma.pma_manager states an impossible management fee: '
           || (b.abstract->'rea_pma'->>'pma_manager')
           || ' - mgmt_fee_pct is already a percent, so a x100 has been applied somewhere'
  from abs_base b
  where (b.abstract->'rea_pma'->>'pma_manager') ~ '(^|[^0-9.])([2-9][0-9]|[0-9]{3,})(\.[0-9]+)?%'
  union all
  -- ⚠️ RAW abstract on purpose: this check compares an override against the value
  -- it overrides. On the merged value every override equals itself.
  select b.property_id, 'abstract', b.abstract_id, b.tenant_name,
         'override_no_op', 'info', 'text:no-op override',
         count(*) || ' reviewer override(s) set a field to the value it already held - confirm the path was correct'
  from abs_base b, jsonb_each_text(b.overrides) o(path, val)
  where b.overrides is not null and b.overrides <> '{}'::jsonb
    and val = (case when array_length(string_to_array(o.path, '.'), 1) = 1
                    then b.raw_abstract->>o.path
                    when array_length(string_to_array(o.path, '.'), 1) = 2
                    then b.raw_abstract->(split_part(o.path,'.',1))->>(split_part(o.path,'.',2))
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


revoke all on v_property_data_quality from public, anon;
grant select on v_property_data_quality to authenticated, service_role;

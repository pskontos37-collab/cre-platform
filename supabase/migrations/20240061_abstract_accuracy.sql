-- 20240061_abstract_accuracy.sql
-- AI-abstract accuracy scorecard, measured against HUMAN ground truth.
--
-- Every locked (human-verified) abstract is a measurement: the reviewer examined
-- the high-value fields (the ReviewPanel's 7 scalars) and `overrides` records
-- exactly which AI values they had to correct. Accuracy = fields the human
-- accepted / fields the human reviewed. This is the number that makes the
-- abstractor's quality PROVABLE rather than claimed, and it recomputes live as
-- the team locks more abstracts.
--
-- REVIEWED_FIELD_COUNT mirrors src/pages/AbstractsPage.tsx REVIEW_FIELDS (7):
-- trade_name, tenant_legal_name, suite, square_footage,
-- term.rent_commencement, term.expiration, term.term_years.
-- If REVIEW_FIELDS grows, update the constant here.

create or replace view public.v_abstract_accuracy
with (security_invoker = true) as
with locked as (
  select id, overrides,
         (select count(*) from jsonb_object_keys(coalesce(overrides, '{}'::jsonb))) as corrected_fields
  from public.lease_abstracts
  where locked
)
select
  count(*)::int                                   as locked_abstracts,
  (count(*) * 7)::int                             as fields_reviewed,
  coalesce(sum(corrected_fields), 0)::int         as fields_corrected,
  case when count(*) = 0 then null
       else round(100.0 * (count(*) * 7 - coalesce(sum(corrected_fields), 0)) / (count(*) * 7), 1)
  end                                             as field_accuracy_pct
from locked;

-- Which fields the AI gets wrong most often (drives the next prompt fix).
create or replace view public.v_abstract_field_corrections
with (security_invoker = true) as
select k.field, count(*)::int as times_corrected
from public.lease_abstracts la
cross join lateral jsonb_object_keys(coalesce(la.overrides, '{}'::jsonb)) as k(field)
where la.locked
group by k.field
order by 2 desc;

grant select on public.v_abstract_accuracy, public.v_abstract_field_corrections to authenticated;

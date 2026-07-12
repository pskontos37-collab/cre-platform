-- 20240060_mri_reconciliation_view.sql
-- MRI-correction queue: every place the QA verifier found the abstract/documents
-- disagreeing with the MRI system-of-record, expanded from the per-abstract
-- qa.mri_reconciliation array into one row per conflict. governs tells you which
-- side is authoritative: 'mri' = the ABSTRACT is wrong (fix the abstract);
-- 'abstract' = the documents control and the MRI RECORD needs correction (this is
-- the actionable MRI-fix queue); 'unclear' = human adjudication.
-- security_invoker so lease_abstracts RLS (can_access_property) applies to callers.

create or replace view public.v_mri_reconciliation
with (security_invoker = true) as
select
  la.property_id,
  p.name                             as property_name,
  la.tenant_name,
  item->>'field'                     as field,
  item->>'abstract_value'            as abstract_value,
  item->>'mri_value'                 as mri_value,
  coalesce(item->>'governs', 'unclear') as governs,
  item->>'note'                      as note,
  la.qa_at
from public.lease_abstracts la
join public.properties p on p.id = la.property_id
cross join lateral jsonb_array_elements(coalesce(la.qa->'mri_reconciliation', '[]'::jsonb)) as item
where la.qa is not null;

grant select on public.v_mri_reconciliation to authenticated;

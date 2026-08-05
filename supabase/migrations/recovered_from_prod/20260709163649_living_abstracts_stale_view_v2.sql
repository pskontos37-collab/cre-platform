
-- v2 detector: derive each abstract's tenant FOLDER from its own source_doc_ids
-- (the docs it was actually built from), then flag it stale if a NEWER document
-- exists in that same folder. Precise — no tenant-name fuzzy matching, no false
-- negatives from store-number folder names. Prefix-equality (not LIKE) avoids
-- backslash-escape issues in UNC file paths.
create or replace view public.v_stale_abstracts
with (security_invoker = true) as
with folders as (
  select distinct la.id, la.property_id, la.tenant_name, la.generated_at,
         la.locked, la.human_verified, la.qa_status,
         substring(d.file_path from '^(.*\\TENANTS\\[^\\]+\\)') as folder
  from public.lease_abstracts la
  cross join lateral unnest(coalesce(la.source_doc_ids, '{}'::uuid[])) as sd(doc_id)
  join public.documents d on d.id = sd.doc_id
  where d.file_path ilike '%TENANTS%'
)
select f.id, f.property_id, f.tenant_name, f.generated_at, f.locked,
       f.human_verified, f.qa_status,
       count(nd.id) as new_docs, max(nd.created_at) as latest_doc_at
from folders f
join public.documents nd
  on nd.property_id = f.property_id
 and nd.created_at > f.generated_at
 and left(nd.file_path, length(f.folder)) = f.folder
where f.folder is not null
group by f.id, f.property_id, f.tenant_name, f.generated_at, f.locked, f.human_verified, f.qa_status;

comment on view public.v_stale_abstracts is
  'Living Abstracts: an abstract is stale if a document newer than generated_at exists in the same TENANTS folder its source_doc_ids came from. Refresh via scripts/refresh_stale_abstracts.ps1 (skips locked).';

grant select on public.v_stale_abstracts to authenticated;

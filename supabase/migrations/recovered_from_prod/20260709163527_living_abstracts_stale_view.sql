
-- Living Abstracts: detect abstracts whose tenant has documents newer than the
-- abstract's generated_at. A VIEW (not a trigger) so bulk document ingests add
-- ZERO write amplification — staleness is computed on read. security_invoker so
-- the caller's RLS on lease_abstracts/documents still applies.
create or replace view public.v_stale_abstracts
with (security_invoker = true) as
with a as (
  select la.id, la.property_id, la.tenant_name, la.generated_at, la.locked,
         la.human_verified, la.qa_status,
         coalesce(t.name, la.tenant_name) as t_name, t.trade_name,
         coalesce(t.file_aliases, '{}'::text[]) as aliases
  from public.lease_abstracts la
  left join public.tenants t
    on lower(t.name) = lower(la.tenant_name) or lower(t.trade_name) = lower(la.tenant_name)
)
select a.id, a.property_id, a.tenant_name, a.generated_at, a.locked,
       a.human_verified, a.qa_status, s.new_docs, s.latest_doc_at
from a
join lateral (
  select count(*) as new_docs, max(d.created_at) as latest_doc_at
  from public.documents d
  where d.property_id = a.property_id
    and d.created_at > a.generated_at
    and d.file_path ilike '%TENANTS%'
    and (
      regexp_replace(lower(d.file_path), '[^a-z0-9]', '', 'g')
        like '%' || regexp_replace(lower(a.t_name), '[^a-z0-9]', '', 'g') || '%'
      or (a.trade_name is not null and regexp_replace(lower(d.file_path), '[^a-z0-9]', '', 'g')
            like '%' || regexp_replace(lower(a.trade_name), '[^a-z0-9]', '', 'g') || '%')
      or exists (
        select 1 from unnest(a.aliases) al
        where length(regexp_replace(lower(al), '[^a-z0-9]', '', 'g')) >= 4
          and regexp_replace(lower(d.file_path), '[^a-z0-9]', '', 'g')
              like '%' || regexp_replace(lower(al), '[^a-z0-9]', '', 'g') || '%'
      )
    )
) s on s.new_docs > 0;

comment on view public.v_stale_abstracts is
  'Living Abstracts: lease_abstracts with >=1 tenant document created after generated_at. Refresh via scripts/refresh_stale_abstracts.ps1 (skips locked).';

grant select on public.v_stale_abstracts to authenticated;

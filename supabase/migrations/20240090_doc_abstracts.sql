-- 20240090_doc_abstracts.sql
-- Generic narrative document abstracts. One row per source document, generated
-- on demand by the doc-abstract edge function (service role) and read by
-- authenticated users scoped to the property. Distinct from lease_abstracts
-- (which follows the firm's lease template keyed by tenant): this is a
-- kind-agnostic NARRATIVE abstract used for transaction closing documents and
-- management (PMA) agreements — "full abstract of the active documents".
--
-- Keyed by document_id (unique) so re-generating replaces in place. `kind`
-- tags the source domain ('transaction' | 'management' | 'document') and
-- source_context carries the linking metadata (transaction/agreement id + role)
-- without a hard FK, so the table stays generic.

create table if not exists public.doc_abstracts (
  id             uuid primary key default uuid_generate_v4(),
  document_id    uuid not null references public.documents(id) on delete cascade,
  property_id    uuid references public.properties(id) on delete cascade,
  kind           text not null default 'document',
  title          text,
  abstract       jsonb,
  source_context jsonb,
  status         text not null default 'complete',
  model          text,
  error          text,
  generated_at   timestamptz,
  updated_at     timestamptz not null default now(),
  unique (document_id)
);

create index if not exists doc_abstracts_property on public.doc_abstracts(property_id);
create index if not exists doc_abstracts_kind on public.doc_abstracts(kind);

alter table public.doc_abstracts enable row level security;

-- Reads mirror the documents_select scope: company-wide (null property) or a
-- property the caller can access. Writes are service-role only (edge function),
-- which bypasses RLS, so there is deliberately no insert/update policy.
drop policy if exists "doc_abstracts_select" on public.doc_abstracts;
create policy "doc_abstracts_select" on public.doc_abstracts
  for select using (property_id is null or public.can_access_property(property_id));

grant select on public.doc_abstracts to authenticated;

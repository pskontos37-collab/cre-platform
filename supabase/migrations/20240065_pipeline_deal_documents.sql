-- 20240065_pipeline_deal_documents.sql
-- Per-deal acquisition document repository. Mirrors transaction_documents: a
-- join table linking a pipeline deal to `documents` rows, each tagged with a
-- role (OM, rent roll, T-12, PSA, title, environmental, estoppel ...). Files are
-- stored under the pipeline/<deal_id>/ prefix (already covered by the storage
-- policies in 20240064). Deleting a deal or its document removes the link.

create table if not exists public.pipeline_deal_documents (
  id uuid primary key default uuid_generate_v4(),
  deal_id uuid not null references public.pipeline_deals(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  role text,   -- om | rent_roll | operating_statement | financials | loi | psa | title | survey | environmental | estoppel | service_contract | other
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (deal_id, document_id)
);
create index if not exists pipeline_deal_documents_deal on public.pipeline_deal_documents(deal_id);
create index if not exists pipeline_deal_documents_doc on public.pipeline_deal_documents(document_id);

alter table public.pipeline_deal_documents enable row level security;
create policy "pipeline_deal_documents_select" on public.pipeline_deal_documents
  for select using (public.is_admin_or_am());
create policy "pipeline_deal_documents_write" on public.pipeline_deal_documents
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.pipeline_deal_documents to authenticated;

notify pgrst, 'reload schema';

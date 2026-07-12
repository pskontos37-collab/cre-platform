-- 20240037_service_agreements.sql
-- service_agreements: vendor service contracts (landscaping, roofing, HVAC,
-- trash, security, ...) abstracted from (a) corpus service-agreement documents
-- and (b) the authoritative V:\...\OPERATIONS\Service Agreements folders, by
-- scripts/extract_service_agreements.ps1 (+ extract_service_agreement_files.ps1).
-- One row per source contract file: source_key = canonical file path (V:\ form,
-- lowercased) so both pipelines upsert to the same row; document_id links the
-- corpus copy when one exists (drives the /services doc-search link). The panel
-- derives expiring/expired from end_date + auto_renews; `status` holds manual
-- overrides that survive re-extraction ('terminated', 'superseded').

create table if not exists public.service_agreements (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  source_key text not null unique,
  file_path text,
  vendor text not null,
  service_category text not null,
  description text,
  agreement_date date,
  start_date date,
  end_date date,
  term_summary text,
  auto_renews boolean,
  cancel_notice_days int,
  annual_value numeric,
  pricing_summary text,
  status text not null default 'unknown'
    check (status in ('active','expired','terminated','superseded','unknown')),
  notes text,
  source text not null default 'ai',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_agreements_prop on public.service_agreements(property_id);
create index if not exists service_agreements_end on public.service_agreements(end_date);

alter table public.service_agreements enable row level security;
create policy "service_agreements_select" on public.service_agreements
  for select using (public.can_access_property(property_id));
create policy "service_agreements_write" on public.service_agreements
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.service_agreements to authenticated;

notify pgrst, 'reload schema';

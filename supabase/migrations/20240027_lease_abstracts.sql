-- 20240027_lease_abstracts.sql
-- AI-generated lease abstracts following the Wilkow "Lease Abstract Template"
-- (Desktop\Misc\Accounting\Lease Abstract Template.xlsx). One row per
-- property+tenant; `abstract` holds the template-shaped JSON (each section
-- carries value/details + the lease section reference the model cited).

create table if not exists public.lease_abstracts (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  tenant_name text not null,
  status text not null default 'complete',      -- generating | complete | error
  abstract jsonb,
  source_doc_ids uuid[],
  model text,
  error text,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, tenant_name)
);

alter table public.lease_abstracts enable row level security;
create policy "lease_abstracts_select" on public.lease_abstracts
  for select using (public.can_access_property(property_id));
create policy "lease_abstracts_write" on public.lease_abstracts
  for all using (public.is_admin_or_am());

grant select, insert, update, delete on public.lease_abstracts to authenticated;

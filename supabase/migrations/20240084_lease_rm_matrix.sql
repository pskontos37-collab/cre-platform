-- 20240084_lease_rm_matrix.sql
-- Lease repair & maintenance responsibility matrix. One row per
-- property + tenant + building system stating WHO the lease makes responsible
-- (landlord / tenant / shared), with the VERBATIM lease quote and section cite
-- so a manager reviewing a work order can verify against the actual document
-- (decision support, never auto-decision).
--
-- Populated by scripts/extract_rm_matrix.ps1 (Claude over the lease text
-- chunks of each lease_abstracts row's governing docs; amendments supersede),
-- keyed like tenant_contacts (denormalized property_id + tenant_name, with
-- optional links to structured tenants/leases rows). Surfaced in the
-- /workorders detail panel matched to the work-order category.

create table if not exists public.lease_rm_matrix (
  id             uuid primary key default uuid_generate_v4(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  tenant_id      uuid references public.tenants(id) on delete set null,
  lease_id       uuid references public.leases(id) on delete set null,
  abstract_id    uuid references public.lease_abstracts(id) on delete set null,
  tenant_name    text not null,
  -- building system the clause governs
  system         text not null
                   check (system in ('hvac','plumbing','electrical','roof','structure',
                                     'storefront_doors_glass','interior','common_areas',
                                     'parking_lot','signage','pest_control','landscaping',
                                     'fire_life_safety','utilities','general')),
  responsible    text not null
                   check (responsible in ('landlord','tenant','shared','unclear')),
  -- one-line plain-language reading, e.g. "Tenant maintains its own HVAC unit;
  -- landlord replaces if beyond repair"
  summary        text,
  -- verbatim lease language (the manager's ground truth)
  quote          text,
  section_ref    text,             -- e.g. "Sec. 8.2; 2nd Amd Sec. 4"
  source_doc_ids uuid[],           -- governing lease + amendment documents
  source         text not null default 'ai_extraction'
                   check (source in ('ai_extraction','manual')),
  verified       boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists lease_rm_tenant on public.lease_rm_matrix (property_id, tenant_name);
create index if not exists lease_rm_system on public.lease_rm_matrix (system);

alter table public.lease_rm_matrix enable row level security;

-- Staff read/maintain within property scope (same shape as tenant_contacts);
-- managers may correct rows or mark them verified after checking the lease.
drop policy if exists "lease_rm_select" on public.lease_rm_matrix;
create policy "lease_rm_select" on public.lease_rm_matrix
  for select using (public.can_access_property(property_id));

drop policy if exists "lease_rm_insert" on public.lease_rm_matrix;
create policy "lease_rm_insert" on public.lease_rm_matrix
  for insert with check (public.can_access_property(property_id));

drop policy if exists "lease_rm_update" on public.lease_rm_matrix;
create policy "lease_rm_update" on public.lease_rm_matrix
  for update using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

drop policy if exists "lease_rm_delete" on public.lease_rm_matrix;
create policy "lease_rm_delete" on public.lease_rm_matrix
  for delete using (public.can_access_property(property_id));

grant select, insert, update, delete on public.lease_rm_matrix to authenticated;

-- 20240069_tenant_contacts.sql
-- Operations contact directory: billing / operational / legal-notice / corporate
-- contacts for each tenant at each property. One row per contact. Legal-notice
-- rows carry the full mailing address pulled from the lease "Notices" clause
-- (seeded by scripts/extract_notice_addresses.ps1) so the team can pull the
-- right notice / estoppel recipients without re-reading the lease each time.
--
-- Keyed on property_id + tenant_name (denormalized like lease_abstracts, since
-- not every lease has a tenants row). Optional tenant_id / lease_id link back to
-- the structured records when they exist.

create table if not exists public.tenant_contacts (
  id             uuid primary key default uuid_generate_v4(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  tenant_id      uuid references public.tenants(id) on delete set null,
  lease_id       uuid references public.leases(id) on delete set null,
  tenant_name    text not null,
  -- what kind of contact this is
  contact_type   text not null default 'general'
                   check (contact_type in ('billing','operational','legal_notice','corporate','general')),
  -- people / org
  contact_name   text,        -- individual, if named
  title          text,        -- role / title
  company        text,        -- entity to address (often the tenant's legal name or a parent)
  attn           text,        -- "Attn:" line (e.g. "General Counsel", "Real Estate Dept")
  email          text,
  phone          text,
  -- mailing address (used mainly by legal_notice / billing)
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  zip            text,
  country        text,
  -- classification / provenance
  is_primary     boolean not null default false,   -- primary contact within its type for the tenant
  copy_to        boolean not null default false,    -- a "with a copy to" secondary notice recipient
  source         text not null default 'manual'
                   check (source in ('manual','ai_extraction','mri','import')),
  source_doc_ids uuid[],                            -- governing lease docs (for ai_extraction provenance)
  source_section text,                              -- lease section cited, e.g. "§27 Notices; 2nd Amd §4"
  verified       boolean not null default false,    -- staff confirmed an AI-extracted value
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tenant_contacts_property on public.tenant_contacts(property_id);
create index if not exists tenant_contacts_tenant   on public.tenant_contacts(property_id, tenant_name);
create index if not exists tenant_contacts_type     on public.tenant_contacts(contact_type);

alter table public.tenant_contacts enable row level security;

-- Read: anyone who can see the property. Write: same scope, so a property
-- manager can maintain contacts for their assigned properties (can_access_property
-- already returns true globally for admin / asset_manager).
drop policy if exists "tenant_contacts_select" on public.tenant_contacts;
create policy "tenant_contacts_select" on public.tenant_contacts
  for select using (public.can_access_property(property_id));

drop policy if exists "tenant_contacts_insert" on public.tenant_contacts;
create policy "tenant_contacts_insert" on public.tenant_contacts
  for insert with check (public.can_access_property(property_id));

drop policy if exists "tenant_contacts_update" on public.tenant_contacts;
create policy "tenant_contacts_update" on public.tenant_contacts
  for update using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));

drop policy if exists "tenant_contacts_delete" on public.tenant_contacts;
create policy "tenant_contacts_delete" on public.tenant_contacts
  for delete using (public.can_access_property(property_id));

grant select, insert, update, delete on public.tenant_contacts to authenticated;

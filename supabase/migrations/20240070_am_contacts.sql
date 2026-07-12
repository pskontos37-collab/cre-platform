-- 20240070_am_contacts.sql
-- Asset-management relationship directory: the rolodex of people AMs build up
-- through communications and lease negotiations — tenant real-estate departments,
-- leasing brokers, attorneys, lenders, capital partners, consultants, municipal
-- contacts. A firm-wide working resource for asset managers when they're working
-- a deal, so it is NOT property-scoped (though a contact can optionally attach to
-- properties and/or a pipeline deal). Surfaced as the "Relationships" tab on the
-- /contacts page. Restricted to asset managers + admin.

create table if not exists public.am_contacts (
  id            uuid primary key default uuid_generate_v4(),
  category      text not null default 'other'
                  check (category in (
                    'real_estate_dept','broker','attorney','lender',
                    'partner_lp','consultant','municipality','other')),
  -- person / firm
  contact_name  text,
  title         text,
  company       text,        -- firm / organization
  represents    text,        -- who they act for, e.g. "Starbucks", "landlord", "the buyer"
  email         text,
  phone         text,
  mobile        text,
  -- mailing address (optional)
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  zip           text,
  -- searchable relationship metadata
  market        text,        -- geographic market / region (free text)
  specialty     text,        -- e.g. "retail leasing", "land use", "CMBS debt"
  tags          text[],      -- free tags
  -- optional cross-links
  deal_id       uuid references public.pipeline_deals(id) on delete set null,
  property_ids  uuid[],      -- assets this relationship touches
  -- workflow
  is_favorite   boolean not null default false,
  last_contacted date,
  source        text,        -- how we got them ("GLA renewal 2025", referral, conference…)
  notes         text,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists am_contacts_category on public.am_contacts(category);
create index if not exists am_contacts_deal     on public.am_contacts(deal_id);
create index if not exists am_contacts_company   on public.am_contacts(company);

alter table public.am_contacts enable row level security;

-- Asset managers + admin only, read and write (their working resource).
drop policy if exists "am_contacts_select" on public.am_contacts;
create policy "am_contacts_select" on public.am_contacts
  for select using (public.is_admin_or_am());

drop policy if exists "am_contacts_write" on public.am_contacts;
create policy "am_contacts_write" on public.am_contacts
  for all using (public.is_admin_or_am()) with check (public.is_admin_or_am());

grant select, insert, update, delete on public.am_contacts to authenticated;

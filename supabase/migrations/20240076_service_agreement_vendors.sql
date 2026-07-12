-- 20240076_service_agreement_vendors.sql
-- A small vendor directory for the /services/new Service Agreement generator, so
-- a vendor's name / business / notice address / email auto-populate after the
-- first time they're used. One row per vendor, keyed by a normalized name
-- (name_key = lower(trim(name)), set by the client) so re-use upserts. Written
-- best-effort by the frontend on every generate / send.

create table if not exists public.service_agreement_vendors (
  id uuid primary key default uuid_generate_v4(),
  name_key text not null unique,             -- lower(trim(name)); client-set upsert key
  name text not null,
  business text,
  address_lines text[] not null default '{}',
  email text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.service_agreement_vendors enable row level security;

-- Internal shared reference list: any active authenticated user may read and
-- maintain it (upsert needs insert + update).
create policy "svc_vendors_select" on public.service_agreement_vendors
  for select using (true);
create policy "svc_vendors_insert" on public.service_agreement_vendors
  for insert with check (true);
create policy "svc_vendors_update" on public.service_agreement_vendors
  for update using (true);
create policy "svc_vendors_delete" on public.service_agreement_vendors
  for delete using (public.is_admin_or_am());

grant select, insert, update, delete on public.service_agreement_vendors to authenticated;

notify pgrst, 'reload schema';

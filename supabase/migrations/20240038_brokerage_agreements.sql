-- 20240038_brokerage_agreements.sql
-- brokerage_agreements: leasing-brokerage engagements and commission agreements
-- (exclusive leasing agreements + their amendments/extensions/terminations,
-- cooperating-broker agreements, tenant-specific commission agreements, and
-- ancillary indemnities/declarations) abstracted from the properties'
-- OPERATIONS\Brokerage & Leasing Agreements folders by
-- scripts/extract_brokerage_agreements.ps1. One row per source file:
-- source_key = lowercased V:\ path (KM East/West hold identical copies of the
-- shared docs -> one row per property); document_id links the corpus copy when
-- one exists. The /brokerage panel groups rows into engagements (property x
-- broker x tenant) and derives the engagement's lifecycle from the governing
-- document's end_date, with any termination row forcing 'terminated'.

create table if not exists public.brokerage_agreements (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  source_key text not null unique,
  file_path text,
  broker text not null,
  agreement_type text not null check (agreement_type in
    ('exclusive_leasing','cooperating_broker','commission','amendment',
     'extension','termination','indemnity','declaration','letter','other')),
  tenant text,
  description text,
  agreement_date date,
  start_date date,
  end_date date,
  term_summary text,
  commission_summary text,
  auto_renews boolean,
  cancel_notice_days int,
  amends text,
  status text not null default 'unknown'
    check (status in ('active','expired','terminated','superseded','unknown')),
  notes text,
  source text not null default 'ai',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brokerage_agreements_prop on public.brokerage_agreements(property_id);
create index if not exists brokerage_agreements_end on public.brokerage_agreements(end_date);

alter table public.brokerage_agreements enable row level security;
create policy "brokerage_agreements_select" on public.brokerage_agreements
  for select using (public.can_access_property(property_id));
create policy "brokerage_agreements_write" on public.brokerage_agreements
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.brokerage_agreements to authenticated;

notify pgrst, 'reload schema';

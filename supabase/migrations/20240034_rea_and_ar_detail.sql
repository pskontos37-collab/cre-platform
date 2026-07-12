-- 20240034_rea_and_ar_detail.sql
-- (1) rea_agreements: Reciprocal Easement / Operation & Easement agreements per
--     property, seeded from the corpus REA/OEA documents. members jsonb links
--     REA parties to their MRI lease ids so live A/R joins on the /rea panel.
-- (2) ar_aging_detail: invoice-level lines behind each ar_aging tenant row
--     (drill-down). Cascades on ar_aging delete, so snapshot reloads stay clean.
-- (3) ar_notes: durable operational annotations keyed (property_id, mri_lease_id)
--     that SURVIVE snapshot reloads (e.g. "settlement", "REA CAM overbilling").

create table if not exists public.rea_agreements (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  name text not null,
  agreement_date date,
  term_summary text,
  operator text,
  members jsonb not null default '[]'::jsonb,
  cost_sharing text,
  key_provisions text,
  amendments text,
  open_items text,
  source_docs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rea_agreements_prop on public.rea_agreements(property_id);

alter table public.rea_agreements enable row level security;
create policy "rea_agreements_select" on public.rea_agreements
  for select using (public.can_access_property(property_id));
create policy "rea_agreements_write" on public.rea_agreements
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.rea_agreements to authenticated;

create table if not exists public.ar_aging_detail (
  id uuid primary key default uuid_generate_v4(),
  ar_aging_id uuid not null references public.ar_aging(id) on delete cascade,
  invoice_date date,
  category text,
  category_desc text,
  source text,
  amount numeric not null,
  bucket text not null check (bucket in ('current','b30','b60','b90','b120')),
  created_at timestamptz not null default now()
);
create index if not exists ar_aging_detail_parent on public.ar_aging_detail(ar_aging_id);

alter table public.ar_aging_detail enable row level security;
create policy "ar_aging_detail_select" on public.ar_aging_detail
  for select using (exists (
    select 1 from public.ar_aging a
    where a.id = ar_aging_id and public.can_access_property(a.property_id)
  ));
create policy "ar_aging_detail_write" on public.ar_aging_detail
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.ar_aging_detail to authenticated;

create table if not exists public.ar_notes (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  mri_lease_id text not null,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, mri_lease_id)
);

alter table public.ar_notes enable row level security;
create policy "ar_notes_select" on public.ar_notes
  for select using (public.can_access_property(property_id));
create policy "ar_notes_write" on public.ar_notes
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.ar_notes to authenticated;

-- 20240059_emergency_manuals.sql
-- emergency_manuals: firm-wide reference library of the emergency-preparedness
-- deliverables every managed property completes annually -- the Emergency
-- Procedures Manual AND its Active Shooter training/drill recap
-- (K:\Property Management\Emergency Procedures Manual\<property>\...). Powers
-- the /emergency-manuals page. Each row is one file (a given property + doc_kind
-- + year); the most recent per (property, doc_kind) is flagged is_current and
-- older ones fold underneath as history.
--
-- Files live in the documents bucket under emergency-manuals/... - both the
-- original Word document (file_path) and a PDF rendering (pdf_path) for
-- in-browser viewing.
--
-- Like form_templates, these are a firm-wide PM reference and are NOT
-- property-scoped: the program covers third-party-managed properties that have
-- no row in `properties`, so property is stored as free text (property_id is an
-- optional link for owned properties). Every active user can read; writes are
-- admin/AM (the service-role loader does the actual uploads - no UI upload).

create table if not exists public.emergency_manuals (
  id uuid primary key default uuid_generate_v4(),
  property_name text not null,            -- display name (may not exist in `properties`)
  property_id uuid references public.properties(id) on delete set null,  -- optional owned-property link
  portfolio text,                         -- optional grouping, e.g. 'CenterSquare PA Portfolio'
  doc_kind text not null default 'manual' -- which annual deliverable this file is
    check (doc_kind in ('manual', 'active_shooter')),
  manual_year int,                        -- best-effort year the manual covers (parsed from source)
  effective_date date,                    -- best-effort date parsed from the filename, when present
  is_current boolean not null default false,  -- latest manual for this property
  version_label text,                     -- badge text, e.g. '2026' / 'Final' / 'Master'
  file_path text not null unique,         -- storage key of the original Word document
  file_name text not null,                -- original filename for the download
  mime_type text,
  file_size_bytes integer,
  pdf_path text,                          -- storage key of the PDF rendering (viewer)
  sort_order int not null default 0,
  is_active boolean not null default true,
  source_path text,                       -- authoritative K:\ origin of the file
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists emergency_manuals_property
  on public.emergency_manuals(property_name, doc_kind, manual_year desc);

alter table public.emergency_manuals enable row level security;
create policy "emergency_manuals_select" on public.emergency_manuals
  for select to authenticated using (true);
create policy "emergency_manuals_write" on public.emergency_manuals
  for all to authenticated
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());
grant select, insert, update, delete on public.emergency_manuals to authenticated;

-- Storage read for the emergency-manuals/ prefix. The existing documents-bucket
-- policy only covers p/<property_id>/ keys (property-scoped); these manuals are
-- a firm-wide reference so any authenticated user may sign/read them (mirrors
-- the forms/ prefix policy from 20240056).
drop policy if exists "auth read emergency-manuals prefix" on storage.objects;
create policy "auth read emergency-manuals prefix"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents' and split_part(name, '/', 1) = 'emergency-manuals');

notify pgrst, 'reload schema';

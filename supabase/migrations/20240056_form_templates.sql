-- 20240056_form_templates.sql
-- form_templates: firm-wide reference forms & templates library (/forms page).
-- First residents: the 2026 Retail + Office Property Inspection Reports (PM
-- quarterly site-inspection scorecards from K:\Property Management\POLICY
-- MANUAL\16.0 Property Operations\16.3 Property Inspections). Files live in
-- the documents bucket under forms/<category>/... - both the original
-- workbook (file_path) and a PDF rendering (pdf_path) for in-browser viewing.
-- Reference forms are firm-wide, NOT property-scoped: every active user can
-- read; writes are admin/AM (service-role loaders do the actual uploads - no
-- UI upload yet).

create table if not exists public.form_templates (
  id uuid primary key default uuid_generate_v4(),
  category text not null,                 -- 'inspection', later 'onboarding', ...
  title text not null,
  description text,
  version_label text,                     -- e.g. '2026'
  file_path text not null unique,         -- storage key of the original workbook/doc
  file_name text not null,                -- original filename for the download
  mime_type text,
  file_size_bytes integer,
  pdf_path text,                          -- storage key of the PDF rendering (viewer)
  sort_order int not null default 0,
  is_active boolean not null default true,
  source_path text,                       -- authoritative K:\ / V:\ origin of the file
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.form_templates enable row level security;
create policy "form_templates_select" on public.form_templates
  for select to authenticated using (true);
create policy "form_templates_write" on public.form_templates
  for all to authenticated
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());
grant select, insert, update, delete on public.form_templates to authenticated;

-- Storage read for the forms/ prefix. The existing documents-bucket policy
-- only covers p/<property_id>/ keys (property-scoped); reference forms are
-- firm-wide so any authenticated user may sign/read them.
drop policy if exists "auth read forms prefix" on storage.objects;
create policy "auth read forms prefix"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents' and split_part(name, '/', 1) = 'forms');

notify pgrst, 'reload schema';

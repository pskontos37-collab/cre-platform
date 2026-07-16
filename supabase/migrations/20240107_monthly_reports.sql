-- 20240107_monthly_reports.sql
-- monthly_reports: the final, board-ready monthly reporting PACKAGE that each
-- managed property produces every month (the consolidated PDF: cover +
-- financials + rent roll + variance narrative + supporting schedules). This is
-- the deliverable, distinct from the raw GL/RR data already loaded into the
-- platform. Powers the /monthly-reports page so staff can pull up a property's
-- report for any month without digging through K:\.
--
-- Each row is one (property, year, month) final package. The most recent month
-- per property is flagged is_current. Only the final consolidated package is
-- stored for now (report_type left extensible for future variants).
--
-- Files live in the documents bucket under p/<property_id>/monthly-reports/... .
-- Storing them under the p/<property_id>/ prefix means the EXISTING documents
-- bucket storage policy (20240042, keyed on can_access_property) already scopes
-- who can sign/read them -- no new storage policy is needed. Unlike the
-- firm-wide emergency_manuals / form_templates libraries, these packages contain
-- full financials, so reads are PROPERTY-SCOPED (can_access_property), matching
-- the sensitivity of the Financials page.
--
-- The service-role loader (scripts/load_monthly_reports.ps1) does the uploads;
-- there is no UI upload.

create table if not exists public.monthly_reports (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  property_name text not null,                 -- denormalized display name
  report_year int not null,
  report_month int not null check (report_month between 1 and 12),
  report_type text not null default 'consolidated'  -- 'consolidated' today; room for future variants
    check (report_type in ('consolidated', 'final')),
  is_current boolean not null default false,   -- latest month for this property
  file_path text not null unique,              -- storage key: p/<property_id>/monthly-reports/<year>-<mm>.pdf
  file_name text not null,                     -- original K:\ filename, used for the download name
  mime_type text default 'application/pdf',
  file_size_bytes bigint,
  page_count int,                              -- best-effort; may be null
  source_path text,                            -- authoritative K:\ origin of the file
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, report_year, report_month, report_type)
);

create index if not exists monthly_reports_property_period
  on public.monthly_reports(property_id, report_year desc, report_month desc);

alter table public.monthly_reports enable row level security;

-- Reads: these packages carry full financials (GL, bank statements, equity
-- rollforward, distribution summaries), so like the /monthly-reports page (which
-- is `restricted`), reads are limited to admin / asset_manager -- AND still
-- honor property scoping, so a scoped asset manager only sees their own
-- properties and a property manager sees nothing here. Writes are the admin/AM
-- roles (the service-role loader performs the actual uploads).
create policy "monthly_reports_select" on public.monthly_reports
  for select to authenticated
  using (public.is_admin_or_am() and public.can_access_property(property_id));
create policy "monthly_reports_write" on public.monthly_reports
  for all to authenticated
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

grant select, insert, update, delete on public.monthly_reports to authenticated;

-- No new storage policy: keys live under p/<property_id>/monthly-reports/..., so
-- the existing "auth read documents bucket" policy (20240042) already governs
-- read/sign access via can_access_property.

notify pgrst, 'reload schema';

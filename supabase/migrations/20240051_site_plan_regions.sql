-- 20240051_site_plan_regions.sql
-- (a) Retag the genuine centre-wide site plans / tenant-directory maps to
--     doc_type='site_plan'. This is deliberately NARROW: the corpus has many
--     documents that merely MENTION "site plan" (tenant construction sets,
--     signage packages, ALTA surveys, PCA reports, LOD architectural details).
--     Those are NOT leasing site plans. We keep only:
--       * files in an OPERATIONS\Site Plans folder,
--       * the authoritative RETAIL\PROPERTY INFORMATION\<prop>\Site Plan\ maps,
--       * the recurring "6.1 ... Site Plan" monthly-report maps,
--       * files whose name is a "Site Map" / "Site Plan (date)".
--     …and explicitly exclude anything under a \TENANTS\ folder plus survey /
--     elevation / LOD / signage drawings. strpos() (literal, no LIKE-escape
--     headache with the backslash-laden UNC paths) drives the match.
--
-- (b) site_plan_regions — one row per suite/tenant hotspot drawn on a site plan
--     page, positioned by NORMALISED [0,1] bbox so it overlays cleanly on the
--     page rendered at any size. Populated by the siteplan-extract edge fn
--     (Claude vision) and reconciled to a rent-roll suite / unit. source tracks
--     vision vs manual so a hand-fix is never clobbered by a re-extract.

update public.documents d
set doc_type = 'site_plan'
from (
  select id,
    lower(coalesce(file_path,'')) fp,
    lower(coalesce(file_name,'')) fn
  from public.documents
  where doc_type = 'other'
) c
where d.id = c.id
  and strpos(c.fp, '\tenants\') = 0
  and (
        strpos(c.fp, 'operations\site plans') > 0
     or (strpos(c.fp, 'property information') > 0 and strpos(c.fp, '\site plan\') > 0)
     or (strpos(c.fn, 'site plan') > 0 and strpos(c.fp, 'monthly report') > 0)
     or (strpos(c.fn, 'site plan') > 0 and strpos(c.fp, 'monthly reporting') > 0)
     or strpos(c.fn, 'site map') > 0
     or strpos(c.fn, 'site plan_') > 0
  )
  and strpos(c.fn, 'survey') = 0
  and strpos(c.fn, 'elevation') = 0
  and strpos(c.fn, ' lod') = 0
  and strpos(c.fn, 'lod.pdf') = 0
  and strpos(c.fn, 'signage') = 0;

create table if not exists public.site_plan_regions (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references public.documents(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  page int not null default 1,
  -- normalised bounding box, all in [0,1] relative to the rendered page
  x numeric not null,
  y numeric not null,
  w numeric not null,
  h numeric not null,
  suite_label  text,          -- suite/space id as printed on the plan (e.g. "A01", "D3")
  tenant_label text,          -- tenant name printed on the plan ('' / null when blank/vacant)
  unit_id uuid references public.units(id) on delete set null,
  rr_suite text,              -- reconciled rent-roll suite key (rent_roll_rows.suite)
  confidence numeric,         -- vision confidence 0..1
  source text not null default 'vision' check (source in ('vision','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists site_plan_regions_doc  on public.site_plan_regions(document_id);
create index if not exists site_plan_regions_prop on public.site_plan_regions(property_id);

alter table public.site_plan_regions enable row level security;
create policy "site_plan_regions_select" on public.site_plan_regions
  for select using (public.can_access_property(property_id));
create policy "site_plan_regions_write" on public.site_plan_regions
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.site_plan_regions to authenticated;

notify pgrst, 'reload schema';

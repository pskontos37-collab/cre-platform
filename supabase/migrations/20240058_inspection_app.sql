-- 20240058_inspection_app.sql
-- Turns the Phase-1 `inspections` stub into the store for the in-app Property
-- Inspection app (/inspections). A property manager fills the retail/office
-- scorecard in the browser, attaches photos, and submits; we record a full
-- inspection row (structured responses + computed score), stash the photos and
-- a generated PDF report in the property-scoped documents bucket, and file the
-- PDF as a `documents` row (doc_type='inspection') so it also shows in the
-- property's document list.
--
-- Storage layout (all under the property-scoped prefix so the existing
-- can_access_property read policy from 20240042 governs reads):
--   p/<property_id>/inspections/<inspection_id>.pdf              -- report
--   p/<property_id>/inspections/<inspection_id>/photo-<n>.<ext>  -- photos

alter table public.inspections
  add column if not exists form_kind      text,        -- 'retail' | 'office' (which template)
  add column if not exists form_version   text,        -- e.g. '2026'
  add column if not exists status         text not null default 'submitted'
    check (status in ('draft','submitted')),
  add column if not exists weather        text,
  add column if not exists special_events text,
  add column if not exists responses      jsonb,        -- [{section, items:[{n,label,na,yn,score,detail,photos[]}]}]
  add column if not exists average_score  numeric,
  add column if not exists items_scored   integer,
  add column if not exists items_flagged  integer,      -- count of 1/2/5 scores (need a note)
  add column if not exists comments       text,
  add column if not exists action_items   text,
  add column if not exists photo_paths     text[],       -- flat list of all photo storage keys
  add column if not exists pdf_path        text,         -- storage key of the generated PDF report
  add column if not exists updated_at      timestamptz not null default now();

create index if not exists inspections_prop_date
  on public.inspections(property_id, inspection_date desc);

-- inspections had a SELECT policy only (20240009). A property manager scoped to
-- a property may create/update inspections for it; mirrors cam_recon_insert.
drop policy if exists "inspections_insert" on public.inspections;
create policy "inspections_insert" on public.inspections
  for insert with check (public.can_access_property(property_id));
drop policy if exists "inspections_update" on public.inspections;
create policy "inspections_update" on public.inspections
  for update using (public.can_access_property(property_id))
  with check (public.can_access_property(property_id));
grant select, insert, update on public.inspections to authenticated;

-- Client-side uploads (photos + PDF) run under the user's own session, so
-- storage.objects needs an INSERT policy. Only the property-scoped prefix, only
-- properties the user can access. Reads already covered by 20240042.
drop policy if exists "auth upload property docs" on storage.objects;
create policy "auth upload property docs"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'p'
    and public.can_access_property( nullif(split_part(name, '/', 2), '')::uuid )
  );

notify pgrst, 'reload schema';

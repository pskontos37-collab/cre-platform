-- 20240064_pipeline_om_storage.sql
-- Storage policies for uploaded Offering Memoranda in the deal pipeline.
--
-- A pipeline OM has NO property yet, so it can't live under the p/<property_id>/
-- prefix that the existing documents-bucket policies gate on (20240042 read,
-- inspections insert). These OMs are filed under a `pipeline/` prefix and
-- restricted to admin / asset_manager (deal + capital data) via is_admin_or_am().
--
-- The frontend uploads client-side (user session), then calls om-extract which
-- reads the PDF back with the service role. Both an INSERT and a SELECT policy
-- are needed: INSERT for the upload, SELECT so signed URLs work for viewing.

drop policy if exists "am insert pipeline om" on storage.objects;
create policy "am insert pipeline om"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'pipeline'
    and public.is_admin_or_am()
  );

drop policy if exists "am read pipeline om" on storage.objects;
create policy "am read pipeline om"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'pipeline'
    and public.is_admin_or_am()
  );

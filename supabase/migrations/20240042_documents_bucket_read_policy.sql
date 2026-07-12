-- ============================================================
-- Storage read policy for the private "documents" bucket.
--
-- Server-side callers (doc-search / doc-ask / lease-abstract edge functions)
-- sign object URLs with the service role, so they bypass storage RLS. The
-- Financials "Recent Documents" panel signs client-side with the user's own
-- session, which had NO storage.objects policy => every createSignedUrl failed
-- and no View links rendered.
--
-- This grants authenticated users read access to a documents-bucket object only
-- when they can access the owning property, extracted from the object key
-- (keys are "p/<property_id>/<file>.pdf"). It mirrors the documents-table RLS
-- exactly (can_access_property), so it broadens nothing beyond a user's existing
-- per-property entitlements — admins/asset managers see all via that helper.
-- ============================================================

drop policy if exists "auth read documents bucket" on storage.objects;
create policy "auth read documents bucket"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'p'
    and public.can_access_property( nullif(split_part(name, '/', 2), '')::uuid )
  );

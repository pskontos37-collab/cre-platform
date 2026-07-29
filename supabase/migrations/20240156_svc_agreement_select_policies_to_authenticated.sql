-- 20240156_svc_agreement_select_policies_to_authenticated.sql
-- The READ leg of a defect whose WRITE leg was found and repaired twice.
--
-- public.service_agreement_vendors and public.generated_service_agreements were
-- created (20240076 / 20240075) with SELECT policies written as
--     for select using (true)
-- with NO `to` clause. A policy with no `to` clause applies to PUBLIC, and PUBLIC
-- includes `anon`. `anon` also still holds the table-level SELECT grant on both:
-- 20240098 revoked only insert/update/delete/truncate from anon, never select.
-- Both creating migrations' own comments say "any active AUTHENTICATED user may
-- read", so authenticated-only was always the intent -- only the implementation
-- was open.
--
-- The write leg of exactly this defect was fixed twice, and the read leg was
-- missed both times:
--   20240098 -- "service_agreement_vendors had an always-true policy, making it
--               anon-writable" -> scoped svc_vendors_insert/update TO authenticated
--   20240124 -- advisor 0024 -> tightened those same two to is_admin_or_am()
-- Neither pass touched svc_vendors_select or gen_svc_agr_select.
--
-- EXPOSURE TODAY: latent, not active. Verified as anon over PostgREST with the
-- shipped anon key: both tables answer HTTP 200 with an empty body -- the request
-- is ALLOWED and RLS is satisfied; the body is empty only because both tables
-- currently hold 0 rows, NOT because anything denied the read. The anon key ships
-- in the browser bundle, so the first saved vendor or generated agreement would
-- become world-readable: vendor name, business, notice address, email, and which
-- property each agreement was issued against.
--
-- ZERO BEHAVIOR CHANGE: the only readers are src/hooks/useServiceAgreementVendors.ts
-- and src/hooks/useGeneratedAgreements.ts, both under an authenticated staff
-- session. No edge function references either table.

-- 1. Re-scope the two SELECT policies to `authenticated`, matching the stated
--    intent and the same shape 20240098 / 20240124 used on the write policies.
--    `using (true)` is preserved deliberately: any staff member may read the
--    shared vendor book and the generated-agreement log.
drop policy if exists svc_vendors_select on public.service_agreement_vendors;
create policy svc_vendors_select on public.service_agreement_vendors
  for select to authenticated using (true);

drop policy if exists gen_svc_agr_select on public.generated_service_agreements;
create policy gen_svc_agr_select on public.generated_service_agreements
  for select to authenticated using (true);

-- 2. Defense in depth: drop the vestigial anon SELECT grant on these two tables,
--    so an always-true policy can never again be the only thing between the
--    browser-shipped anon key and the rows.
--    Deliberately scoped to these two tables. Revoking anon SELECT across all of
--    public is a larger, separate decision: ~107 tables and 17 views still carry
--    it, every one of them gated by auth.uid()-based RLS (verified -- no
--    anon-readable table has RLS off, and no anon-readable table lacks policies).
revoke select on public.service_agreement_vendors    from anon;
revoke select on public.generated_service_agreements from anon;

notify pgrst, 'reload schema';

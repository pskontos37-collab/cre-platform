-- 20240124_rpc_grant_tightening.sql
-- Advisor-driven hardening (2026-07-22 fresh get_advisors run), three parts.
--
-- 1. service_agreement_vendors: INSERT (with check true) and UPDATE (using true)
--    were open to ANY authenticated user (advisor 0024). Tighten to is_admin_or_am(),
--    matching the existing DELETE policy. Zero behavior change today: every
--    operator is admin/asset_manager (PMs hold no entitlements).
--
-- 2. Ten SECURITY DEFINER functions are service-role plumbing (edge fns, loaders,
--    pg_cron) but were executable by authenticated (advisor 0029) because the
--    postgres default ACL auto-grants EXECUTE to anon/authenticated/service_role
--    on every new function — so even migrations that revoked public/anon (e.g.
--    20240119/20240121) left the authenticated grant standing. Frontend-called
--    RPCs (assignable_users, close_pipeline_deal, co_tenancy_risk, create_move_task,
--    resolve_service_agreement, revert_stale_mri_recon, sync_co_tenancy_flags,
--    termination_risk) KEEP authenticated on purpose.
--
-- 3. Root cause: tighten the postgres-role DEFAULT privileges so future functions
--    are not born anon/authenticated-executable (new frontend RPCs must grant
--    authenticated explicitly — already the documented convention in CLAUDE.md),
--    and future sequences drop the anon grant. Verified live: NO security-definer
--    function is currently anon-executable; this closes the class going forward.
--    (supabase_admin's own default ACL is platform-managed and not alterable here.)

-- ── 1. vendor directory write policies ───────────────────────────────────────
drop policy if exists svc_vendors_insert on public.service_agreement_vendors;
create policy svc_vendors_insert on public.service_agreement_vendors
  for insert to authenticated with check (public.is_admin_or_am());

drop policy if exists svc_vendors_update on public.service_agreement_vendors;
create policy svc_vendors_update on public.service_agreement_vendors
  for update to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── 2. service-role-only RPCs: drop the authenticated (and any anon) grant ───
revoke execute on function public.insert_text_chunks(jsonb)                          from anon, authenticated;
revoke execute on function public.generate_critical_events_for_lease(uuid)           from anon, authenticated;
revoke execute on function public.generate_critical_events_for_loan(uuid)            from anon, authenticated;
revoke execute on function public.generate_critical_events_for_mgmt_agreement(uuid)  from anon, authenticated;
revoke execute on function public.generate_construction_critical_events(uuid)        from anon, authenticated;
revoke execute on function public.generate_termination_window_events(uuid)           from anon, authenticated;
revoke execute on function public.sync_capital_flows_from_gl()                       from anon, authenticated;
revoke execute on function public.sync_lease_critical_dates()                        from anon, authenticated;
revoke execute on function public.roll_recurring_critical_dates()                    from anon, authenticated;
revoke execute on function public.leases_move_events()                               from anon, authenticated;

-- ── 3. default privileges: future objects are not born over-granted ──────────
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, select, update on sequences from anon;

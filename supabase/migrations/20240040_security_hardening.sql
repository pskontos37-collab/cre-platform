-- 20240040_security_hardening.sql
-- Findings from the 2026-07-05 security review (Supabase advisors + code audit).
-- All changes are RLS-neutral for logged-in users: verified the app reads P&L
-- only through the v_gl_pnl_* views (owner views that read the matviews
-- internally), never the matviews directly, so revoking matview grants below
-- does not affect Financials.

-- 1) Materialized views were selectable by anon/authenticated over the REST API
--    (advisor 0016). mv_gl_pnl_monthly / mv_gl_pnl_category expose the full
--    portfolio P&L to an unauthenticated GET /rest/v1/mv_gl_pnl_monthly.
--    Migration 20240025 revoked the *views* from anon but missed the matviews.
--    The app never queries the matviews directly (only via the v_ views), so
--    this is safe.
revoke all on public.mv_gl_pnl_monthly  from anon, authenticated;
revoke all on public.mv_gl_pnl_category from anon, authenticated;

-- 2) SECURITY DEFINER functions with a role-mutable search_path (advisor 0011).
--    A definer function without a pinned search_path can be hijacked via a
--    caller-controlled search_path. 20240024 pinned is_admin / is_admin_or_am
--    but the rest were missed. Pinning is defense-in-depth — no behavior change.
--    DO block so it is robust to exact signatures / overloads.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'can_access_property', 'log_mutation', 'match_document_chunks',
        'account_invoices', 'gl_transactions', 'search_documents_by_title'
      )
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- 3) SECURITY DEFINER helper functions were callable without signing in via
--    /rest/v1/rpc/<fn> (advisor 0028). They all gate on auth.uid() internally,
--    so an anon call just returns false/empty — but there is no reason to
--    expose them to anon at all. Revoke EXECUTE from anon only.
--    NOTE: EXECUTE is intentionally LEFT for `authenticated`. RLS policy
--    evaluation does not require the caller to hold EXECUTE on these helpers,
--    but retaining the authenticated grant guarantees no regression of the kind
--    that took the app dark in 20240024. The advisor's 0029 (authenticated can
--    execute) is accepted: every authenticated user is trusted internal staff.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_admin', 'is_admin_or_am', 'can_access_property', 'handle_new_user', 'log_mutation')
  loop
    execute format('revoke execute on function %s from anon', r.sig);
  end loop;
end $$;

-- Left for a separate, tested change (higher regression risk, needs a design
-- decision — do NOT batch blindly):
--   * advisor 0010 — v_gl_pnl_monthly / v_gl_pnl_category are SECURITY DEFINER
--     views that bypass RLS, so any authenticated user sees all-portfolio P&L.
--     Converting to security_invoker requires gl_entries (and the classifier
--     chain) to carry correct per-property RLS for the authenticated role first.
--   * advisor 0014 — the `vector` extension lives in the public schema.

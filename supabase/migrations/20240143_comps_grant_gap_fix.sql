-- 20240143_comps_grant_gap_fix.sql
-- comps.v_tenant_assumption had no SELECT grant to `authenticated`, so the lookup panel's
-- "Named tenant" mode failed with 42501 permission denied for every real user. Found by
-- re-running the panel's queries under an impersonated authenticated session:
--   set local role authenticated;
--   set local "request.jwt.claims" = '{"sub":"<auth.users.id>","role":"authenticated"}';
-- Every earlier check had run as service_role, which bypasses grants entirely and hid it.
--
-- ROOT CAUSE: `GRANT ... ON ALL TABLES IN SCHEMA` only covers objects that exist at that
-- moment. 20240137 granted everything then-existing to `authenticated`; v_tenant_assumption
-- was created afterwards in 20240139. 20240141's v_market_coverage escaped only because it
-- was granted explicitly. 20240137 set ALTER DEFAULT PRIVILEGES for service_role but never
-- for authenticated -- that omission is the reason a later object could slip through.
--
-- Audit at the time of this fix: 1 of 13 comps objects was wrong; anon could select none.

grant select on comps.v_tenant_assumption to authenticated;

-- the guard: any comps view/table created from here on is readable by authenticated without
-- needing to remember a per-object grant. RLS, not grants, is what gates the rows.
alter default privileges in schema comps grant select on tables to authenticated;

-- keep anon locked out, both now and for future objects (matches 20240098 / 20240120 posture)
revoke all on comps.v_tenant_assumption from anon;
alter default privileges in schema comps revoke all on tables from anon;

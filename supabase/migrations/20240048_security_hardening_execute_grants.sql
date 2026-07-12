-- 20240048_security_hardening_execute_grants.sql
-- Corrects the anon RPC-exposure fix from 20240040_security_hardening.sql.
--
-- That migration did `revoke execute ... from anon`, which is a NO-OP: functions
-- grant EXECUTE to PUBLIC by default and anon inherits it through PUBLIC, so the
-- Supabase advisor 0028 (anon can execute SECURITY DEFINER fn) still fired.
--
-- Correct pattern: revoke from PUBLIC, then re-grant only the roles that need it.
-- Also covers is_asset_manager (added in 20240047) and pins vendor_spend_window.
-- Verified RLS-neutral for logged-in users (full PM + scoped-AM smoke test).

-- RLS-helper definer fns: drop PUBLIC (removes anon) but KEEP authenticated —
-- RLS policy evaluation requires EXECUTE — and service_role. Clears advisor 0028.
-- Advisor 0029 (authenticated can execute) is ACCEPTED: these return only
-- caller-scoped booleans and every signed-in user is trusted internal staff.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_admin','is_admin_or_am','can_access_property','is_asset_manager')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Trigger fns are never called via RPC; triggers fire regardless of caller
-- EXECUTE, so revoke from everyone. Clears BOTH 0028 and 0029 for them.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('handle_new_user','log_mutation')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- 0011: pin search_path on vendor_spend_window (added after the first pass).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'vendor_spend_window'
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

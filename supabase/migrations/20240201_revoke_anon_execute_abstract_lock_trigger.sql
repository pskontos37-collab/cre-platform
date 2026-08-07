-- KI-14. public.enforce_abstract_lock_action() is SECURITY DEFINER and the anon
-- role holds EXECUTE on it, which contradicts the anon posture documented in
-- CLAUDE.md: every RPC is supposed to carry
--   revoke execute ... from public, anon;
-- Measured before writing this: it is the ONLY 1 of 51 public SECURITY DEFINER
-- functions anon can execute. The other 50 are correctly blocked, so this is a
-- single missed revoke rather than a systemic gap.
--
-- Practical risk is very low, and this migration is hygiene rather than an
-- incident response: the function returns `trigger` and takes no arguments, so
-- Postgres refuses to invoke it directly ("trigger functions can only be called
-- as triggers") and PostgREST will not expose it as a callable RPC. There is no
-- working exploit path. It is fixed because a posture that is documented but not
-- enforced stops being trustworthy.
--
-- WHY THIS DOES NOT BREAK THE LOCK TRIGGER: Postgres checks EXECUTE on a trigger
-- function at CREATE TRIGGER time, not on each fire. Once the trigger exists it
-- is invoked by the system, so revoking EXECUTE from public/anon leaves the
-- abstract-lock enforcement working exactly as before. The guard below asserts
-- the trigger is still attached afterwards.

revoke execute on function public.enforce_abstract_lock_action() from public, anon;

do $$
declare
  v_anon_can    boolean;
  v_secdef_open int;
  v_triggers    int;
begin
  -- 1. The specific grant is gone.
  select has_function_privilege('anon', p.oid, 'EXECUTE')
    into v_anon_can
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'enforce_abstract_lock_action';

  if v_anon_can is null then
    raise exception '20240201: enforce_abstract_lock_action() not found - did it get renamed?';
  end if;
  if v_anon_can then
    raise exception '20240201: anon STILL holds EXECUTE after the revoke';
  end if;

  -- 2. Predicted end state: ZERO public SECURITY DEFINER functions executable by
  --    anon (it was exactly 1 before this migration).
  select count(*) into v_secdef_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_secdef_open <> 0 then
    raise exception '20240201: % public SECURITY DEFINER fns are still anon-executable, expected 0',
                    v_secdef_open;
  end if;

  -- 3. The lock enforcement must still be wired up. If this ever reaches 0 the
  --    revoke has cost real protection and must be rolled back.
  select count(*) into v_triggers
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'enforce_abstract_lock_action'
     and not t.tgisinternal;

  if v_triggers = 0 then
    raise exception '20240201: no trigger uses enforce_abstract_lock_action() - lock enforcement lost';
  end if;

  raise notice '20240201 OK: anon EXECUTE revoked; 0 anon-executable SECURITY DEFINER fns; % trigger(s) intact',
               v_triggers;
end $$;

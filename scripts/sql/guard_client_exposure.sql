-- guard_client_exposure.sql
-- Asserts the invariants that keep client roles (anon / authenticated) from
-- reading past RLS in schema public. Returns ONE ROW PER VIOLATION; an empty
-- result set is a pass. Safe to run read-only, in CI or as a periodic query.
--
-- WHY EACH CHECK EXISTS (each corresponds to a defect actually found in this DB):
--   A  A permissive SELECT policy with no `to` clause applies to PUBLIC, which
--      includes anon. Combined with a surviving anon SELECT grant, the table is
--      world-readable. Found on service_agreement_vendors +
--      generated_service_agreements (fixed in 20240156); the write leg of the
--      same defect was fixed in 20240098 and 20240124.
--   B  `create or replace view` SILENTLY DROPS any reloption the new statement
--      does not restate, so security_invoker falls off and the view then runs as
--      its owner -- `postgres`, which has rolbypassrls -- bypassing RLS on the
--      base tables. Happened on the comps schema (20240153 -> repaired 20240154).
--      NOTE: this check looks only at DIRECT base-table dependencies on purpose.
--      Walking transitively through a materialized view produces false positives,
--      because a matview is a snapshot and RLS on its own sources is irrelevant
--      to reads of it. v_gl_pnl_monthly / v_gl_pnl_category are exactly that
--      shape and are correctly NOT flagged: they read matviews and carry their
--      own `where can_access_property(property_id)` predicate.
--   C  A materialized view CANNOT have RLS. If one is granted to a client role,
--      any predicate on a view layered above it is trivially bypassed by reading
--      the matview directly.

-- A. anon-reachable always-true SELECT policies on anon-granted tables
select 'A_anon_readable_always_true_policy' as violation,
       c.relname::text                      as object,
       p.polname::text                      as detail
from pg_policy p
join pg_class c     on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and p.polpermissive
  and p.polcmd in ('r', '*')
  and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'true'
  and (p.polroles = '{0}'::oid[]                                   -- PUBLIC
       or 'anon' = any (select pg_get_userbyid(u) from unnest(p.polroles) u))
  and has_table_privilege('anon', c.oid, 'SELECT')

union all

-- B. client-readable view over an RLS'd base table, missing security_invoker
select 'B_view_missing_security_invoker',
       c.relname::text,
       'owner=' || pg_get_userbyid(c.relowner)
         || ' reloptions=' || coalesce(array_to_string(c.reloptions, ','), '(none)')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'v'
  and (has_table_privilege('anon', c.oid, 'SELECT')
    or has_table_privilege('authenticated', c.oid, 'SELECT'))
  and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker%'
  and exists (
        select 1
        from pg_rewrite r
        join pg_depend d on d.objid = r.oid
             and d.classid    = 'pg_rewrite'::regclass
             and d.refclassid = 'pg_class'::regclass
        join pg_class b on b.oid = d.refobjid
        where r.ev_class = c.oid
          and r.rulename = '_RETURN'
          and b.oid <> c.oid
          and b.relkind in ('r', 'p')      -- DIRECT base tables only; see note C above
          and b.relrowsecurity
      )

union all

-- C. materialized view granted to a client role (matviews cannot carry RLS)
select 'C_matview_granted_to_client_role',
       c.relname::text,
       'anon=' || has_table_privilege('anon', c.oid, 'SELECT')::text
         || ' authenticated=' || has_table_privilege('authenticated', c.oid, 'SELECT')::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'm'
  and (has_table_privilege('anon', c.oid, 'SELECT')
    or has_table_privilege('authenticated', c.oid, 'SELECT'))

union all

-- D. anon-granted base table with RLS off, or on but with no policy at all
select 'D_anon_readable_rls_gap',
       c.relname::text,
       case when not c.relrowsecurity then 'RLS DISABLED'
            else 'RLS on but ZERO policies' end
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and has_table_privilege('anon', c.oid, 'SELECT')
  and (not c.relrowsecurity
       or not exists (select 1 from pg_policy p where p.polrelid = c.oid))

order by 1, 2;

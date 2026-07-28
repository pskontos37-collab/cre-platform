-- 20240142_pcf_grid_function
-- (Renumbered twice: the comps session applied 20240141_comps_lookup_api, and before that
--  20240137/139/140. The applied number always wins.)
-- Replace the v_pcf_grid VIEW with a set-returning FUNCTION, because the view was
-- unusable in the app.
--
-- WHAT HAPPENED: the /pcf page 500'd on its first live test. `v_pcf_grid` filters on
-- version_id, but version_id only exists in the `scope` CTE - so Postgres could not push
-- the property/year predicate down into the GL. The planner therefore SEQ-SCANNED
-- gl_entries (230,398 rows) THREE separate times per call: once for `actuals`, and twice
-- more because v_pcf_line_coverage was referenced twice (in `scope` and again for
-- has_budget_seed). 1,269 ms as service role with everything cached; under
-- security_invoker RLS as an authenticated user it blew the statement timeout
-- (authenticated = 20s, authenticator = 8s) and PostgREST returned 500.
--
-- WHY A FUNCTION FIXES IT: the version row is read FIRST, so property_id and fiscal_year
-- are concrete values before the GL is touched. Every gl_entries access then uses
-- idx_gl_prop_acct_period instead of a sequential scan, and coverage is computed ONCE
-- with both sides pre-scoped to the property before the full join.
--
-- MEASURED on the real Gateway FY2026 version (1,020 rows both ways, identical output):
--   view     1,269 ms  - 3x Seq Scan on gl_entries (230,398 rows each)
--   function   139 ms  - Index Scan on idx_gl_prop_acct_period
-- 9.2x faster, and it removes the timeout cliff rather than moving it.
--
-- security_invoker is the DEFAULT for functions and is kept deliberately: RLS must still
-- apply per property. It is now cheap because RLS is evaluated over one property's rows
-- instead of the whole GL.

create or replace function public.pcf_grid(p_version_id uuid)
returns table (
  version_id        uuid,
  property_id       uuid,
  fiscal_year       integer,
  line_key          text,
  section           text,
  subsection        text,
  label             text,
  sort_order        integer,
  is_non_cash       boolean,
  period_month      integer,
  is_actual         boolean,
  amount            numeric,
  method            text,
  note              text,
  derived_from_year integer,
  has_budget_seed   boolean
)
language sql
stable
set search_path = public
as $$
  with v as (
    select pv.id, pv.property_id, pv.fiscal_year, pv.as_of_month
    from public.pcf_versions pv
    where pv.id = p_version_id
  ),
  -- coverage, computed ONCE and pre-scoped to this property on BOTH sides so the full
  -- join never sees the whole portfolio
  gl as (
    select distinct g.line_key
    from public.v_pcf_gl_lines g, v
    where g.property_id = v.property_id
  ),
  bud as (
    select distinct b.line_key
    from public.v_pcf_budget_lines b, v
    where b.property_id = v.property_id
  ),
  cov as (
    select coalesce(gl.line_key, bud.line_key) as line_key,
           (bud.line_key is not null)          as has_budget_seed
    from gl
    full join bud on bud.line_key = gl.line_key
  ),
  actuals as (
    select g.line_key, g.period_month, sum(g.amount) as amount
    from public.v_pcf_gl_lines g, v
    where g.property_id = v.property_id
      and g.period_year = v.fiscal_year
    group by g.line_key, g.period_month
  ),
  months as (select generate_series(1, 12) as period_month)
  select v.id,
         v.property_id,
         v.fiscal_year,
         cov.line_key,
         pl.section,
         pl.subsection,
         pl.label,
         pl.sort_order,
         pl.is_non_cash,
         m.period_month,
         (m.period_month <= v.as_of_month) as is_actual,
         -- an unset forward cell stays NULL, never 0: a silent zero in the bridge is how
         -- a cash flow quietly stops tying
         case when m.period_month <= v.as_of_month then a.amount else f.amount end,
         case when m.period_month <= v.as_of_month then 'actual' else f.method end,
         f.note,
         f.derived_from_year,
         cov.has_budget_seed
  from v
  cross join cov
  cross join months m
  join public.pcf_lines pl on pl.line_key = cov.line_key
  left join actuals a
    on a.line_key = cov.line_key and a.period_month = m.period_month
  left join public.pcf_forecast_cells f
    on f.version_id = v.id and f.line_key = cov.line_key and f.period_month = m.period_month
  where pl.section <> 'cash';
$$;

comment on function public.pcf_grid(uuid) is
  'Resolved PCF grid for one version: line x month with the actual/forecast boundary applied. Replaces v_pcf_grid, which seq-scanned gl_entries 3x and timed out under RLS. Unset forward cells return NULL, never 0.';

-- Anon-lockdown posture (migs 20240093/95/98): revoking from anon alone is not enough,
-- the default PUBLIC grant has to go too.
revoke execute on function public.pcf_grid(uuid) from public, anon;
grant  execute on function public.pcf_grid(uuid) to authenticated, service_role;

-- v_pcf_grid is left in place on purpose: it is the readable reference definition and is
-- still fine for service-role/analytical use. The app must call pcf_grid() instead.
comment on view public.v_pcf_grid is
  'Reference definition only. Do NOT call from the app - it cannot push the version filter into the GL and times out under RLS. Use pcf_grid(version_id) (mig 20240142).';

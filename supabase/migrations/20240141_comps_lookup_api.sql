-- 20240141_comps_lookup_api.sql
-- Query surface for the underwriting lookup panel. Three objects, all SECURITY INVOKER so
-- comps RLS still applies to the calling user.
--
-- Why RPCs rather than letting the panel filter comps.v_assumption_rollup directly: that
-- view is grouped BY MARKET, so an "all markets" answer would require the client to combine
-- per-market medians -- and a median of medians is not a median. These functions aggregate
-- the underlying rows once, server-side, so every figure the panel shows is a real
-- percentile over real observations.
--
-- Every function groups by UNIT. Leasing commissions genuinely arrive as both percent-of-
-- rent and dollars-PSF, so a single "leasing commission" number would be meaningless.

create or replace view comps.v_market_coverage with (security_invoker = true) as
select market,
       count(distinct property)  as n_properties,
       count(*)                  as n_cells,
       min(model_date)           as earliest,
       max(model_date)           as latest
from comps.v_assumption
group by market;
comment on view comps.v_market_coverage is 'Markets that actually have clean comps, for the lookup panel selector.';

-- p_* nulls mean "no filter". p_tenant restricts to one named tenant.
create or replace function comps.lookup_assumptions(
  p_market text default null,
  p_scope  text default null,
  p_tier   text default null,
  p_asset  text default null,
  p_tenant text default null
) returns table (
  metric text, metric_label text, unit text, sort_order int,
  n bigint, n_properties bigint,
  p25 numeric, median numeric, p75 numeric,
  min_value numeric, max_value numeric,
  earliest date, latest date
)
language sql stable as $fn$
  select v.metric,
         max(m.label),
         v.unit,
         max(m.sort_order),
         count(*),
         count(distinct v.property),
         percentile_cont(0.25) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.50) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.75) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         min(coalesce(v.num_value, v.num_new, v.num_min))::numeric,
         max(coalesce(v.num_value, v.num_new, v.num_max))::numeric,
         min(v.model_date),
         max(v.model_date)
  from comps.v_assumption v
  join comps.metric m on m.key = v.metric
  where v.value_kind in ('scalar', 'new_renew_pair', 'range')
    and (p_market is null or v.market      = p_market)
    and (p_scope  is null or v.scope_kind  = p_scope)
    and (p_tier   is null or v.trust_tier  = p_tier)
    and (p_asset  is null or v.asset_class = p_asset)
    and (p_tenant is null or coalesce(v.tenant_name, v.scope_display_name, v.scope_label) = p_tenant)
  group by v.metric, v.unit
  having count(*) > 0
  order by max(m.sort_order), v.unit
$fn$;
comment on function comps.lookup_assumptions is
  'Percentile rollup for the underwriting lookup. Aggregates raw rows server-side so "all markets" is a true percentile, not a median of medians. Always grouped by unit.';

create or replace function comps.lookup_tenants(
  p_query  text default null,
  p_market text default null,
  p_limit  int  default 40
) returns table (
  tenant text, tenant_id uuid,
  obs bigint, med_rent_psf numeric,
  n_properties bigint, n_markets bigint,
  earliest date, latest date, in_tenant_master boolean
)
language sql stable as $fn$
  select t.tenant,
         -- no max(uuid) in Postgres; take any non-null id for the group
         (array_agg(distinct t.tenant_id) filter (where t.tenant_id is not null))[1],
         count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf'),
         (percentile_cont(0.5) within group (
            order by case when t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf'
                          then t.num_value end))::numeric,
         count(distinct t.property),
         count(distinct t.market),
         min(t.model_date),
         max(t.model_date),
         bool_or(t.tenant_id is not null)
  from comps.v_tenant_assumption t
  where (p_query  is null or p_query = '' or t.tenant ilike '%' || p_query || '%')
    and (p_market is null or t.market = p_market)
  group by t.tenant
  having count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') > 0
  order by count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') desc,
           t.tenant
  limit greatest(1, least(coalesce(p_limit, 40), 200))
$fn$;
comment on function comps.lookup_tenants is
  'Tenant search for the lookup panel. Only scope_kind=tenant rows, so space categories and broker columns cannot appear as retailers.';

grant execute on function comps.lookup_assumptions(text, text, text, text, text) to authenticated;
grant execute on function comps.lookup_tenants(text, text, int) to authenticated;
grant select on comps.v_market_coverage to authenticated;
revoke all on comps.v_market_coverage from anon;
revoke execute on function comps.lookup_assumptions(text, text, text, text, text) from anon;
revoke execute on function comps.lookup_tenants(text, text, int) from anon;

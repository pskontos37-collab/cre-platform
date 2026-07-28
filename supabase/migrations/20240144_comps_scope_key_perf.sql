-- 20240144_comps_scope_key_perf.sql
-- The tenant drill-down (comps.lookup_assumptions with p_tenant) exceeded the 20s
-- `authenticated` statement_timeout, failing with:
--   57014 canceling statement due to statement timeout
--   CONTEXT: SQL function "is_admin_or_am" statement 1
-- That is the panel's Named tenant -> search -> click a retailer path. The search LIST was
-- fine (565 ms); only the drill-down died. service_role has NO statement_timeout, which is
-- why every earlier check of mine passed.
--
-- ROOT CAUSE (two compounding design errors of mine in 20240137/20240141):
--   1. comps.v_assumption joined comps.scope_label_map on a COMPUTED expression --
--      trim(lower(regexp_replace(scope_label, ...))) -- so that join could NEVER use an
--      index and re-ran the regexp for every candidate row.
--   2. lookup_assumptions filtered on coalesce(tenant_name, scope_display_name, scope_label),
--      which cannot be pushed down because both LEFT JOINs must resolve first. So it
--      Seq Scanned ~12,989 assumption rows and, per row, probed scope_label_map (regexp) and
--      tenants -- whose RLS policy carries a `leases` SubPlan plus can_access_property().
--      Under RLS every probe re-entered is_admin_or_am().
--
-- FIX: store the normalized key ON the row and index it, then resolve p_tenant ONCE into an
-- indexed key array + tenant_id instead of comparing a post-join expression per row.
--
-- The quarantine gate stays exactly where it was: lookup_assumptions still reads
-- comps.v_assumption, which filters is_quarantined. This migration deliberately does NOT
-- bypass the view for speed -- that would duplicate the one safety property the schema has.

-- ---------------------------------------------------------------------------
-- 1. the stored, indexable normalized key
--    comps.norm_label is IMMUTABLE, so it is legal in a generated column.
-- ---------------------------------------------------------------------------
alter table comps.assumption
  add column if not exists scope_key text
    generated always as (comps.norm_label(scope_label)) stored;

comment on column comps.assumption.scope_key is
  'Stored comps.norm_label(scope_label). Exists so the scope_label_map join and the tenant drill-down filter can use an index -- computing this in the join made the drill-down exceed the 20s authenticated statement timeout.';

create index if not exists assumption_scope_key_idx on comps.assumption (scope_key);

-- ---------------------------------------------------------------------------
-- 2. v_assumption: index-friendly join, and expose scope_key so callers can
--    filter on an indexed column. Existing columns keep name/type/position, so
--    CREATE OR REPLACE is legal and the dependent views are unaffected.
-- ---------------------------------------------------------------------------
create or replace view comps.v_assumption with (security_invoker = true) as
select
  a.id                    as assumption_id,
  sp.market,
  sp.folder_name          as property,
  sp.asset_class,
  sp.property_id,
  sp.pipeline_deal_id,
  sd.model_date,
  sd.date_source,
  sd.doc_kind,
  sd.file_name,
  sd.document_id,
  coalesce(a.trust_tier, aset.trust_tier) as trust_tier,
  aset.validation,
  aset.scope_axis,
  a.metric,
  m.label                 as metric_label,
  a.scope_kind,
  a.scope_label,
  a.tenant_id,
  a.raw_value,
  a.value_kind,
  a.unit,
  a.recurrence,
  a.num_value,
  a.num_new,
  a.num_renew,
  a.num_min,
  a.num_max,
  a.at_year,
  a.vocab_value,
  aset.trust_tier         as set_trust_tier,
  t.name                  as tenant_name,
  slm.display_name        as scope_display_name,
  slm.match_method        as scope_match_method,
  a.scope_key                                          -- appended by 20240144
from comps.assumption a
join comps.assumption_set aset on aset.id = a.assumption_set_id
join comps.source_document sd  on sd.id  = aset.source_document_id
join comps.source_property sp  on sp.id  = sd.source_property_id
join comps.metric m            on m.key  = a.metric
left join public.tenants t     on t.id   = a.tenant_id
left join comps.scope_label_map slm on slm.label_key = a.scope_key   -- was a per-row regexp
where aset.is_quarantined = false;

comment on view comps.v_assumption is
  'The only view application code should read for comp values. Excludes quarantined sets. trust_tier is the EFFECTIVE tier (column overrides tab). Joins scope_label_map on the STORED scope_key -- never recompute that key in a join.';

-- ---------------------------------------------------------------------------
-- 3. lookup_assumptions: resolve p_tenant once, then filter indexed columns
-- ---------------------------------------------------------------------------
create or replace function comps.lookup_assumptions(
  p_market text default null, p_scope text default null, p_tier text default null,
  p_asset text default null, p_tenant text default null
) returns table (
  metric text, metric_label text, unit text, sort_order int,
  n bigint, n_properties bigint,
  p25 numeric, median numeric, p75 numeric,
  min_value numeric, max_value numeric,
  earliest date, latest date
)
language sql stable as $fn$
  -- One resolution pass instead of a per-row post-join comparison. The panel passes the
  -- DISPLAY name from lookup_tenants, which may be the owned-portfolio master spelling
  -- ("Starbuck's") while the corpus rows say "Starbucks" -- hence both routes: the
  -- scope_label_map display_name -> label_key set, the direct normalization of the input,
  -- and the tenants id.
  with res as (
    select
      case when p_tenant is null then null
           else coalesce((select array_agg(distinct label_key)
                          from comps.scope_label_map where display_name = p_tenant), '{}'::text[])
                || array[comps.norm_label(p_tenant)]
      end as keys,
      case when p_tenant is null then null
           else (select id from public.tenants where name = p_tenant limit 1)
      end as tid
  )
  select v.metric, max(m.label), v.unit, max(m.sort_order),
         count(*), count(distinct v.property),
         percentile_cont(0.25) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.50) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.75) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         min(coalesce(v.num_value, v.num_new, v.num_min))::numeric,
         max(coalesce(v.num_value, v.num_new, v.num_max))::numeric,
         min(v.model_date), max(v.model_date)
  from comps.v_assumption v
  join comps.metric m on m.key = v.metric
  cross join res r
  where v.value_kind in ('scalar', 'new_renew_pair', 'range')
    and (p_market is null or v.market      = p_market)
    and (p_scope  is null or v.scope_kind  = p_scope)
    and (p_tier   is null or v.trust_tier  = p_tier)
    and (p_asset  is null or v.asset_class = p_asset)
    -- indexed: scope_key is a stored column, tenant_id has its own index
    and (p_tenant is null or v.scope_key = any(r.keys) or v.tenant_id = r.tid)
  group by v.metric, v.unit
  having count(*) > 0
  order by max(m.sort_order), v.unit
$fn$;
comment on function comps.lookup_assumptions is
  'Percentile rollup for the underwriting lookup. Aggregates server-side so "all markets" is a true percentile, not a median of medians. Always grouped by unit. p_tenant is resolved ONCE to an indexed scope_key array + tenant_id -- comparing a post-join coalesce per row blew the 20s authenticated timeout.';

grant execute on function comps.lookup_assumptions(text, text, text, text, text) to authenticated;
revoke execute on function comps.lookup_assumptions(text, text, text, text, text) from anon;

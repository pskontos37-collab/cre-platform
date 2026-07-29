-- 20240153_comps_model_versions.sql
-- Make the comps schema VERSION-AWARE so every CF Model version can load without changing a
-- single number the shipped /pipeline Underwriting panel already shows.
--
-- WHY THIS MUST BE APPLIED BEFORE THE LOAD, NOT AFTER
-- comps.lookup_assumptions aggregates every row of comps.v_assumption with no vintage filter,
-- and today there is exactly ONE source_document per source_property (verified: max documents
-- per property = 1, 1,013 docs / 1,013 properties). Loading all 3,289 model versions would
--   (a) roughly triple every 'n' the panel displays, and
--   (b) re-weight every median toward deals that merely happen to have many saved versions --
--       Indiana|11100 USA Pkwy alone holds 56 distinct model dates, so it would carry 56x the
--       weight of a deal underwritten once.
-- That is a silent regression to a click-tested feature. So the default answer is pinned to the
-- latest version per property HERE, first. Against today's data this migration is a no-op by
-- construction (with one document per property every row is version_rank = 1) -- which is
-- precisely what makes it verifiable before the load rather than discovered after it.
--
-- PURELY ADDITIVE: alters no table, adds no column to a table, drops no data. Views and two
-- function signatures only. Both functions are DROPped and recreated rather than overloaded --
-- two functions differing only in arity make a named-argument PostgREST call ambiguous
-- ("function is not unique", learned in 20240145). Every new parameter has a default, so the
-- frontend on master, which sends 6 named args to lookup_assumptions and 4 to lookup_tenants,
-- still resolves unchanged.

-- ---------------------------------------------------------------- 1. version rank
-- Supports the window below and any model_date-ordered scan.
create index if not exists source_document_property_date_idx
  on comps.source_document (source_property_id, model_date desc nulls last);

-- Ranked over the documents that actually CONTRIBUTE clean assumption rows, NOT over all
-- documents. This deliberately reproduces dryrun_argus3's fallback: when the newest model has
-- no 'Argus Assumptions' tab, or its tab is quarantined as copy-forward contamination, the
-- next-newest usable model is what the analyst has been seeing, and it must stay rank 1.
-- Ranking over raw source_document would let a tab-less newest version steal rank 1 and make
-- the property vanish from the default answer entirely -- e.g. Kansas|Hawthorne Plaza, whose
-- 2022-08-18 model has no Argus tab while its 2017-08-14 model parses clean.
--
-- row_number(), not dense_rank(): 88 same-day sibling files are force-loaded to avoid orphaning
-- rows v3 already wrote, and a '_v2'/'_Base Case' saved the same day is ONE underwrite, not two
-- comps. dense_rank() would admit both and double that property's weight. The loser is not
-- lost -- it is still queryable via p_vintage => 'all'.
create or replace view comps.v_document_version as
select
  sd.id                                 as source_document_id,
  sd.source_property_id,
  sd.model_date,
  extract(year from sd.model_date)::int  as vintage_year,
  row_number() over (partition by sd.source_property_id
                     order by sd.model_date desc nulls last, sd.file_name desc) as version_rank,
  count(*)     over (partition by sd.source_property_id)                        as versions_loaded
from comps.source_document sd
where exists (
  select 1
  from comps.assumption_set s
  join comps.assumption a on a.assumption_set_id = s.id
  where s.source_document_id = sd.id
    and s.is_quarantined = false
);
alter view comps.v_document_version set (security_invoker = true);

-- ---------------------------------------------------------------- 2. v_assumption
-- Unchanged except for three APPENDED columns. Existing column names, types and order are
-- preserved so the dependent views keep resolving.
create or replace view comps.v_assumption as
select a.id as assumption_id,
    sp.market,
    sp.folder_name as property,
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
    m.label as metric_label,
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
    aset.trust_tier as set_trust_tier,
    t.name as tenant_name,
    slm.display_name as scope_display_name,
    slm.match_method as scope_match_method,
    a.scope_key,
    dv.version_rank,
    dv.versions_loaded,
    dv.vintage_year
   from comps.assumption a
     join comps.assumption_set aset on aset.id = a.assumption_set_id
     join comps.source_document sd on sd.id = aset.source_document_id
     join comps.source_property sp on sp.id = sd.source_property_id
     join comps.metric m on m.key = a.metric
     -- inner join is safe and intentional: v_document_version admits exactly the documents that
     -- carry a non-quarantined assumption row, which is the same population this view already
     -- filtered to with 'aset.is_quarantined = false'.
     join comps.v_document_version dv on dv.source_document_id = sd.id
     left join tenants t on t.id = a.tenant_id
     left join comps.scope_label_map slm on slm.label_key = a.scope_key
  where aset.is_quarantined = false;

-- ---------------------------------------------------------------- 3. dependent views
-- Tenant rows need the rank so lookup_tenants can apply the same default.
create or replace view comps.v_tenant_assumption as
select coalesce(tenant_name, scope_display_name, scope_label) as tenant,
    tenant_id,
    market,
    property,
    model_date,
    trust_tier,
    metric,
    unit,
    value_kind,
    num_value,
    num_new,
    num_renew,
    num_min,
    num_max,
    vocab_value,
    raw_value,
    document_id,
    version_rank,
    vintage_year
   from comps.v_assumption v
  where scope_kind = 'tenant';

-- The coverage line the panel prints ("103 properties, 5,193 assumptions in Chicago + Illinois")
-- must describe the SAME population the medians are computed from, or the panel would claim a
-- sample three times the size of the one it actually used. Latest-only, therefore -- with the
-- all-vintage totals added alongside so the extra depth is discoverable rather than hidden.
create or replace view comps.v_market_coverage as
select v.market,
    count(distinct v.property) filter (where v.version_rank = 1) as n_properties,
    count(*)                   filter (where v.version_rank = 1) as n_cells,
    min(v.model_date)          filter (where v.version_rank = 1) as earliest,
    max(v.model_date)          filter (where v.version_rank = 1) as latest,
    coalesce(( select array_agg(a.related_market order by a.related_market)
           from comps.market_alias a
          where a.market = v.market), '{}'::text[]) as related_markets,
    count(*)                                as n_cells_all_vintages,
    count(distinct v.file_name)             as n_versions,
    min(v.vintage_year)                     as vintage_earliest,
    max(v.vintage_year)                     as vintage_latest
   from comps.v_assumption v
  group by v.market;

-- Same reasoning: this rollup is documented as the defensible cross-section, so it stays a
-- cross-section of current assumptions. The vintage series gets its own view below.
create or replace view comps.v_assumption_rollup as
 select market,
    asset_class,
    metric,
    scope_kind,
    unit,
    trust_tier,
    count(*) as n,
    count(distinct property) as n_properties,
    min(model_date) as earliest,
    max(model_date) as latest,
    percentile_cont(0.25::double precision) within group (order by (coalesce(num_value, num_new, (num_min + num_max) / 2::numeric)::double precision)) as p25,
    percentile_cont(0.50::double precision) within group (order by (coalesce(num_value, num_new, (num_min + num_max) / 2::numeric)::double precision)) as median,
    percentile_cont(0.75::double precision) within group (order by (coalesce(num_value, num_new, (num_min + num_max) / 2::numeric)::double precision)) as p75,
    min(coalesce(num_value, num_new, num_min)) as min_value,
    max(coalesce(num_value, num_new, num_max)) as max_value
   from comps.v_assumption
  where value_kind = any (array['scalar'::text, 'new_renew_pair'::text, 'range'::text])
    and version_rank = 1
  group by market, asset_class, metric, scope_kind, unit, trust_tier;

-- ---------------------------------------------------------------- 4. the vintage series
-- THE POINT OF LOADING ALL VERSIONS: how has an assumption MOVED, by vintage year.
-- Reports two estimators on purpose, because they answer different questions and disagree:
--   median            -- over every observation. Correct for "what does a cell typically say",
--                        but a deal re-underwritten 20 times in one year dominates its year.
--   median_by_property-- each property reduced to its own median for that year FIRST, then the
--                        percentile taken across properties. Correct for "what did we typically
--                        assume that year", because one deal then counts once.
-- Both are exposed with n_obs and n_properties beside them so the reader can see which applies;
-- neither is silently substituted for the other.
-- NOT gated to version_rank = 1 -- gating it would defeat its entire purpose.
create or replace view comps.v_assumption_vintage as
with obs as (
  select v.metric, v.unit, v.asset_class, v.scope_kind, v.trust_tier,
         v.vintage_year, v.property,
         coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2) as val
  from comps.v_assumption v
  where v.value_kind in ('scalar','new_renew_pair','range')
    and v.vintage_year is not null
    and v.unit is not null          -- join keys below must not be NULL; scalar/pair/range always carry a unit
),
per_property as (
  select metric, unit, asset_class, scope_kind, trust_tier, vintage_year, property,
         percentile_cont(0.5) within group (order by val) as prop_median
  from obs
  group by metric, unit, asset_class, scope_kind, trust_tier, vintage_year, property
),
prop_roll as (
  select metric, unit, asset_class, scope_kind, trust_tier, vintage_year,
         count(*) as n_properties,
         percentile_cont(0.5) within group (order by prop_median) as median_by_property
  from per_property
  group by metric, unit, asset_class, scope_kind, trust_tier, vintage_year
),
all_roll as (
  select metric, unit, asset_class, scope_kind, trust_tier, vintage_year,
         count(*) as n_obs,
         percentile_cont(0.25) within group (order by val) as p25,
         percentile_cont(0.50) within group (order by val) as median,
         percentile_cont(0.75) within group (order by val) as p75,
         min(val) as min_value,
         max(val) as max_value
  from obs
  group by metric, unit, asset_class, scope_kind, trust_tier, vintage_year
)
select a.metric,
       m.label as metric_label,
       a.unit,
       a.asset_class,
       a.scope_kind,
       a.trust_tier,
       a.vintage_year,
       a.n_obs,
       p.n_properties,
       a.p25::numeric,
       a.median::numeric,
       a.p75::numeric,
       a.min_value::numeric,
       a.max_value::numeric,
       p.median_by_property::numeric,
       m.sort_order
from all_roll a
join prop_roll p using (metric, unit, asset_class, scope_kind, trust_tier, vintage_year)
join comps.metric m on m.key = a.metric;
alter view comps.v_assumption_vintage set (security_invoker = true);

-- ---------------------------------------------------------------- 5. lookup_assumptions
-- Vintage semantics, stated once:
--   p_vintage = 'latest' (DEFAULT) -> the newest usable model per property. Preserves today's
--                                    answer exactly, and is what an analyst pricing a deal now
--                                    should see.
--   p_vintage = 'all'              -> every loaded version.
--   p_year_from / p_year_to        -> IMPLY 'all'. A year filter combined with latest-only would
--                                    return a near-empty set (only properties whose newest model
--                                    happens to fall inside the window), which reads as "we have
--                                    no 2019 comps" when in fact 436 models are loaded for 2019.
drop function if exists comps.lookup_assumptions(text, text, text, text, text, boolean);
create function comps.lookup_assumptions(
  p_market          text    default null,
  p_scope           text    default null,
  p_tier            text    default null,
  p_asset           text    default null,
  p_tenant          text    default null,
  p_include_related boolean default false,
  p_vintage         text    default 'latest',
  p_year_from       int     default null,
  p_year_to         int     default null
) returns table (
  metric text, metric_label text, unit text, sort_order integer,
  n bigint, n_properties bigint, n_vintages bigint,
  p25 numeric, median numeric, p75 numeric,
  min_value numeric, max_value numeric,
  earliest date, latest date
) language sql stable as $function$
  with mkt as (
    select case when p_market is null then null
                when not coalesce(p_include_related, false) then array[p_market]
                else array[p_market] || coalesce(
                       (select array_agg(related_market) from comps.market_alias where market = p_market),
                       '{}'::text[])
           end as markets
  ),
  vin as (
    select case
             when p_year_from is not null or p_year_to is not null then 'all'
             when lower(coalesce(p_vintage, 'latest')) = 'all'    then 'all'
             else 'latest'
           end as mode
  ),
  res as (
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
         count(*), count(distinct v.property), count(distinct v.vintage_year),
         percentile_cont(0.25) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.50) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         percentile_cont(0.75) within group (order by coalesce(v.num_value, v.num_new, (v.num_min + v.num_max) / 2))::numeric,
         min(coalesce(v.num_value, v.num_new, v.num_min))::numeric,
         max(coalesce(v.num_value, v.num_new, v.num_max))::numeric,
         min(v.model_date), max(v.model_date)
  from comps.v_assumption v
  join comps.metric m on m.key = v.metric
  cross join res r
  cross join mkt k
  cross join vin w
  where v.value_kind in ('scalar', 'new_renew_pair', 'range')
    and (k.markets is null or v.market = any(k.markets))
    and (p_scope  is null or v.scope_kind  = p_scope)
    and (p_tier   is null or v.trust_tier  = p_tier)
    and (p_asset  is null or v.asset_class = p_asset)
    and (p_tenant is null or v.scope_key = any(r.keys) or v.tenant_id = r.tid)
    and (w.mode = 'all' or v.version_rank = 1)
    and (p_year_from is null or v.vintage_year >= p_year_from)
    and (p_year_to   is null or v.vintage_year <= p_year_to)
  group by v.metric, v.unit
  having count(*) > 0
  order by max(m.sort_order), v.unit
$function$;

-- ---------------------------------------------------------------- 6. lookup_tenants
drop function if exists comps.lookup_tenants(text, text, integer, boolean);
create function comps.lookup_tenants(
  p_query           text    default null,
  p_market          text    default null,
  p_limit           integer default 40,
  p_include_related boolean default false,
  p_vintage         text    default 'latest',
  p_year_from       int     default null,
  p_year_to         int     default null
) returns table (
  tenant text, tenant_id uuid, obs bigint, med_rent_psf numeric,
  n_properties bigint, n_markets bigint, earliest date, latest date,
  in_tenant_master boolean
) language sql stable as $function$
  with mkt as (
    select case when p_market is null then null
                when not coalesce(p_include_related, false) then array[p_market]
                else array[p_market] || coalesce(
                       (select array_agg(related_market) from comps.market_alias where market = p_market),
                       '{}'::text[])
           end as markets
  ),
  vin as (
    select case
             when p_year_from is not null or p_year_to is not null then 'all'
             when lower(coalesce(p_vintage, 'latest')) = 'all'    then 'all'
             else 'latest'
           end as mode
  )
  select t.tenant,
         (array_agg(distinct t.tenant_id) filter (where t.tenant_id is not null))[1],
         count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf'),
         (percentile_cont(0.5) within group (
            order by case when t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf'
                          then t.num_value end))::numeric,
         count(distinct t.property), count(distinct t.market),
         min(t.model_date), max(t.model_date), bool_or(t.tenant_id is not null)
  from comps.v_tenant_assumption t
  cross join mkt k
  cross join vin w
  where (p_query  is null or p_query = '' or t.tenant ilike '%' || p_query || '%')
    and (k.markets is null or t.market = any(k.markets))
    and (w.mode = 'all' or t.version_rank = 1)
    and (p_year_from is null or t.vintage_year >= p_year_from)
    and (p_year_to   is null or t.vintage_year <= p_year_to)
  group by t.tenant
  having count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') > 0
  order by count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') desc, t.tenant
  limit greatest(1, least(coalesce(p_limit, 40), 200))
$function$;

-- ---------------------------------------------------------------- 7. grants
-- A GRANT ON ALL TABLES only covers objects that exist at that moment -- that omission is what
-- broke Named-tenant mode for every real user until 20240143. The default privilege installed
-- there now covers new views, but the new objects are granted explicitly here too rather than
-- relying on it, and revoked from anon.
grant select on comps.v_document_version   to authenticated;
grant select on comps.v_assumption_vintage to authenticated;
grant select on comps.v_document_version, comps.v_assumption_vintage to service_role;
revoke all on comps.v_document_version   from anon;
revoke all on comps.v_assumption_vintage from anon;
grant execute on function comps.lookup_assumptions(text,text,text,text,text,boolean,text,int,int) to authenticated, service_role;
grant execute on function comps.lookup_tenants(text,text,integer,boolean,text,int,int)            to authenticated, service_role;
revoke all on function comps.lookup_assumptions(text,text,text,text,text,boolean,text,int,int) from anon;
revoke all on function comps.lookup_tenants(text,text,integer,boolean,text,int,int)            from anon;

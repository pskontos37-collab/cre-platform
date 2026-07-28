-- 20240145_comps_market_alias.sql
-- The corpus is filed by K:\ folder, and the firm kept METRO folders alongside STATE folders.
-- So `Chicago` (41 properties / 2,355 assumptions) and `Illinois` (62 / 2,838) are separate
-- markets for the same metro area, and a Chicago deal's auto-matched market silently saw
-- less than half the relevant sample. Measured examples of the same split:
--   Chicago <-> Illinois,  Atlanta <-> Georgia,  Boston <-> Massachusetts,
--   DC <-> Maryland,       DC <-> Virginia
-- (St. Louis has folders but no clean comps, so it is not aliased.)
--
-- DELIBERATELY NOT A SILENT MERGE. Chicago-metro retail and downstate Illinois are genuinely
-- different rent markets; blending them by default would be the same mistake as averaging
-- gross with net. Instead the relationship is DATA, the expansion is OPT-IN per query, and
-- the panel shows the sibling's size so the choice is informed rather than invisible.
--
-- Measured effect on a Chicago deal, space-category / in-house, market_rent:
--   Chicago alone            52 observations across 27 properties
--   Chicago + Illinois      140 observations across 64 properties
--   Chipotle drill-down       0 rows -> 8 rows
--   tenant search list       63 -> 187 tenants

create table if not exists comps.market_alias (
  market         text not null,
  related_market text not null,
  reason         text,
  created_at     timestamptz not null default now(),
  primary key (market, related_market),
  constraint market_alias_not_self check (market <> related_market)
);
comment on table comps.market_alias is
  'Markets that cover overlapping geography because the K: tree keeps a metro folder next to its state folder. Stored in BOTH directions. Expansion is opt-in via lookup_*(p_include_related) -- never automatic, because a metro and its state are not the same rent market.';

create index if not exists market_alias_market_idx on comps.market_alias (market);

alter table comps.market_alias enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='comps' and tablename='market_alias' and policyname='market_alias_select') then
    create policy market_alias_select on comps.market_alias for select to authenticated using (public.is_admin_or_am());
    create policy market_alias_insert on comps.market_alias for insert to authenticated with check (public.is_admin_or_am());
    create policy market_alias_update on comps.market_alias for update to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am());
    create policy market_alias_delete on comps.market_alias for delete to authenticated using (public.is_admin_or_am());
  end if;
end $$;
grant select, insert, update, delete on comps.market_alias to authenticated;
grant all on comps.market_alias to service_role;
revoke all on comps.market_alias from anon;

insert into comps.market_alias (market, related_market, reason) values
  ('Chicago','Illinois','metro folder and its state folder cover the same geography'),
  ('Illinois','Chicago','metro folder and its state folder cover the same geography'),
  ('Atlanta','Georgia','metro folder and its state folder cover the same geography'),
  ('Georgia','Atlanta','metro folder and its state folder cover the same geography'),
  ('Boston','Massachusetts','metro folder and its state folder cover the same geography'),
  ('Massachusetts','Boston','metro folder and its state folder cover the same geography'),
  ('DC','Maryland','DC metro spans the Maryland suburbs'),
  ('Maryland','DC','DC metro spans the Maryland suburbs'),
  ('DC','Virginia','DC metro spans the Northern Virginia suburbs'),
  ('Virginia','DC','DC metro spans the Northern Virginia suburbs')
on conflict (market, related_market) do nothing;

-- ---------------------------------------------------------------------------
-- coverage view gains the sibling list so the panel can size the choice
-- ---------------------------------------------------------------------------
create or replace view comps.v_market_coverage with (security_invoker = true) as
select v.market,
       count(distinct v.property) as n_properties,
       count(*)                   as n_cells,
       min(v.model_date)          as earliest,
       max(v.model_date)          as latest,
       coalesce((select array_agg(a.related_market order by a.related_market)
                 from comps.market_alias a where a.market = v.market), '{}'::text[]) as related_markets
from comps.v_assumption v
group by v.market;
comment on view comps.v_market_coverage is
  'Markets with clean comps, plus any related markets (metro/state overlaps) so the lookup panel can offer an informed opt-in expansion.';

-- ---------------------------------------------------------------------------
-- lookups: opt-in expansion. DROP+CREATE rather than adding an overload --
-- two functions differing only in arity would make a 5-named-arg RPC call
-- ambiguous ("function is not unique"). All new params default, so an
-- older frontend sending the original arg set still resolves.
-- ---------------------------------------------------------------------------
drop function if exists comps.lookup_assumptions(text, text, text, text, text);
create function comps.lookup_assumptions(
  p_market text default null, p_scope text default null, p_tier text default null,
  p_asset text default null, p_tenant text default null,
  p_include_related boolean default false
) returns table (
  metric text, metric_label text, unit text, sort_order int,
  n bigint, n_properties bigint,
  p25 numeric, median numeric, p75 numeric,
  min_value numeric, max_value numeric,
  earliest date, latest date
)
language sql stable as $fn$
  with mkt as (
    select case when p_market is null then null
                when not coalesce(p_include_related, false) then array[p_market]
                else array[p_market] || coalesce(
                       (select array_agg(related_market) from comps.market_alias where market = p_market),
                       '{}'::text[])
           end as markets
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
  cross join mkt k
  where v.value_kind in ('scalar', 'new_renew_pair', 'range')
    and (k.markets is null or v.market = any(k.markets))
    and (p_scope  is null or v.scope_kind  = p_scope)
    and (p_tier   is null or v.trust_tier  = p_tier)
    and (p_asset  is null or v.asset_class = p_asset)
    and (p_tenant is null or v.scope_key = any(r.keys) or v.tenant_id = r.tid)
  group by v.metric, v.unit
  having count(*) > 0
  order by max(m.sort_order), v.unit
$fn$;
comment on function comps.lookup_assumptions is
  'Percentile rollup for the underwriting lookup. Aggregates server-side so "all markets" is a true percentile, not a median of medians. Always grouped by unit. p_tenant resolves ONCE to an indexed scope_key array + tenant_id. p_include_related expands p_market across comps.market_alias (metro/state overlaps) and is OPT-IN by design.';

drop function if exists comps.lookup_tenants(text, text, int);
create function comps.lookup_tenants(
  p_query text default null, p_market text default null, p_limit int default 40,
  p_include_related boolean default false
) returns table (
  tenant text, tenant_id uuid, obs bigint, med_rent_psf numeric,
  n_properties bigint, n_markets bigint, earliest date, latest date, in_tenant_master boolean
)
language sql stable as $fn$
  with mkt as (
    select case when p_market is null then null
                when not coalesce(p_include_related, false) then array[p_market]
                else array[p_market] || coalesce(
                       (select array_agg(related_market) from comps.market_alias where market = p_market),
                       '{}'::text[])
           end as markets
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
  where (p_query  is null or p_query = '' or t.tenant ilike '%' || p_query || '%')
    and (k.markets is null or t.market = any(k.markets))
  group by t.tenant
  having count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') > 0
  order by count(*) filter (where t.metric = 'market_rent' and t.value_kind = 'scalar' and t.unit = 'usd_psf') desc, t.tenant
  limit greatest(1, least(coalesce(p_limit, 40), 200))
$fn$;
comment on function comps.lookup_tenants is
  'Tenant search for the lookup panel. Only scope_kind=tenant rows. p_include_related expands p_market across comps.market_alias and is OPT-IN.';

grant execute on function comps.lookup_assumptions(text, text, text, text, text, boolean) to authenticated;
grant execute on function comps.lookup_tenants(text, text, int, boolean) to authenticated;
revoke execute on function comps.lookup_assumptions(text, text, text, text, text, boolean) from anon;
revoke execute on function comps.lookup_tenants(text, text, int, boolean) from anon;

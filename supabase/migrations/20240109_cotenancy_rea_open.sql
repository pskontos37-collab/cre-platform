-- 20240109_cotenancy_rea_open.sql
-- Redefine public.co_tenancy_risk() so REA-member anchors are PRESUMED OPEN.
--
-- REA anchors own their parcels and pay us no rent, so the rent roll cannot
-- track them; they are documented operating at the center via periodic
-- co-tenancy certification reports. Previously they landed in an 'unknown'
-- anchor_state that inflated an 'unknown' clause tier and the at-risk list.
-- Now: new anchor_state 'rea_open' (excluded from named_at_risk), the 'unknown'
-- tier is removed, and the former 'anchors_unknown' bucket is renamed
-- 'anchors_unmatched' so it counts ONLY genuine tenant-name mapping misses.
--
-- This carries the working-tree edit to 20240072_lease_rights_radar.sql (an
-- already-applied migration, which cannot be re-run) into a fresh migration.
-- Signature is unchanged, so `create or replace` is a clean in-place redefine.

create or replace function public.co_tenancy_risk()
returns table (
  clause_id           uuid,
  lease_id            uuid,
  property_id         uuid,
  tenant_name         text,
  tier                text,
  reasons             text[],
  named_at_risk       jsonb,
  occupancy_pct       numeric,
  threshold_pct       numeric,
  exposed_annual_rent numeric
)
language sql
security definer
set search_path = public
as $$
with occ as (
  select u.property_id,
         round(100.0 * sum(u.rentable_sf) filter (where exists (
           select 1 from leases l where l.unit_id = u.id and l.status = 'active'
         )) / nullif(sum(u.rentable_sf), 0), 1) as occupancy_pct
  from units u
  group by u.property_id
),
cur_rent as (
  select distinct on (rs.lease_id) rs.lease_id, rs.annual_rent
  from lease_rent_schedule rs
  where rs.effective_date <= current_date
  order by rs.lease_id, rs.effective_date desc
),
anchor as (
  select nt.clause_id, nt.tenant_label, nt.is_rea_member, nt.tenant_id,
         al.id as anchor_lease_id, al.expiration_date as anchor_exp,
         ao.is_exercised as opt_exercised, ao.notice_deadline as opt_notice_deadline,
         exists (
           select 1 from documents d
           where d.tenant_id = nt.tenant_id
             and d.file_mtime >= (current_date - interval '18 months')
             and (d.file_name ~* 'LSE (Ext|Renewal|Extension)|Renewal Option|Exercise|Extension Option|Extend LSE')
         ) as newer_notice_doc,
         case
           -- REA anchors own their parcels and pay us no rent, so the rent roll can't
           -- track them - but they are documented operating at the center (periodic
           -- co-tenancy certification reports). PRESUME OPEN absent closure evidence.
           when nt.is_rea_member then 'rea_open'
           when nt.tenant_id is null then 'unmatched'
           when al.id is null then 'gone'
           when al.expiration_date <= current_date + interval '12 months'
                and coalesce(ao.is_exercised, false) = false then 'expiring_12mo'
           when ao.notice_deadline is not null
                and ao.notice_deadline <= current_date + interval '90 days'
                and coalesce(ao.is_exercised, false) = false then 'notice_90d'
           when al.expiration_date <= current_date + interval '24 months'
                and coalesce(ao.is_exercised, false) = false then 'expiring_24mo'
           else 'ok'
         end as anchor_state
  from co_tenancy_named_tenants nt
  left join lateral (
    select l2.id, l2.expiration_date
    from leases l2
    join co_tenancy_clauses c2 on c2.id = nt.clause_id
    join leases pl on pl.id = c2.lease_id
    where l2.tenant_id = nt.tenant_id and l2.status = 'active'
      and l2.property_id = pl.property_id
    order by l2.expiration_date desc limit 1
  ) al on true
  left join lateral (
    select o.is_exercised, o.notice_deadline
    from lease_options o
    where o.lease_id = al.id and o.option_type = 'renewal'
    order by o.is_exercised asc limit 1
  ) ao on true
),
per_clause as (
  -- house convention stores percentages as decimals (0.65 = 65%); occupancy_pct here
  -- is on the 0-100 scale for display, so normalize the threshold to match
  select c.id as clause_id, c.lease_id, l.property_id,
         coalesce(t.trade_name, t.name) as tenant_name,
         (c.occupancy_threshold_pct * 100) as occupancy_threshold_pct, o.occupancy_pct, cr.annual_rent,
         c.min_named_open, c.condition_logic,
         count(a.clause_id) filter (where a.anchor_state = 'gone')            as anchors_gone,
         count(a.clause_id) filter (where a.anchor_state in ('expiring_12mo','notice_90d')
                                      and not a.newer_notice_doc)             as anchors_high,
         count(a.clause_id) filter (where a.anchor_state in ('expiring_12mo','notice_90d')
                                      and a.newer_notice_doc)                 as anchors_stale,
         count(a.clause_id) filter (where a.anchor_state = 'expiring_24mo')   as anchors_watch,
         count(a.clause_id) filter (where a.anchor_state = 'unmatched')       as anchors_unmatched,
         count(a.clause_id)                                                   as anchors_total,
         coalesce(jsonb_agg(jsonb_build_object(
             'label', a.tenant_label, 'state', a.anchor_state,
             'expiration', a.anchor_exp, 'notice_deadline', a.opt_notice_deadline,
             'is_rea_member', a.is_rea_member, 'newer_notice_doc', a.newer_notice_doc
           ) order by a.tenant_label)
           filter (where a.anchor_state not in ('ok','rea_open')), '[]'::jsonb) as named_at_risk
  from co_tenancy_clauses c
  join leases l on l.id = c.lease_id and l.status = 'active'
  join tenants t on t.id = l.tenant_id
  left join occ o on o.property_id = l.property_id
  left join cur_rent cr on cr.lease_id = c.lease_id
  left join anchor a on a.clause_id = c.id
  group by c.id, c.lease_id, l.property_id, t.trade_name, t.name,
           c.occupancy_threshold_pct, o.occupancy_pct, cr.annual_rent,
           c.min_named_open, c.condition_logic
),
scored as (
  select pc.*,
         -- named test: clause needs min_named_open (default: ALL named) open.
         -- unknown/unmatched anchors count as open (REA anchors presumed operating)
         -- to avoid false alarms; they surface separately as monitor-manually.
         (pc.anchors_total - pc.anchors_gone) as named_open,
         coalesce(pc.min_named_open, pc.anchors_total) as named_required,
         (pc.anchors_total > 0
          and (pc.anchors_total - pc.anchors_gone) < coalesce(pc.min_named_open, pc.anchors_total)) as named_fail,
         (pc.occupancy_threshold_pct is not null and pc.occupancy_pct is not null
          and pc.occupancy_pct < pc.occupancy_threshold_pct) as occ_fail
  from per_clause pc
)
select
  s.clause_id, s.lease_id, s.property_id, s.tenant_name,
  case
    -- clause FAILS today: 'and' logic = both tests must pass (either failing trips it);
    -- 'or' = satisfied if either passes (both must fail to trip)
    when case when s.condition_logic = 'or' then (s.named_fail and s.occ_fail)
              else (s.named_fail or s.occ_fail) end                          then 'triggered'
    when s.anchors_stale > 0                                                 then 'stale_data'
    -- anchors gone but clause still satisfied: cushion eroded
    when s.anchors_gone > 0                                                  then 'high'
    when s.anchors_high > 0
      or (s.occupancy_threshold_pct is not null and s.occupancy_pct is not null
          and s.occupancy_pct < s.occupancy_threshold_pct + 2)               then 'high'
    when s.anchors_watch > 0
      or (s.occupancy_threshold_pct is not null and s.occupancy_pct is not null
          and s.occupancy_pct < s.occupancy_threshold_pct + 5)               then 'watch'
    else 'ok'
  end as tier,
  array_remove(array[
    case when s.named_fail
         then 'named-anchor test FAILING: ' || s.named_open || ' of ' || s.anchors_total ||
              ' named open, clause requires ' || s.named_required end,
    case when s.occ_fail
         then 'occupancy ' || s.occupancy_pct || '% below ' || s.occupancy_threshold_pct || '% threshold' end,
    case when s.named_fail and not s.occ_fail and s.condition_logic = 'or'
         then 'clause survives on occupancy leg (or-logic) - named leg failing' end,
    case when s.anchors_gone > 0 and not s.named_fail
         then s.anchors_gone || ' named anchor(s) gone - clause still satisfied (' ||
              s.named_open || ' open of ' || s.named_required || ' required) but cushion eroded' end,
    case when s.anchors_stale > 0 then 'anchor looks at-risk but a newer notice doc exists - reconcile option data' end,
    case when s.anchors_high > 0 then s.anchors_high || ' anchor(s) expiring <=12mo or notice <=90d, unexercised' end,
    case when s.occupancy_threshold_pct is not null and s.occupancy_pct is not null
              and s.occupancy_pct >= s.occupancy_threshold_pct
              and s.occupancy_pct < s.occupancy_threshold_pct + 5
         then 'occupancy ' || s.occupancy_pct || '% within 5pts of ' || s.occupancy_threshold_pct || '% threshold' end,
    case when s.anchors_watch > 0 then s.anchors_watch || ' anchor(s) expiring 12-24mo, unexercised' end,
    case when s.anchors_unmatched > 0
         then s.anchors_unmatched || ' named anchor(s) not matched by name - verify tenant-name mapping' end
  ], null) as reasons,
  s.named_at_risk,
  s.occupancy_pct,
  s.occupancy_threshold_pct as threshold_pct,
  s.annual_rent as exposed_annual_rent
from scored s
where can_access_property(s.property_id)
$$;

-- Conform to the anon-role lockdown posture (CLAUDE.md): SECURITY DEFINER RPCs
-- grant EXECUTE only to authenticated staff + service_role, never public/anon.
revoke execute on function public.co_tenancy_risk() from public, anon;
grant  execute on function public.co_tenancy_risk() to authenticated, service_role;

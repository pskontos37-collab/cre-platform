-- 20240072_lease_rights_radar.sql
-- Co-Tenancy Risk Radar + Termination Rights Radar (spec: docs/COTENANCY-RISK-RADAR-SPEC.md).
-- 1) co_tenancy_clauses v2: real clauses are compound ("2 of [four anchors] AND 65% occupancy")
--    with stacked remedies - the original single named_tenant_id / single remedy can't hold them.
-- 2) co_tenancy_named_tenants: junction for the named-anchor lists (incl. non-tenant REA anchors).
-- 3) termination_rights: tenant-held early-termination rights - sales kickouts, fixed windows,
--    and ongoing terminate-on-notice rights (surfaced regardless of how far out expiration is).
-- 4) co_tenancy_risk() / termination_risk(): live risk RPCs (no cron, never stale).
-- 5) sync_co_tenancy_flags(): auto-creates pending_review flags for currently-failing clauses.

-- ── 1) co_tenancy_clauses v2 ────────────────────────────────────────────────────
alter table co_tenancy_clauses
  add column if not exists min_named_open     integer,
  add column if not exists occupancy_basis    text,             -- 'total_gla' | 'ground_floor' | 'shops_excl_anchors' | free text
  add column if not exists condition_logic    text not null default 'and',  -- how named + occupancy combine: 'and' | 'or'
  add column if not exists conditions         jsonb,            -- non-computable nuances (exclusions, SF floors, cure detail)
  add column if not exists remedies           jsonb,            -- ordered remedy ladder [{type, rent_pct|desc, after_days}]
  add column if not exists verbatim_language  text,
  add column if not exists source_abstract_id uuid references lease_abstracts(id) on delete set null,
  add column if not exists extraction         jsonb,            -- raw model output for audit
  add column if not exists human_verified     boolean not null default false;

-- ── 2) named-anchor junction ────────────────────────────────────────────────────
create table if not exists co_tenancy_named_tenants (
  id            uuid primary key default uuid_generate_v4(),
  clause_id     uuid not null references co_tenancy_clauses(id) on delete cascade,
  tenant_id     uuid references tenants(id) on delete set null, -- null when the anchor is not our tenant
  tenant_label  text not null,                                  -- as written in the lease ("Kohl's", "Target")
  is_rea_member boolean not null default false,                 -- REA anchors: operating status not derivable from rent roll
  created_at    timestamptz not null default now()
);
create index if not exists idx_ctnt_clause on co_tenancy_named_tenants (clause_id);

alter table co_tenancy_named_tenants enable row level security;
drop policy if exists "co_tenancy_named_tenants_select" on co_tenancy_named_tenants;
create policy "co_tenancy_named_tenants_select" on co_tenancy_named_tenants for select using (
  exists (
    select 1 from public.co_tenancy_clauses c
    join public.leases l on l.id = c.lease_id
    where c.id = clause_id and public.can_access_property(l.property_id)
  )
);

-- ── 3) termination rights (kickouts / windows / ongoing notice rights) ──────────
create table if not exists termination_rights (
  id                 uuid primary key default uuid_generate_v4(),
  lease_id           uuid not null references leases(id) on delete cascade,
  property_id        uuid not null references properties(id) on delete cascade,
  right_type         text not null check (right_type in
                       ('sales_kickout','fixed_window','ongoing_notice','cotenancy_termination','other')),
  sales_threshold    numeric,        -- kickout: gross-sales floor for the measuring period
  measure_period     text,           -- e.g. 'lease year 5', 'any trailing 12 months'
  recurring          boolean not null default false, -- kickout test repeats (any/each lease year) vs one-time;
                                     -- one-time kickouts get window_end computed at load and LAPSE after it
  window_start       date,           -- fixed_window: right exercisable from
  window_end         date,           -- fixed_window: right lapses after
  exercisable_from   date,           -- ongoing_notice: earliest exercise date (null = already open)
  notice_days        integer,
  termination_fee    text,           -- often formulaic (unamortized TI/commissions) - keep as text
  details            text,           -- plain-language summary
  verbatim_language  text,
  source_abstract_id uuid references lease_abstracts(id) on delete set null,
  extraction         jsonb,
  human_verified     boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_term_rights_lease on termination_rights (lease_id);
create index if not exists idx_term_rights_prop  on termination_rights (property_id);

alter table termination_rights enable row level security;
drop policy if exists "termination_rights_select" on termination_rights;
create policy "termination_rights_select" on termination_rights for select
  using (public.can_access_property(property_id));

-- ── auto-flag dedup: at most one pending flag per clause ───────────────────────
create unique index if not exists co_tenancy_flags_one_pending
  on co_tenancy_flags (co_tenancy_clause_id) where status = 'pending_review';

-- ── 4a) co-tenancy risk RPC ─────────────────────────────────────────────────────
-- Tiers: triggered > stale_data > high > watch > unknown > ok.
-- stale_data guard (spec section 4.5): an anchor looks expiring/unexercised in the
-- structured data BUT a recent notice-looking document is linked to that tenant -
-- report "data stale, reconcile" instead of a false alarm.
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
           when nt.is_rea_member then 'unknown'
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
         count(a.clause_id) filter (where a.anchor_state in ('unknown','unmatched')) as anchors_unknown,
         count(a.clause_id)                                                   as anchors_total,
         coalesce(jsonb_agg(jsonb_build_object(
             'label', a.tenant_label, 'state', a.anchor_state,
             'expiration', a.anchor_exp, 'notice_deadline', a.opt_notice_deadline,
             'is_rea_member', a.is_rea_member, 'newer_notice_doc', a.newer_notice_doc
           ) order by a.tenant_label)
           filter (where a.anchor_state <> 'ok'), '[]'::jsonb)                as named_at_risk
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
    when s.anchors_unknown > 0 and s.anchors_unknown = s.anchors_total       then 'unknown'
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
    case when s.anchors_unknown > 0 then s.anchors_unknown || ' anchor(s) not derivable (REA member / unmatched) - monitor manually' end
  ], null) as reasons,
  s.named_at_risk,
  s.occupancy_pct,
  s.occupancy_threshold_pct as threshold_pct,
  s.annual_rent as exposed_annual_rent
from scored s
where can_access_property(s.property_id)
$$;

-- ── 4b) termination-rights risk RPC ─────────────────────────────────────────────
-- sales_kickout: TTM sales (pct_rent_records, window anchored on the latest reported
-- month) vs threshold. ongoing_notice rights are ALWAYS surfaced while open - a tenant
-- who can terminate on notice today is live exposure regardless of stated expiration.
create or replace function public.termination_risk()
returns table (
  right_id            uuid,
  lease_id            uuid,
  property_id         uuid,
  tenant_name         text,
  right_type          text,
  tier                text,
  reasons             text[],
  ttm_sales           numeric,
  sales_threshold     numeric,
  notice_days         integer,
  window_start        date,
  window_end          date,
  lease_expiration    date,
  exposed_annual_rent numeric,
  details             text
)
language sql
security definer
set search_path = public
as $$
with latest_month as (
  select max(period_year * 12 + (period_month - 1)) as mk
  from pct_rent_records where period_month is not null
),
ttm as (
  select r.lease_id, sum(r.reported_sales) as ttm_sales
  from pct_rent_records r, latest_month lm
  where r.period_month is not null
    and (r.period_year * 12 + (r.period_month - 1)) > lm.mk - 12
    and (r.period_year * 12 + (r.period_month - 1)) <= lm.mk
  group by r.lease_id
),
cur_rent as (
  select distinct on (rs.lease_id) rs.lease_id, rs.annual_rent
  from lease_rent_schedule rs
  where rs.effective_date <= current_date
  order by rs.lease_id, rs.effective_date desc
)
select
  tr.id as right_id, tr.lease_id, tr.property_id,
  coalesce(t.trade_name, t.name) as tenant_name,
  tr.right_type,
  case
    -- ANY kickout with a passed exercise window is a dead right, recurring or not
    -- (a "any 12-month period prior to month 60" test is recurring but bounded)
    when tr.right_type = 'sales_kickout'
         and tr.window_end is not null and tr.window_end < current_date           then 'lapsed'
    -- one-time kickout that we could not date: report for manual dating, never alarm
    when tr.right_type = 'sales_kickout' and not tr.recurring
         and tr.window_end is null                                                then 'unknown'
    -- one-time kickout whose measuring period is still ahead: early warning only
    when tr.right_type = 'sales_kickout' and not tr.recurring
         and tr.window_start is not null and tr.window_start > current_date
         and tr.sales_threshold is not null and s.ttm_sales is not null
         and s.ttm_sales < tr.sales_threshold                                     then 'watch'
    when tr.right_type = 'sales_kickout' and tr.sales_threshold is not null and s.ttm_sales is not null
         and s.ttm_sales < tr.sales_threshold                                     then 'triggered'
    when tr.right_type = 'sales_kickout' and tr.sales_threshold is not null and s.ttm_sales is not null
         and s.ttm_sales < tr.sales_threshold * 1.10                              then 'high'
    when tr.right_type = 'sales_kickout' and tr.sales_threshold is not null and s.ttm_sales is not null
         and s.ttm_sales < tr.sales_threshold * 1.25                              then 'watch'
    when tr.right_type = 'sales_kickout' and (tr.sales_threshold is null or s.ttm_sales is null)
                                                                                  then 'unknown'
    when tr.right_type = 'ongoing_notice'
         and (tr.exercisable_from is null or tr.exercisable_from <= current_date) then 'open'
    when tr.right_type = 'ongoing_notice'
         and tr.exercisable_from <= current_date + interval '12 months'           then 'watch'
    when tr.right_type = 'fixed_window'
         and tr.window_start <= current_date
         and (tr.window_end is null or tr.window_end >= current_date)             then 'open'
    when tr.right_type = 'fixed_window'
         and tr.window_start > current_date
         and tr.window_start <= current_date + interval '12 months'               then 'watch'
    when tr.right_type = 'fixed_window'
         and tr.window_end is not null and tr.window_end < current_date           then 'lapsed'
    when tr.right_type in ('cotenancy_termination','other')                       then 'informational'
    else 'ok'
  end as tier,
  array_remove(array[
    case when tr.right_type = 'sales_kickout'
              and tr.window_end is not null and tr.window_end < current_date
         then 'kickout lapsed - measuring/exercise period ended ' || tr.window_end end,
    case when tr.right_type = 'sales_kickout' and not tr.recurring and tr.window_end is null
         then 'one-time kickout - measuring period not dated; set window from lease commencement' end,
    case when tr.right_type = 'sales_kickout' and not tr.recurring
              and tr.window_start is not null and tr.window_start > current_date
         then 'measuring period opens ' || tr.window_start || ' - early tracking only' end,
    case when tr.right_type = 'sales_kickout' and tr.sales_threshold is not null and s.ttm_sales is not null
              and not (tr.window_end is not null and tr.window_end < current_date)
         then 'TTM sales $' || to_char(s.ttm_sales, 'FM999,999,999') || ' vs kickout floor $' || to_char(tr.sales_threshold, 'FM999,999,999') end,
    case when tr.right_type = 'sales_kickout' and s.ttm_sales is null
              and (tr.window_end is null or tr.window_end >= current_date)
         then 'no reported sales on file - cannot measure kickout test' end,
    case when tr.right_type = 'ongoing_notice'
              and (tr.exercisable_from is null or tr.exercisable_from <= current_date)
         then 'tenant may terminate now on ' || coalesce(tr.notice_days::text, '?') || ' days notice' end,
    case when tr.right_type = 'fixed_window' and tr.window_start > current_date
         then 'termination window opens ' || tr.window_start end,
    case when tr.right_type = 'fixed_window' and tr.window_start <= current_date
              and (tr.window_end is null or tr.window_end >= current_date)
         then 'termination window OPEN' || coalesce(' until ' || tr.window_end, '') end
  ], null) as reasons,
  s.ttm_sales, tr.sales_threshold, tr.notice_days, tr.window_start, tr.window_end,
  l.expiration_date as lease_expiration,
  cr.annual_rent as exposed_annual_rent,
  tr.details
from termination_rights tr
join leases l on l.id = tr.lease_id and l.status = 'active'
join tenants t on t.id = l.tenant_id
left join ttm s on s.lease_id = tr.lease_id
left join cur_rent cr on cr.lease_id = tr.lease_id
where can_access_property(tr.property_id)
$$;

-- ── 5) auto-flag currently-failing clauses (decision: auto-create ON) ───────────
-- Called by the dashboard widget before it reads co_tenancy_flags. The partial unique
-- index guarantees at most one pending flag per clause; dismissed/confirmed history kept.
create or replace function public.sync_co_tenancy_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  insert into co_tenancy_flags (co_tenancy_clause_id, property_id, trigger_reason, remedy_description, source_document_ids)
  select r.clause_id, r.property_id,
         r.tenant_name || ': ' || array_to_string(r.reasons, '; '),
         (select left(coalesce(c.remedies::text, c.remedy::text), 500) from co_tenancy_clauses c where c.id = r.clause_id),
         null
  from co_tenancy_risk() r
  where r.tier = 'triggered'
    and not exists (
      select 1 from co_tenancy_flags f
      where f.co_tenancy_clause_id = r.clause_id and f.status = 'pending_review'
    )
  on conflict (co_tenancy_clause_id) where status = 'pending_review' do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

grant execute on function public.co_tenancy_risk() to authenticated;
grant execute on function public.termination_risk() to authenticated;
grant execute on function public.sync_co_tenancy_flags() to authenticated;

notify pgrst, 'reload schema';

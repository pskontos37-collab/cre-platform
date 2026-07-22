-- 20240122_property_purge_export.sql
-- PMA compliance machinery: per-property data inventory, EXPORT support, and PURGE
-- (Gateway PMA 2-8-19 s.1.03 termination handover + s.9.03 destroy-or-return of
--  Personal Information; see memory topic project_pma_data_compliance).
--
-- *** NOT APPLIED TO PRODUCTION. Do not apply without explicit user go, and only
-- *** after a rehearsal on a Supabase branch database. The companion scripts
-- *** (scripts/export_property_data.ps1, scripts/purge_property_data.ps1) detect
-- *** whether these functions exist; the purge script is INERT until then.
--
-- Design
-- ------
-- 1. The purge set is computed at RUNTIME as the FK closure of the target
--    properties row: every table reachable via foreign keys from properties
--    (plus "synthetic" edges for property_id/document_id columns that lack FK
--    constraints, e.g. audit_log.property_id). New feature tables are therefore
--    discovered automatically -- nothing is hardcoded.
-- 2. purge_policy assigns each closure table an action:
--      delete   - rows matching the closure predicate are deleted
--      keep     - rows are counted/reported but NEVER deleted (e.g. the firm's
--                 own capital/investor ledgers, audit evidence)
--      nullify  - a single FK column is set NULL where it points into the purge
--                 set (severs links without deleting the row; detail = column)
--    A closure table with NO policy row makes the plan UNCLASSIFIED and
--    property_purge_execute_table() REFUSES to run anything until a human adds
--    a policy row. This is the drift guard for future schema growth.
-- 3. Deletes run child-first (closure depth DESC, orchestrated by the script,
--    with FK-violation retries as a safety net). The properties row itself is
--    never deleted. Storage objects (bucket prefix p/<property_id>/) are
--    removed by the script via the Storage API -- deleting storage.objects rows
--    in SQL would orphan the underlying S3 objects.
-- 4. Every run is recorded in purge_log (dry runs included) -- this doubles as
--    the s.9.03 destruction-evidence trail, so purge_log itself is policy 'keep'.
--
-- Assumptions: every closure table has a uuid primary key named id (house
-- style). The plan output prints each predicate verbatim for human review.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists purge_policy (
  table_name text not null,
  action     text not null check (action in ('delete','keep','nullify')),
  detail     text,             -- nullify: the FK column to null out
  rationale  text,
  created_at timestamptz not null default now()
);
create unique index if not exists purge_policy_uniq
  on purge_policy (table_name, action, coalesce(detail, ''));

create table if not exists purge_log (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null,
  property_name   text,
  mode            text not null check (mode in ('dry_run','execute')),
  run_by          uuid default auth.uid(),
  notes           text,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  table_counts    jsonb,
  storage_summary jsonb
);

alter table purge_policy enable row level security;
alter table purge_log    enable row level security;

drop policy if exists purge_policy_admin on purge_policy;
create policy purge_policy_admin on purge_policy
  for all using (is_admin()) with check (is_admin());

drop policy if exists purge_log_admin on purge_log;
create policy purge_log_admin on purge_log
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on purge_policy to authenticated;
grant select, insert, update        on purge_log    to authenticated;
revoke all on purge_policy from anon;
revoke all on purge_log    from anon;

-- ---------------------------------------------------------------------------
-- Guard: service_role key or an is_admin() user
-- ---------------------------------------------------------------------------

create or replace function _purge_guard()
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true), '') = 'service_role' then
    return;
  end if;
  if is_admin() then
    return;
  end if;
  raise exception 'purge/export functions require service_role or an admin user';
end $$;

-- ---------------------------------------------------------------------------
-- Edge map: real FK constraints + synthetic property_id/document_id edges
-- ---------------------------------------------------------------------------

create or replace function _purge_edges()
returns table(child text, col text, parent text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct con.conrelid::regclass::text,
                  a.attname::text,
                  con.confrelid::regclass::text
  from pg_constraint con
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
  where con.contype = 'f'
    and con.connamespace = 'public'::regnamespace
    and con.conrelid <> con.confrelid
  union
  -- columns named property_id/document_id with no FK constraint (audit_log etc.)
  select c.table_name::text,
         c.column_name::text,
         case c.column_name when 'property_id' then 'properties' else 'documents' end
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = 'public' and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public'
    and c.column_name in ('property_id', 'document_id')
    and c.table_name <> 'properties'
$$;

create or replace function _purge_closure()
returns table(tbl text, depth int)
language sql stable security definer set search_path = public, pg_temp as $$
  with recursive cl as (
    select 'properties'::text as tbl, 0 as depth
    union
    select e.child, cl.depth + 1
    from cl
    join _purge_edges() e on e.parent = cl.tbl
    where cl.depth < 5
  )
  select tbl, min(depth)::int from cl group by 1
$$;

-- ---------------------------------------------------------------------------
-- Predicate generator: SQL row-set for table T belonging to property P
-- (OR across every edge whose parent chain reaches properties; columns marked
--  'nullify' in purge_policy are excluded from their table's delete predicate)
-- ---------------------------------------------------------------------------

create or replace function _purge_predicate(p_tbl text, p_pid uuid, p_path text[] default '{}')
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e record;
  clauses text[] := '{}';
  sub text;
  nullify_cols text[];
begin
  if p_tbl = 'properties' then
    return format('id = %L::uuid', p_pid);
  end if;
  if p_tbl = any (p_path) or coalesce(array_length(p_path, 1), 0) >= 6 then
    return null;
  end if;
  select coalesce(array_agg(detail), '{}') into nullify_cols
  from purge_policy where table_name = p_tbl and action = 'nullify' and detail is not null;

  for e in select distinct col, parent from _purge_edges() where child = p_tbl loop
    continue when e.col = any (nullify_cols);
    if e.parent = 'properties' then
      clauses := clauses || format('%I = %L::uuid', e.col, p_pid);
    else
      sub := _purge_predicate(e.parent, p_pid, p_path || p_tbl);
      if sub is not null then
        clauses := clauses || format('%I in (select id from %I where %s)', e.col, e.parent, sub);
      end if;
    end if;
  end loop;

  if coalesce(array_length(clauses, 1), 0) = 0 then
    return null;
  end if;
  return array_to_string(clauses, ' or ');
end $$;

-- ---------------------------------------------------------------------------
-- Plan / count / execute / orphans / matviews
-- ---------------------------------------------------------------------------

create or replace function property_purge_plan(p_property_id uuid)
returns table(depth int, table_name text, action text, detail text, predicate text, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform _purge_guard();
  return query
  with cl as (select c.tbl, c.depth from _purge_closure() c where c.tbl <> 'properties')
  select cl.depth,
         cl.tbl,
         coalesce(pp.action, 'UNCLASSIFIED'),
         pp.detail,
         case
           when pp.action = 'nullify' then format('update %I set %I = null where <col in purge set>', cl.tbl, pp.detail)
           else _purge_predicate(cl.tbl, p_property_id)
         end,
         case when pp.action is null then 'BLOCKING - add a purge_policy row for this table' else 'ok' end
  from cl
  left join purge_policy pp on pp.table_name = cl.tbl
  order by cl.depth desc, cl.tbl, coalesce(pp.action, '');
end $$;

create or replace function property_purge_count(p_property_id uuid, p_table text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pred text;
  n bigint;
begin
  perform _purge_guard();
  if p_table not in (select tbl from _purge_closure()) then
    raise exception 'table % is not in the purge closure', p_table;
  end if;
  pred := _purge_predicate(p_table, p_property_id);
  if pred is null then
    return 0;
  end if;
  execute format('select count(*) from %I where %s', p_table, pred) into n;
  return n;
end $$;

create or replace function property_purge_execute_table(p_property_id uuid, p_table text, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prop_name text;
  pol record;
  pred text;
  parent_tbl text;
  parent_pred text;
  deleted bigint := 0;
  nulled bigint := 0;
  unclassified int;
begin
  perform _purge_guard();

  select name into prop_name from properties where id = p_property_id;
  if prop_name is null then
    raise exception 'unknown property %', p_property_id;
  end if;
  if p_confirm is distinct from ('PURGE ' || prop_name) then
    raise exception 'confirmation text mismatch: expected exactly ''PURGE %''', prop_name;
  end if;

  -- circuit breaker: refuse to touch ANYTHING while any closure table is unclassified
  select count(*) into unclassified
  from _purge_closure() c
  where c.tbl <> 'properties'
    and not exists (select 1 from purge_policy pp where pp.table_name = c.tbl);
  if unclassified > 0 then
    raise exception '% closure table(s) lack a purge_policy row - run property_purge_plan() and classify them first', unclassified;
  end if;

  for pol in select action, detail from purge_policy where table_name = p_table loop
    if pol.action = 'keep' then
      continue;
    elsif pol.action = 'nullify' then
      select e.parent into parent_tbl from _purge_edges() e where e.child = p_table and e.col = pol.detail limit 1;
      if parent_tbl is null then
        raise exception 'nullify policy on %.% has no FK edge', p_table, pol.detail;
      end if;
      parent_pred := _purge_predicate(parent_tbl, p_property_id);
      if parent_pred is not null then
        execute format('update %I set %I = null where %I in (select id from %I where %s)',
                       p_table, pol.detail, pol.detail, parent_tbl, parent_pred);
        get diagnostics nulled = row_count;
      end if;
    elsif pol.action = 'delete' then
      pred := _purge_predicate(p_table, p_property_id);
      if pred is not null then
        execute format('delete from %I where %s', p_table, pred);
        get diagnostics deleted = row_count;
      end if;
    end if;
  end loop;

  return jsonb_build_object('table', p_table, 'deleted', deleted, 'nulled', nulled);
end $$;

-- Master-table cleanup: tenants rows no longer referenced by ANY child table.
-- (tenants is shared across properties, so rows are only removed once orphaned.)
create or replace function property_purge_orphan_tenants(p_property_id uuid, p_confirm text)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prop_name text;
  e record;
  conds text[] := '{}';
  n bigint;
begin
  perform _purge_guard();
  select name into prop_name from properties where id = p_property_id;
  if p_confirm is distinct from ('PURGE ' || prop_name) then
    raise exception 'confirmation text mismatch: expected exactly ''PURGE %''', prop_name;
  end if;

  for e in
    select distinct con.conrelid::regclass::text as child, a.attname as col
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
    where con.contype = 'f' and con.confrelid = 'public.tenants'::regclass
  loop
    conds := conds || format('not exists (select 1 from %I c where c.%I = t.id)', e.child, e.col);
  end loop;

  if coalesce(array_length(conds, 1), 0) = 0 then
    return 0;
  end if;
  execute 'delete from tenants t where ' || array_to_string(conds, ' and ');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function property_purge_refresh_matviews()
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare msg text := '';
begin
  perform _purge_guard();
  begin
    refresh materialized view mv_gl_pnl_monthly;
    msg := msg || 'mv_gl_pnl_monthly ok; ';
  exception when others then
    msg := msg || 'mv_gl_pnl_monthly FAILED: ' || sqlerrm || '; ';
  end;
  begin
    refresh materialized view mv_gl_pnl_category;
    msg := msg || 'mv_gl_pnl_category ok';
  exception when others then
    msg := msg || 'mv_gl_pnl_category FAILED: ' || sqlerrm;
  end;
  return msg;
end $$;

-- ---------------------------------------------------------------------------
-- Grants (house rule from 20240098: no PUBLIC/anon execute)
-- ---------------------------------------------------------------------------

revoke all on function _purge_guard()                                        from public, anon;
revoke all on function _purge_edges()                                        from public, anon;
revoke all on function _purge_closure()                                      from public, anon;
revoke all on function _purge_predicate(text, uuid, text[])                  from public, anon;
revoke all on function property_purge_plan(uuid)                             from public, anon;
revoke all on function property_purge_count(uuid, text)                      from public, anon;
revoke all on function property_purge_execute_table(uuid, text, text)       from public, anon;
revoke all on function property_purge_orphan_tenants(uuid, text)             from public, anon;
revoke all on function property_purge_refresh_matviews()                     from public, anon;

grant execute on function property_purge_plan(uuid)                          to authenticated, service_role;
grant execute on function property_purge_count(uuid, text)                   to authenticated, service_role;
grant execute on function property_purge_execute_table(uuid, text, text)    to authenticated, service_role;
grant execute on function property_purge_orphan_tenants(uuid, text)          to authenticated, service_role;
grant execute on function property_purge_refresh_matviews()                  to authenticated, service_role;
grant execute on function _purge_guard()                                     to authenticated, service_role;
grant execute on function _purge_edges()                                     to authenticated, service_role;
grant execute on function _purge_closure()                                   to authenticated, service_role;
grant execute on function _purge_predicate(text, uuid, text[])               to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policy seed (classification reviewed 2026-07-21 against the live closure:
-- 100 tables, depths 1-3; 16 global tables stay untouched by construction).
-- KEEP rationale in brief:
--   audit_log / purge_log     - access + destruction evidence (s.9.03 certification)
--   deals + capital domain    - M&J Wilkow's OWN partnership/investor ledgers and
--                               waterfall models, not Owner Project books (PMA 2.07
--                               covers Project records; firm records stay). Revisit
--                               per Owner instruction at actual termination.
--   pipeline_deals (+children kept via parent) - firm acquisition work product;
--                               transaction_id nullified because transactions are purged.
-- ---------------------------------------------------------------------------

insert into purge_policy (table_name, action, detail, rationale) values
  -- evidence / logs
  ('audit_log',                     'keep',    null, 'access-evidence trail; retain for s.9.03 certification'),
  ('purge_log',                     'keep',    null, 'destruction evidence; never self-purge'),
  -- firm-level capital / investor domain (NOT Owner Project books)
  ('deals',                         'keep',    null, 'firm JV/deal models'),
  ('capital_accounts',              'keep',    null, 'firm investor ledger'),
  ('capital_flows',                 'keep',    null, 'firm investor ledger'),
  ('distributions',                 'keep',    null, 'firm investor ledger'),
  ('distribution_line_items',       'keep',    null, 'firm investor ledger'),
  ('preferred_equity_positions',    'keep',    null, 'firm capital structure records'),
  ('entity_investors',              'keep',    null, 'firm capital structure records'),
  ('waterfall_tiers',               'keep',    null, 'firm waterfall models'),
  -- firm acquisition pipeline (sever link to purged transactions, keep rows)
  ('pipeline_deals',                'keep',    null, 'firm acquisition work product'),
  ('pipeline_deals',                'nullify', 'transaction_id', 'transactions are purged; sever FK'),
  -- Project records: delete (predicates computed at runtime)
  ('abstract_item_resolutions',     'delete',  null, null),
  ('abstract_jobs',                 'delete',  null, null),
  ('abstract_refresh_log',          'delete',  null, null),
  ('am_contacts',                   'delete',  null, 'deal-contact rows referencing purged pipeline deals only'),
  ('ar_aging',                      'delete',  null, null),
  ('ar_aging_detail',               'delete',  null, null),
  ('ar_followups',                  'delete',  null, null),
  ('ar_notes',                      'delete',  null, null),
  ('brokerage_agreements',          'delete',  null, null),
  ('budget_lines',                  'delete',  null, null),
  ('cam_reconciliations',           'delete',  null, null),
  ('capital_flow_gl_map',           'delete',  null, 'per-property GL mapping config'),
  ('co_tenancy_clauses',            'delete',  null, null),
  ('co_tenancy_flags',              'delete',  null, null),
  ('co_tenancy_named_tenants',      'delete',  null, null),
  ('coi_certificates',              'delete',  null, null),
  ('coi_coverages',                 'delete',  null, null),
  ('coi_requests',                  'delete',  null, null),
  ('coi_review_queue',              'delete',  null, null),
  ('critical_dates',                'delete',  null, null),
  ('critical_events',               'delete',  null, null),
  ('doc_abstracts',                 'delete',  null, null),
  ('doc_briefs',                    'delete',  null, null),
  ('document_chunks',               'delete',  null, 'verbatim text + embeddings'),
  ('document_relationships',        'delete',  null, null),
  ('documents',                     'delete',  null, 'metadata rows; storage objects removed by script'),
  ('drive_file_catalog',            'delete',  null, null),
  ('emergency_manuals',             'delete',  null, null),
  ('entitlements',                  'delete',  null, null),
  ('financial_periods',             'delete',  null, null),
  ('generated_service_agreements',  'delete',  null, null),
  ('gl_entries',                    'delete',  null, null),
  ('import_jobs',                   'delete',  null, null),
  ('inspections',                   'delete',  null, null),
  ('insurance_requirement_coverages','delete', null, null),
  ('insurance_requirements',        'delete',  null, null),
  ('invoice_distributions',         'delete',  null, null),
  ('invoice_dup_dismissals',        'delete',  null, null),
  ('invoices',                      'delete',  null, null),
  ('lease_abstracts',               'delete',  null, null),
  ('lease_cam_terms',               'delete',  null, null),
  ('lease_options',                 'delete',  null, null),
  ('lease_payments',                'delete',  null, null),
  ('lease_rent_schedule',           'delete',  null, null),
  ('lease_rm_matrix',               'delete',  null, null),
  ('leases',                        'delete',  null, null),
  ('loan_covenant_checks',          'delete',  null, null),
  ('loans',                         'delete',  null, null),
  ('management_agreement_deadlines','delete',  null, null),
  ('management_agreements',         'delete',  null, null),
  ('market_reports',                'delete',  null, null),
  ('monthly_reports',               'delete',  null, null),
  ('mri_recon_status',              'delete',  null, null),
  ('om_intake',                     'delete',  null, 'rows citing purged documents/deals only'),
  ('operating_line_items',          'delete',  null, null),
  ('pct_rent_records',              'delete',  null, null),
  ('pipeline_deal_comments',        'delete',  null, 'rows on purged pipeline deals only'),
  ('pipeline_deal_documents',       'delete',  null, 'rows citing purged documents only'),
  ('pipeline_deal_lps',             'delete',  null, 'rows on purged pipeline deals only'),
  ('ppm_drafts',                    'delete',  null, 'rows on purged pipeline deals only'),
  ('property_exclusives',           'delete',  null, null),
  ('rea_agreements',                'delete',  null, null),
  ('rent_roll_rows',                'delete',  null, null),
  ('rent_roll_snapshots',           'delete',  null, null),
  ('service_agreements',            'delete',  null, null),
  ('site_plan_regions',             'delete',  null, null),
  ('task_checklist_items',          'delete',  null, null),
  ('tasks',                         'delete',  null, null),
  ('tenant_announcement_recipients','delete',  null, null),
  ('tenant_announcements',          'delete',  null, null),
  ('tenant_contacts',               'delete',  null, 'Personal Information under s.9.03'),
  ('termination_rights',            'delete',  null, null),
  ('transaction_documents',         'delete',  null, null),
  ('transaction_figures',           'delete',  null, null),
  ('transaction_properties',        'delete',  null, null),
  ('transactions',                  'delete',  null, 'closed-deal Project records (primary_property_id match)'),
  ('units',                         'delete',  null, null),
  ('work_order_comments',           'delete',  null, null),
  ('work_order_photos',             'delete',  null, null),
  ('work_order_portal_users',       'delete',  null, 'tenant portal logins = Personal Information'),
  ('work_orders',                   'delete',  null, null)
on conflict do nothing;

notify pgrst, 'reload schema';

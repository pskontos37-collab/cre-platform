-- 20240128_mri_staged_import_gl.sql
-- Phase 2: MRI STAGED IMPORT, GL kind. Completes 20240127 (schema was already
-- kind-aware; diff/apply were rentroll-only).
--
-- The GL loader is a FULL-LEDGER replace per property (the monthly MRI export is
-- cumulative), so the reviewable unit is the accounting period, not the tenant
-- row. Diff = account x period net aggregates vs live gl_entries; apply replaces
-- ONLY the periods whose row-level content actually differs (md5 multiset digest
-- per period), which is outcome-identical to the loader's full replace but fits
-- the authenticated statement budget (one month + occasional re-booked opening
-- balances, not ~60k rows). Balance-forward rows carry no period and bucket as
-- (0,0). After apply the P&L matviews are refreshed in the same transaction.

-- ── canonical per-period row digest (staged vs live must build IDENTICAL text) ──
-- Numerics are round(x,2)::text so '3500', '3500.0' and 3500.00 all canonicalize;
-- fields join on chr(31) so field content cannot alias a boundary.

create or replace function public.mri_gl_staged_digests(p_batch uuid)
returns table (py int, pm int, dig text, nrows bigint, net numeric)
language sql stable security definer set search_path = public
as $$
  select py, pm, md5(string_agg(rh, ',' order by rh)) as dig, count(*) as nrows, sum(rnet) as net
  from (
    select coalesce(nullif(payload->>'period_year','')::int, 0)  as py,
           coalesce(nullif(payload->>'period_month','')::int, 0) as pm,
           coalesce(nullif(payload->>'debit','')::numeric, 0)
             - coalesce(nullif(payload->>'credit','')::numeric, 0) as rnet,
           md5(concat_ws(chr(31),
             coalesce(payload->>'entity_code',''),
             coalesce(payload->>'account_code',''),
             coalesce(payload->>'account_name',''),
             coalesce(payload->>'period',''),
             coalesce(payload->>'entry_date',''),
             coalesce(payload->>'source_code',''),
             coalesce(payload->>'reference',''),
             coalesce(payload->>'site_id',''),
             coalesce(payload->>'job_code',''),
             coalesce(payload->>'dept',''),
             coalesce(payload->>'description',''),
             round(coalesce(nullif(payload->>'debit','')::numeric, 0), 2)::text,
             round(coalesce(nullif(payload->>'credit','')::numeric, 0), 2)::text,
             coalesce(round(nullif(payload->>'balance','')::numeric, 2)::text, ''),
             coalesce((payload->>'is_balance_forward')::boolean, false)::text
           )) as rh
    from mri_import_rows where batch_id = p_batch
  ) s
  group by py, pm
$$;

create or replace function public.mri_gl_live_digests(p_property uuid)
returns table (py int, pm int, dig text, nrows bigint, net numeric)
language sql stable security definer set search_path = public
as $$
  select py, pm, md5(string_agg(rh, ',' order by rh)) as dig, count(*) as nrows, sum(rnet) as net
  from (
    select coalesce(period_year, 0)  as py,
           coalesce(period_month, 0) as pm,
           coalesce(debit,0) - coalesce(credit,0) as rnet,
           md5(concat_ws(chr(31),
             coalesce(entity_code,''),
             coalesce(account_code,''),
             coalesce(account_name,''),
             coalesce(period,''),
             coalesce(entry_date::text,''),
             coalesce(source_code,''),
             coalesce(reference,''),
             coalesce(site_id,''),
             coalesce(job_code,''),
             coalesce(dept,''),
             coalesce(description,''),
             round(coalesce(debit,0), 2)::text,
             round(coalesce(credit,0), 2)::text,
             coalesce(round(balance, 2)::text, ''),
             coalesce(is_balance_forward, false)::text
           )) as rh
    from gl_entries where property_id = p_property
  ) s
  group by py, pm
$$;

-- inner helpers: not user-callable (dispatcher runs them as owner)
revoke all on function public.mri_gl_staged_digests(uuid) from public, anon, authenticated;
revoke all on function public.mri_gl_live_digests(uuid)   from public, anon, authenticated;
grant execute on function public.mri_gl_staged_digests(uuid) to service_role;
grant execute on function public.mri_gl_live_digests(uuid)   to service_role;

-- ── matview refresh (durable ops rule: refresh after every GL load) ────────────
create or replace function public.refresh_gl_matviews()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is not null and not is_admin_or_am() then
    raise exception 'not permitted';
  end if;
  refresh materialized view public.mv_gl_pnl_monthly;
  refresh materialized view public.mv_gl_pnl_category;
end $$;

revoke all on function public.refresh_gl_matviews() from public, anon;
grant execute on function public.refresh_gl_matviews() to authenticated, service_role;

-- ── GL diff: account x period nets + digest-level replace preview ──────────────
create or replace function public.mri_import_diff_gl(p_batch uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_b record;
  v_diff jsonb;
begin
  select * into v_b from mri_import_batches where id = p_batch;
  if not found then raise exception 'batch not found'; end if;

  with sd as (select * from mri_gl_staged_digests(p_batch)),
  ld as (select * from mri_gl_live_digests(v_b.property_id)),
  st_acct as (
    select coalesce(nullif(payload->>'period_year','')::int, 0)  as py,
           coalesce(nullif(payload->>'period_month','')::int, 0) as pm,
           coalesce(payload->>'account_code','?') as acct,
           max(coalesce(payload->>'account_name','')) as acct_name,
           sum(coalesce(nullif(payload->>'debit','')::numeric,0)
             - coalesce(nullif(payload->>'credit','')::numeric,0)) as net
    from mri_import_rows where batch_id = p_batch
    group by 1, 2, 3
  ),
  lv_acct as (
    select coalesce(period_year,0) as py, coalesce(period_month,0) as pm,
           coalesce(account_code,'?') as acct,
           max(coalesce(account_name,'')) as acct_name,
           sum(coalesce(debit,0)-coalesce(credit,0)) as net
    from gl_entries where property_id = v_b.property_id
    group by 1, 2, 3
  ),
  keys as (
    select coalesce(s.py, l.py) as py, coalesce(s.pm, l.pm) as pm,
           s.dig as sdig, l.dig as ldig,
           s.nrows as srows, l.nrows as lrows,
           s.net as snet, l.net as lnet
    from sd s full join ld l using (py, pm)
  ),
  acct_changes as (
    select coalesce(s.py, l.py) as py, coalesce(s.pm, l.pm) as pm,
           coalesce(s.acct, l.acct) as acct,
           coalesce(s.acct_name, l.acct_name) as acct_name,
           l.net as old_net, s.net as new_net
    from st_acct s
    full join lv_acct l using (py, pm, acct)
    where round(coalesce(s.net, 0), 2) is distinct from round(coalesce(l.net, 0), 2)
  )
  select jsonb_build_object(
    'gl', true,
    'staged_rows',  (select count(*) from mri_import_rows where batch_id = p_batch),
    'live_rows',    (select count(*) from gl_entries where property_id = v_b.property_id),
    'replaces_existing_period',
                    exists (select 1 from keys where ldig is not null and sdig is not null and sdig is distinct from ldig),
    'periods_to_replace', (select count(*) from keys where sdig is distinct from ldig),
    'unchanged_period_count', (select count(*) from keys where sdig = ldig),
    'new_periods', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'period', case when py = 0 then 'balance-forward' else py || '-' || lpad(pm::text, 2, '0') end,
                 'rows', srows, 'net', round(coalesce(snet,0),2))
               order by py, pm)
        from keys where ldig is null), '[]'::jsonb),
    'removed_periods', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'period', case when py = 0 then 'balance-forward' else py || '-' || lpad(pm::text, 2, '0') end,
                 'rows', lrows, 'net', round(coalesce(lnet,0),2))
               order by py, pm)
        from keys where sdig is null), '[]'::jsonb),
    'changed_periods', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'period', case when k.py = 0 then 'balance-forward' else k.py || '-' || lpad(k.pm::text, 2, '0') end,
                 'old_rows', k.lrows, 'new_rows', k.srows,
                 'old_net', round(coalesce(k.lnet,0),2), 'new_net', round(coalesce(k.snet,0),2),
                 'delta',   round(coalesce(k.snet,0) - coalesce(k.lnet,0),2),
                 'accounts', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                             'account', a.acct, 'name', a.acct_name,
                             'old_net', round(coalesce(a.old_net,0),2),
                             'new_net', round(coalesce(a.new_net,0),2),
                             'delta',   round(coalesce(a.new_net,0) - coalesce(a.old_net,0),2))
                           order by abs(coalesce(a.new_net,0) - coalesce(a.old_net,0)) desc), '[]'::jsonb)
                    from (select * from acct_changes a2
                           where a2.py = k.py and a2.pm = k.pm
                           order by abs(coalesce(a2.new_net,0) - coalesce(a2.old_net,0)) desc
                           limit 40) a))
               order by k.py, k.pm)
        from keys k where k.sdig is not null and k.ldig is not null and k.sdig is distinct from k.ldig), '[]'::jsonb)
  ) into v_diff;

  update mri_import_batches set diff = v_diff where id = p_batch;
  return v_diff;
end $$;

revoke all on function public.mri_import_diff_gl(uuid) from public, anon, authenticated;
grant execute on function public.mri_import_diff_gl(uuid) to service_role;

-- ── dispatcher: mri_import_diff now kind-aware (rentroll body unchanged) ───────
create or replace function public.mri_import_diff(p_batch uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_b record;
  v_latest uuid;
  v_diff jsonb;
  v_same_period int;
begin
  select * into v_b from mri_import_batches where id = p_batch;
  if not found then raise exception 'batch not found'; end if;
  -- service-role callers (loader) have no auth.uid(); humans must be admin/AM
  if auth.uid() is not null and not is_admin_or_am() then
    raise exception 'not permitted';
  end if;

  if v_b.kind = 'gl' then
    return mri_import_diff_gl(p_batch);
  end if;

  select count(*) into v_same_period from rent_roll_snapshots
   where property_id = v_b.property_id and period_year = v_b.period_year and period_month = v_b.period_month;

  select id into v_latest from rent_roll_snapshots
   where property_id = v_b.property_id
   order by period_year desc, period_month desc, created_at desc limit 1;

  with staged as (
    select lower(regexp_replace(coalesce(payload->>'suite','') || '|' || coalesce(payload->>'tenant_name',''), '\s+', '', 'g')) as k,
           payload
    from mri_import_rows where batch_id = p_batch
  ),
  current_rows as (
    select lower(regexp_replace(coalesce(suite,'') || '|' || coalesce(tenant_name,''), '\s+', '', 'g')) as k,
           to_jsonb(r.*) - 'id' - 'snapshot_id' - 'created_at' - 'raw_data' as payload
    from rent_roll_rows r where snapshot_id = v_latest
  ),
  news as (
    select s.payload from staged s left join current_rows c using (k) where c.k is null
  ),
  departed as (
    select c.payload from current_rows c left join staged s using (k) where s.k is null
  ),
  changed as (
    select c.payload as old_payload, s.payload as new_payload,
      (select jsonb_object_agg(f, jsonb_build_object('old', c.payload->f, 'new', s.payload->f))
         from unnest(array['sqft','lease_start','lease_end','monthly_base_rent','annual_base_rent','base_rent_psf','is_occupied']) f
        where coalesce(c.payload->>f,'') is distinct from coalesce(s.payload->>f,'')) as field_changes
    from staged s join current_rows c using (k)
  )
  select jsonb_build_object(
    'replaces_existing_period', v_same_period > 0,
    'compared_to_snapshot', v_latest,
    'new_tenants',    coalesce((select jsonb_agg(payload) from news), '[]'::jsonb),
    'departed',       coalesce((select jsonb_agg(payload) from departed), '[]'::jsonb),
    'changed',        coalesce((select jsonb_agg(jsonb_build_object('tenant', new_payload->>'tenant_name', 'suite', new_payload->>'suite', 'changes', field_changes))
                                 from changed where field_changes is not null), '[]'::jsonb),
    'unchanged_count',(select count(*) from changed where field_changes is null)
  ) into v_diff;

  update mri_import_batches set diff = v_diff where id = p_batch;
  return v_diff;
end $$;

-- ── GL apply: replace ONLY differing periods, then refresh matviews ────────────
create or replace function public.apply_mri_import_gl(p_batch uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_b record;
  v_deleted bigint := 0;
  v_inserted bigint := 0;
  v_periods int := 0;
begin
  -- caller (apply_mri_import) already locked the batch row and checked status
  select * into v_b from mri_import_batches where id = p_batch;
  if not found then raise exception 'batch not found'; end if;

  create temp table _gl_replace_keys on commit drop as
    select coalesce(s.py, l.py) as py, coalesce(s.pm, l.pm) as pm
    from mri_gl_staged_digests(p_batch) s
    full join mri_gl_live_digests(v_b.property_id) l using (py, pm)
    where s.dig is distinct from l.dig;

  select count(*) into v_periods from _gl_replace_keys;

  delete from gl_entries g
   using _gl_replace_keys k
   where g.property_id = v_b.property_id
     and coalesce(g.period_year, 0) = k.py
     and coalesce(g.period_month, 0) = k.pm;
  get diagnostics v_deleted = row_count;

  insert into gl_entries (property_id, entity_code, account_code, account_name, period,
                          period_year, period_month, entry_date, source_code, reference,
                          site_id, job_code, dept, description, debit, credit, balance,
                          is_balance_forward)
  select v_b.property_id,
         payload->>'entity_code', payload->>'account_code', payload->>'account_name', payload->>'period',
         nullif(payload->>'period_year','')::int, nullif(payload->>'period_month','')::int,
         nullif(payload->>'entry_date','')::date, payload->>'source_code', payload->>'reference',
         payload->>'site_id', payload->>'job_code', payload->>'dept', payload->>'description',
         coalesce(nullif(payload->>'debit','')::numeric, 0),
         coalesce(nullif(payload->>'credit','')::numeric, 0),
         nullif(payload->>'balance','')::numeric,
         coalesce((payload->>'is_balance_forward')::boolean, false)
  from mri_import_rows r
  join _gl_replace_keys k
    on coalesce(nullif(r.payload->>'period_year','')::int, 0) = k.py
   and coalesce(nullif(r.payload->>'period_month','')::int, 0) = k.pm
  where r.batch_id = p_batch;
  get diagnostics v_inserted = row_count;

  drop table _gl_replace_keys;

  update mri_import_batches
     set status = 'applied', applied_at = now(), decided_by = auth.uid(), decided_at = now(),
         decision_note = coalesce(p_note, decision_note)
   where id = p_batch;

  -- same transaction: P&L matviews see the new ledger atomically with the apply
  refresh materialized view public.mv_gl_pnl_monthly;
  refresh materialized view public.mv_gl_pnl_category;

  return jsonb_build_object('periods_replaced', v_periods,
                            'rows_deleted', v_deleted,
                            'rows_inserted', v_inserted,
                            'matviews_refreshed', true);
end $$;

revoke all on function public.apply_mri_import_gl(uuid, text) from public, anon, authenticated;
grant execute on function public.apply_mri_import_gl(uuid, text) to service_role;

-- ── dispatcher: apply_mri_import now kind-aware (rentroll body unchanged) ──────
create or replace function public.apply_mri_import(p_batch uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_b record;
  v_sid uuid;
  v_n int;
begin
  if not is_admin_or_am() then raise exception 'not permitted'; end if;
  select * into v_b from mri_import_batches where id = p_batch for update;
  if not found then raise exception 'batch not found'; end if;
  if v_b.status not in ('staged','approved') then raise exception 'batch is %', v_b.status; end if;

  if v_b.kind = 'gl' then
    return apply_mri_import_gl(p_batch, p_note);
  end if;
  if v_b.kind <> 'rentroll' then raise exception 'kind % not yet supported', v_b.kind; end if;

  delete from rent_roll_snapshots
   where property_id = v_b.property_id and period_year = v_b.period_year and period_month = v_b.period_month;

  insert into rent_roll_snapshots (property_id, period_year, period_month, total_sf, leased_sf, vacant_sf,
                                   occupancy_pct, avg_base_rent_psf, total_base_rent, row_count)
  values (v_b.property_id, v_b.period_year, v_b.period_month,
          nullif(v_b.summary->>'total_sf','')::numeric, nullif(v_b.summary->>'leased_sf','')::numeric,
          nullif(v_b.summary->>'vacant_sf','')::numeric, nullif(v_b.summary->>'occupancy_pct','')::numeric,
          nullif(v_b.summary->>'avg_base_rent_psf','')::numeric, nullif(v_b.summary->>'total_base_rent','')::numeric,
          (select count(*) from mri_import_rows where batch_id = p_batch))
  returning id into v_sid;

  insert into rent_roll_rows (snapshot_id, property_id, suite, tenant_name, sqft, lease_start, lease_end,
                              monthly_base_rent, annual_base_rent, base_rent_psf, is_occupied, raw_data)
  select v_sid, v_b.property_id,
         payload->>'suite', payload->>'tenant_name',
         nullif(payload->>'sqft','')::numeric,
         nullif(payload->>'lease_start','')::date, nullif(payload->>'lease_end','')::date,
         nullif(payload->>'monthly_base_rent','')::numeric, nullif(payload->>'annual_base_rent','')::numeric,
         nullif(payload->>'base_rent_psf','')::numeric,
         coalesce((payload->>'is_occupied')::boolean, false),
         payload->'raw_data'
  from mri_import_rows where batch_id = p_batch;
  get diagnostics v_n = row_count;

  update mri_import_batches
     set status = 'applied', applied_at = now(), decided_by = auth.uid(), decided_at = now(),
         decision_note = coalesce(p_note, decision_note)
   where id = p_batch;

  return jsonb_build_object('snapshot_id', v_sid, 'rows_inserted', v_n);
end $$;

-- re-assert grants (create or replace preserves ACLs, but be explicit for new clones)
revoke all on function public.mri_import_diff(uuid) from public, anon;
revoke all on function public.apply_mri_import(uuid, text) from public, anon;
grant execute on function public.mri_import_diff(uuid) to authenticated, service_role;
grant execute on function public.apply_mri_import(uuid, text) to authenticated, service_role;

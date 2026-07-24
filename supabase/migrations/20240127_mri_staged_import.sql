-- 20240127_mri_staged_import.sql
-- Phase 2: MRI STAGED IMPORT. Monthly MRI drops become diff-and-approve instead
-- of trust-and-overwrite. The loader (-Stage) writes a batch + rows here; a
-- reviewer sees the computed diff vs the property's latest snapshot on /imports
-- and approves (atomic apply RPC, preserving the loader's replace-period
-- semantics) or rejects. Schema is kind-aware ('rentroll' now, 'gl' next).

create table if not exists public.mri_import_batches (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('rentroll','gl')),
  property_id   uuid not null references public.properties(id),
  period_year   int  not null,
  period_month  int  not null check (period_month between 1 and 12),
  label         text,
  source_file   text,
  status        text not null default 'staged' check (status in ('staged','approved','rejected','applied')),
  summary       jsonb,          -- loader aggregates (sf / rent sums / row counts)
  diff          jsonb,          -- computed at stage time by mri_import_diff
  created_by    uuid,
  created_at    timestamptz not null default now(),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  applied_at    timestamptz
);

create table if not exists public.mri_import_rows (
  id        uuid primary key default gen_random_uuid(),
  batch_id  uuid not null references public.mri_import_batches(id) on delete cascade,
  row_index int  not null,
  payload   jsonb not null    -- exact rent_roll_rows column payload (minus snapshot_id)
);
create index if not exists mri_import_rows_batch_idx on public.mri_import_rows(batch_id);

alter table public.mri_import_batches enable row level security;
alter table public.mri_import_rows    enable row level security;

create policy mri_import_batches_select on public.mri_import_batches
  for select using (public.can_access_property(property_id));
create policy mri_import_batches_write on public.mri_import_batches
  for all to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am());
create policy mri_import_rows_select on public.mri_import_rows
  for select using (exists (select 1 from public.mri_import_batches b
                            where b.id = batch_id and public.can_access_property(b.property_id)));
create policy mri_import_rows_write on public.mri_import_rows
  for all to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Diff: staged rows vs the property's LATEST applied snapshot ─────────────
-- Natural key = suite + tenant_name (case/space-folded). Classes: new / departed /
-- changed (field-level old→new) / unchanged count, plus a replaces_existing flag
-- when a snapshot for the SAME period already exists (the destructive case).
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

-- ── Apply: atomic, admin-gated; preserves the loader's replace-period semantics ──
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

-- explicit grants (the 20240124 default-ACL hardening means new fns get none)
revoke all on function public.mri_import_diff(uuid) from public, anon;
revoke all on function public.apply_mri_import(uuid, text) from public, anon;
grant execute on function public.mri_import_diff(uuid) to authenticated, service_role;
grant execute on function public.apply_mri_import(uuid, text) to authenticated, service_role;

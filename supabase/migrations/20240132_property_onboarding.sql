-- 20240132_property_onboarding.sql
-- PROPERTY ONBOARDING WIZARD. Turns the script-driven asset-onboarding recipe
-- (create property -> file required docs -> link the file room -> load MRI ->
-- queue abstracts) into a resumable, self-serve flow that keeps the trust-layer
-- discipline: nothing touches live portfolio data until an explicit, named
-- confirmation, and the rent roll lands as a STAGED import (reviewed on
-- /imports) rather than a direct write.
--
-- Onboarding spans days (the PMA arrives today, the appraisal next week, the MRI
-- export next month), so the draft is a real row, not wizard component state.
-- Draft steps are non-destructive:
--   * identity/keywords/file-room path live in this table only
--   * uploaded documents are registered with property_id NULL (the register's
--     existing "deal/unassigned" class) and adopt the property at go-live
--   * the parsed rent roll sits in `rr` jsonb until go-live stages it
--
-- Go-live is one atomic RPC gated on the NEW action verb properties.onboard
-- (Phase 3b), so onboarding can be delegated without granting admin.

create table if not exists public.property_onboarding (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'draft' check (status in ('draft','complete','abandoned')),
  property_id    uuid references public.properties(id) on delete set null,  -- set at go-live
  working_name   text not null default 'Untitled property',
  step           int  not null default 1,
  identity       jsonb not null default '{}'::jsonb,  -- name/asset_type/address/.../portfolio_id
  route_keywords text[] not null default '{}',        -- appended to app_config properties.route_map at go-live
  file_room_path text,                                -- V:\ or K:\ root for the document pipeline
  doc_ids        uuid[] not null default '{}',        -- registered docs awaiting property adoption
  rr             jsonb,                               -- {period_year, period_month, source_file, summary, rows[]}
  notes          text,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists property_onboarding_status_idx on public.property_onboarding (status, updated_at desc);

alter table public.property_onboarding enable row level security;

-- One gate for read and write: holding properties.onboard IS the permission to
-- see and work the onboarding queue (drafts are staging data, not portfolio data).
create policy property_onboarding_all on public.property_onboarding
  for all to authenticated
  using (public.can_do_action('properties.onboard'))
  with check (public.can_do_action('properties.onboard'));

grant select, insert, update, delete on public.property_onboarding to authenticated;  -- policy-gated

insert into public.action_defaults (action, label, description, default_roles) values
('properties.onboard', 'Onboard properties',
 'Create a property through the onboarding wizard: file required documents, link the file room, stage the first MRI load.',
 array['admin','asset_manager'])
on conflict (action) do nothing;

-- ── Go-live: create the asset and adopt everything staged against the draft ────
-- p_confirm_name must match the draft's property name exactly (trimmed): the
-- irreversible step is typed, not clicked past.
create or replace function public.complete_property_onboarding(p_draft uuid, p_confirm_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_d          record;
  v_name       text;
  v_asset      text;
  v_pid        uuid;
  v_batch      uuid;
  v_docs       int := 0;
  v_rows       int := 0;
  v_kw_added   text[] := '{}';
  v_kw         text;
  v_entries    jsonb;
  v_existing   jsonb;
begin
  if not can_do_action('properties.onboard') then
    raise exception 'not permitted (requires properties.onboard)';
  end if;

  select * into v_d from property_onboarding where id = p_draft for update;
  if not found then raise exception 'onboarding draft not found'; end if;
  if v_d.status <> 'draft' then raise exception 'draft is already %', v_d.status; end if;

  v_name  := btrim(coalesce(v_d.identity->>'name', ''));
  v_asset := coalesce(v_d.identity->>'asset_type', '');
  if v_name = '' then raise exception 'property name is required'; end if;
  if btrim(coalesce(p_confirm_name, '')) <> v_name then
    raise exception 'confirmation name does not match the property name';
  end if;
  if v_asset not in ('retail','office','mixed_use') then
    raise exception 'asset_type must be retail, office or mixed_use (got %)', v_asset;
  end if;
  if exists (select 1 from properties where lower(btrim(name)) = lower(v_name)) then
    raise exception 'a property named % already exists', v_name;
  end if;

  insert into properties (
    name, asset_type, portfolio_id, address, city, state, zip,
    total_sf, year_built, acquisition_date, acquisition_price,
    management_company, jv_partner, ownership_type, status, is_pipeline, notes
  ) values (
    v_name,
    v_asset::asset_type,
    nullif(v_d.identity->>'portfolio_id','')::uuid,
    nullif(v_d.identity->>'address',''),
    nullif(v_d.identity->>'city',''),
    nullif(v_d.identity->>'state',''),
    nullif(v_d.identity->>'zip',''),
    nullif(v_d.identity->>'total_sf','')::numeric,
    nullif(v_d.identity->>'year_built','')::int,
    nullif(v_d.identity->>'acquisition_date','')::date,
    nullif(v_d.identity->>'acquisition_price','')::numeric,
    nullif(v_d.identity->>'management_company',''),
    nullif(v_d.identity->>'jv_partner',''),
    coalesce(nullif(v_d.identity->>'ownership_type',''), 'owned'),
    'active',
    false,
    nullif(v_d.notes,'')
  ) returning id into v_pid;

  -- documents staged during the wizard adopt the new property (register keeps
  -- its hash/status; only the ownership pointer changes)
  if array_length(v_d.doc_ids, 1) is not null then
    update documents set property_id = v_pid
     where id = any(v_d.doc_ids) and property_id is null;
    get diagnostics v_docs = row_count;
  end if;

  -- rent roll -> STAGED batch (approve on /imports). A brand-new property has no
  -- prior snapshot, so the diff is every row "new" by construction; we build it
  -- directly instead of calling mri_import_diff (same result, and it keeps this
  -- RPC callable by a non-AM who holds properties.onboard).
  if v_d.rr is not null and jsonb_array_length(coalesce(v_d.rr->'rows','[]'::jsonb)) > 0 then
    if (v_d.rr->>'period_year') is null or (v_d.rr->>'period_month') is null then
      raise exception 'rent roll period (year/month) is required';
    end if;
    insert into mri_import_batches (kind, property_id, period_year, period_month, label, source_file, summary, created_by, diff)
    values ('rentroll', v_pid,
            (v_d.rr->>'period_year')::int, (v_d.rr->>'period_month')::int,
            v_name || ' - onboarding rent roll',
            v_d.rr->>'source_file',
            v_d.rr->'summary',
            auth.uid(),
            jsonb_build_object(
              'replaces_existing_period', false,
              'compared_to_snapshot', null,
              'new_tenants', coalesce(v_d.rr->'rows', '[]'::jsonb),
              'departed', '[]'::jsonb,
              'changed', '[]'::jsonb,
              'unchanged_count', 0))
    returning id into v_batch;

    insert into mri_import_rows (batch_id, row_index, payload)
    select v_batch, ord, elem || jsonb_build_object('property_id', v_pid)
      from jsonb_array_elements(v_d.rr->'rows') with ordinality as t(elem, ord);
    get diagnostics v_rows = row_count;
  end if;

  -- routing keywords: APPEND-ONLY, and only pointing at the property just
  -- created. (Deliberately narrower than config.edit, which stays admin-only —
  -- onboarding may teach the router about its own asset, nothing else.)
  if array_length(v_d.route_keywords, 1) is not null then
    select value into v_existing from app_config where key = 'properties.route_map';
    v_entries := coalesce(v_existing->'entries', '[]'::jsonb);
    foreach v_kw in array v_d.route_keywords loop
      v_kw := lower(btrim(v_kw));
      continue when length(v_kw) < 4;
      continue when exists (
        select 1 from jsonb_array_elements(v_entries) e
         where lower(e->>'kw') = v_kw);
      v_entries := v_entries || jsonb_build_array(
        jsonb_build_object('kw', v_kw, 'property_id', v_pid::text, 'scope', 'all'));
      v_kw_added := v_kw_added || v_kw;
    end loop;
    if array_length(v_kw_added, 1) is not null then
      insert into app_config (key, value, description, updated_by, updated_at)
      values ('properties.route_map',
              jsonb_build_object('entries', v_entries),
              'Keyword -> property routing (coi-extract certificate voting; drive-import folder tokens).',
              auth.uid(), now())
      on conflict (key) do update
        set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    end if;
  end if;

  update property_onboarding
     set status = 'complete', property_id = v_pid, completed_at = now(), updated_at = now()
   where id = p_draft;

  return jsonb_build_object(
    'property_id', v_pid,
    'batch_id', v_batch,
    'rent_roll_rows', v_rows,
    'documents_attached', v_docs,
    'keywords_added', to_jsonb(v_kw_added));
end $$;

revoke all on function public.complete_property_onboarding(uuid, text) from public, anon;
grant execute on function public.complete_property_onboarding(uuid, text) to authenticated, service_role;

comment on table public.property_onboarding is
  'Resumable property-onboarding drafts. Non-destructive until complete_property_onboarding(draft, typed name) creates the asset, adopts staged documents, stages the first rent roll, and teaches the router its keywords. Gated on the properties.onboard action. Migration 20240132.';

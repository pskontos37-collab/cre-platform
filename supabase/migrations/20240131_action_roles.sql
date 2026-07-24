-- 20240131_action_roles.sql
-- PHASE 3b (audit: "action roles"). High-blast-radius verbs become NAMED,
-- per-user-grantable capabilities instead of inferences from the admin/AM/PM
-- role triad. The capability check LAYERS ON TOP of existing scope checks
-- (can_access_property / canWriteProperty) — it never replaces them.
--
-- Resolution order for can_user_do(user, action):
--   inactive user  -> false
--   admin          -> true (root; grants UI manages non-admins)
--   explicit row in user_action_grants -> its allowed flag (grant OR deny)
--   otherwise      -> role member of action_defaults.default_roles
--
-- Seeds reproduce TODAY'S behavior exactly (zero behavior change until an
-- admin flips a default or writes a per-user override):
--   imports.approve               admin+AM        (was is_admin_or_am in apply_mri_import)
--   abstracts.lock                admin+AM        (was lease_abstracts_write policy)
--   comms.send_tenant             admin+AM+PM     (announcement-send: scope check still applies)
--   comms.send_service_agreement  admin+AM+PM     (service-agreement-send: any active staff, review #10)
--   config.edit                   admin           (was app_config_write policy)

-- ── catalog + grants ──────────────────────────────────────────────────────────
create table if not exists public.action_defaults (
  action        text primary key,
  label         text not null,
  description   text,
  default_roles text[] not null default '{}',
  created_at    timestamptz not null default now()
);

create table if not exists public.user_action_grants (
  user_id    uuid not null references public.users(id) on delete cascade,
  action     text not null references public.action_defaults(action) on delete cascade,
  allowed    boolean not null,             -- true = grant, false = explicit deny
  granted_by uuid references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  note       text,
  primary key (user_id, action)
);

alter table public.action_defaults    enable row level security;
alter table public.user_action_grants enable row level security;

-- ── capability resolution ─────────────────────────────────────────────────────
create or replace function public.can_user_do(p_user uuid, p_action text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_role text;
  v_active boolean;
  v_explicit boolean;
begin
  if p_user is null then return false; end if;
  select role::text, is_active into v_role, v_active from users where id = p_user;
  if not found or not coalesce(v_active, false) then return false; end if;
  if v_role = 'admin' then return true; end if;
  select allowed into v_explicit from user_action_grants
   where user_id = p_user and action = p_action;
  if found then return v_explicit; end if;
  return exists (select 1 from action_defaults
                  where action = p_action and v_role = any(default_roles));
end $$;

create or replace function public.can_do_action(p_action text)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.can_user_do(auth.uid(), p_action) $$;

-- effective actions for the grants UI: self, or any user when caller is admin
create or replace function public.effective_actions(p_user uuid default null)
returns table (action text, label text, description text, allowed boolean, source text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_target uuid := coalesce(p_user, auth.uid());
begin
  if v_target is null then raise exception 'no user'; end if;
  if v_target <> auth.uid()
     and not exists (select 1 from users u where u.id = auth.uid() and u.role = 'admin') then
    raise exception 'not permitted';
  end if;
  return query
  select d.action, d.label, d.description,
         can_user_do(v_target, d.action) as allowed,
         case
           when (select u.role from users u where u.id = v_target) = 'admin' then 'admin'
           when g.user_id is not null and g.allowed then 'granted'
           when g.user_id is not null and not g.allowed then 'denied'
           when (select u.role::text from users u where u.id = v_target) = any(d.default_roles) then 'role default'
           else 'no default'
         end as source
  from action_defaults d
  left join user_action_grants g on g.action = d.action and g.user_id = v_target
  order by d.action;
end $$;

revoke all on function public.can_user_do(uuid, text) from public, anon, authenticated;
grant execute on function public.can_user_do(uuid, text) to service_role;
revoke all on function public.can_do_action(text) from public, anon;
grant execute on function public.can_do_action(text) to authenticated, service_role;
revoke all on function public.effective_actions(uuid) from public, anon;
grant execute on function public.effective_actions(uuid) to authenticated, service_role;

-- ── policies (after the functions they reference) ─────────────────────────────
-- everyone reads the catalog (UI renders verbs); config.edit manages defaults
create policy action_defaults_select on public.action_defaults
  for select to authenticated using (true);
create policy action_defaults_write on public.action_defaults
  for all to authenticated
  using (public.can_do_action('config.edit'))
  with check (public.can_do_action('config.edit'));

-- users see their own grants; only admins manage them (grant admin = user mgmt,
-- deliberately tied to the role, not an action, to avoid self-escalation loops)
create policy user_action_grants_select on public.user_action_grants
  for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));
create policy user_action_grants_write on public.user_action_grants
  for all to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

grant select on public.action_defaults to authenticated;
grant insert, update, delete on public.action_defaults to authenticated;      -- policy-gated
grant select, insert, update, delete on public.user_action_grants to authenticated; -- policy-gated

-- ── seeds (defaults = current behavior) ───────────────────────────────────────
insert into public.action_defaults (action, label, description, default_roles) values
('imports.approve',              'Approve MRI imports',      'Apply staged rent-roll/GL batches to live data on /imports.',                    array['admin','asset_manager']),
('abstracts.lock',               'Lock abstracts',           'Set or clear the human-verified lock on lease abstracts.',                      array['admin','asset_manager']),
('comms.send_tenant',            'Send tenant announcements','Email announcements to tenants (property write access still required).',        array['admin','asset_manager','property_manager']),
('comms.send_service_agreement', 'Send service agreements',  'Email generated service agreements for signature.',                             array['admin','asset_manager','property_manager']),
('config.edit',                  'Edit firm settings',       'Write app_config (firm identity, routing maps) and action defaults.',           array['admin'])
on conflict (action) do nothing;

-- ── enforcement: apply_mri_import now requires imports.approve ────────────────
-- (full 20240128 body; ONLY the permission line changes)
create or replace function public.apply_mri_import(p_batch uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_b record;
  v_sid uuid;
  v_n int;
begin
  if not can_do_action('imports.approve') then raise exception 'not permitted (requires imports.approve)'; end if;
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

revoke all on function public.apply_mri_import(uuid, text) from public, anon;
grant execute on function public.apply_mri_import(uuid, text) to authenticated, service_role;

-- ── enforcement: app_config writes now require config.edit ────────────────────
drop policy if exists app_config_write on public.app_config;
create policy app_config_write on public.app_config
  for all to authenticated
  using (public.can_do_action('config.edit'))
  with check (public.can_do_action('config.edit'));

-- ── enforcement: human_verified transitions require abstracts.lock ────────────
-- Service-role writers (verify/regen pipelines, auth.uid() null) are exempt —
-- they never set human_verified ("Verified" is reserved for humans, Phase 0 U1).
create or replace function public.enforce_abstract_lock_action()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.human_verified is distinct from old.human_verified then
    if auth.uid() is not null and not can_do_action('abstracts.lock') then
      raise exception 'locking/unlocking an abstract requires the abstracts.lock action';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists lease_abstracts_lock_gate on public.lease_abstracts;
create trigger lease_abstracts_lock_gate
  before update on public.lease_abstracts
  for each row execute function public.enforce_abstract_lock_action();

comment on table public.action_defaults is
  'Action-role catalog (audit Phase 3b): named verbs with role defaults; per-user overrides in user_action_grants. can_do_action() layers on scope checks. Migration 20240131.';

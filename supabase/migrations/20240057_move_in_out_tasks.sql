-- 20240057_move_in_out_tasks.sql
-- Move-In / Move-Out workflow tasks (Policy Manual 16.5 "Move In Move Out Form").
--
-- When a tenant moves in or moves out, the property manager must work the
-- Move In/Move Out form: keys, utility transfers, municipal-utility balance
-- checks, security-deposit offsets, press release (new tenants), and the
-- online vacancy report (due within 30 days of vacating). This migration makes
-- that a first-class task:
--
--   (a) tasks.source ('manual' | 'move_in' | 'move_out') + tasks.lease_id,
--       with a partial unique index so a lease gets AT MOST ONE auto task per
--       event kind — data reloads can't spam duplicates.
--   (b) create_move_task(...) — one SECURITY DEFINER entry point that builds
--       the task + its checklist, auto-assigns the property's PM, and dedupes.
--       Called by BOTH the leases trigger and the /tasks UI.
--   (c) a trigger on public.leases: new lease commencing (or turning active)
--       within the last 60 days -> move-in task; status flipping from
--       active/pending to terminated/expired -> move-out task. The 60-day
--       recency window keeps bulk historical loads from creating tasks for
--       long-past events, and the trigger NEVER raises — a task failure must
--       not break a lease load.

-- ── (a) Task columns ─────────────────────────────────────────────────────────

alter table public.tasks
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'move_in', 'move_out')),
  add column if not exists lease_id uuid references public.leases(id) on delete set null;

create index if not exists tasks_lease_id_idx on public.tasks (lease_id);

-- One auto task per (lease, event kind). Manual untagged tasks are unaffected.
create unique index if not exists tasks_move_event_uniq
  on public.tasks (lease_id, source)
  where source <> 'manual' and lease_id is not null;

-- ── Helpers ──────────────────────────────────────────────────────────────────

-- The PM responsible for a property: an active property_manager entitled to it
-- directly (scope=property) or via its portfolio. Property-scoped wins.
create or replace function public.property_manager_for(p_property uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select u.id
  from public.users u
  join public.entitlements e on e.user_id = u.id
  where u.role = 'property_manager'
    and u.is_active
    and (
      (e.scope = 'property'  and e.property_id  = p_property)
      or (e.scope = 'portfolio' and e.portfolio_id =
            (select p.portfolio_id from public.properties p where p.id = p_property))
    )
  order by case e.scope when 'property' then 0 else 1 end, u.full_name nulls last
  limit 1
$$;

-- NOTE: revoke-from-public alone is NOT enough — Supabase's default privileges
-- grant EXECUTE to anon/authenticated/service_role directly at CREATE time, so
-- those roles must be revoked explicitly.
revoke all on function public.property_manager_for(uuid) from public;
revoke execute on function public.property_manager_for(uuid) from anon, authenticated;

-- created_by is NOT NULL, but trigger-created tasks have no auth.uid() (lease
-- loads run as the service role). Fall back to an admin, then an AM, then any
-- active user — preferring someone who is NOT the assignee so the assignment
-- badge lights up (tasks_reset_seen marks self-assigned tasks as already seen).
create or replace function public.move_task_fallback_creator(p_not uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.users
  where is_active
  order by
    case role when 'admin' then 0 when 'asset_manager' then 1 else 2 end,
    (id = p_not),          -- false sorts first: prefer someone other than the assignee
    created_at
  limit 1
$$;

revoke all on function public.move_task_fallback_creator(uuid) from public;
revoke execute on function public.move_task_fallback_creator(uuid) from anon, authenticated;

-- ── (b) create_move_task ─────────────────────────────────────────────────────

create or replace function public.create_move_task(
  p_kind        text,                  -- 'move_in' | 'move_out'
  p_property_id uuid,
  p_lease_id    uuid default null,
  p_event_date  date default null,     -- key date / vacate date; defaults to today
  p_assigned_to uuid default null,     -- override; defaults to the property's PM
  p_details     text default null      -- extra context appended to the details
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_event    date := coalesce(p_event_date, current_date);
  v_tenant   text;
  v_unit     text;
  v_lease_no text;
  v_assignee uuid;
  v_creator  uuid;
  v_task     uuid;
  v_title    text;
  v_details  text;
  v_due      date;
  v_items    text[];
  v_i        int;
begin
  if p_kind not in ('move_in', 'move_out') then
    raise exception 'create_move_task: kind must be move_in or move_out, got %', p_kind;
  end if;
  if p_property_id is null then
    raise exception 'create_move_task: property is required';
  end if;

  -- Dedupe: one auto task per lease per event kind.
  if p_lease_id is not null then
    select id into v_task from public.tasks
    where lease_id = p_lease_id and source = p_kind
    limit 1;
    if v_task is not null then
      return v_task;
    end if;
  end if;

  if p_lease_id is not null then
    select t.name, u.unit_number, l.lease_number
      into v_tenant, v_unit, v_lease_no
    from public.leases l
    join public.tenants t on t.id = l.tenant_id
    left join public.units u on u.id = l.unit_id
    where l.id = p_lease_id;
  end if;

  v_title := case when p_kind = 'move_in' then 'Move-in' else 'Move-out' end
             || coalesce(' — ' || v_tenant, '')
             || coalesce(' (Suite ' || v_unit || ')', '');

  -- Move-out carries the hard 30-day vacancy-report deadline; move-in gets 14 days.
  v_due := v_event + case when p_kind = 'move_in' then 14 else 30 end;

  if p_kind = 'move_in' then
    v_details :=
      'Tenant move-in effective ' || to_char(v_event, 'MM/DD/YYYY') || '.'
      || coalesce(' Lease #' || v_lease_no || '.', '')
      || ' Complete the Move In/Move Out form (Policy Manual 16.5 — Opening Notice):'
      || ' make sure utility accounts are transferred into the tenant''s name on the'
      || ' date the key is given, and record all utility account and meter numbers.';
    v_items := array[
      'Record date key given to tenant',
      'Record date tenant opened for business',
      'Transfer all utility accounts into the tenant''s name effective the key date',
      'List all utility account and meter numbers for the store',
      'If this is a new tenant — submit a press release request',
      'Complete and file the Move In/Move Out form (Policy Manual 16.5)'
    ];
  else
    v_details :=
      'Tenant move-out effective ' || to_char(v_event, 'MM/DD/YYYY') || '.'
      || coalesce(' Lease #' || v_lease_no || '.', '')
      || ' Complete the Move In/Move Out form (Policy Manual 16.5 — Closing):'
      || ' for all utilities supplied by municipalities, CALL to verify the tenant'
      || ' does not owe any money — this is a must. The online vacancy report is due'
      || ' within 30 days of vacating.';
    v_items := array[
      'Record date tenant vacated',
      'Confirm key turned in',
      'Decide whether to leave utilities on',
      'Put all services in our name — record the date and list all utility account and meter numbers for the space',
      'Record the reason for vacating',
      'Call each municipal utility to verify the tenant owes no money (record date called, who you spoke with, amount owed)',
      'Apply any amount owed against the security deposit',
      'Note the condition of the space — HVAC, sign still up, etc.',
      'Fill in the online vacancy report (within 30 days of vacating)',
      'Complete and file the Move In/Move Out form (Policy Manual 16.5)'
    ];
  end if;

  if p_details is not null and length(trim(p_details)) > 0 then
    v_details := v_details || E'\n' || trim(p_details);
  end if;

  v_assignee := coalesce(p_assigned_to, public.property_manager_for(p_property_id));
  v_creator  := coalesce(auth.uid(), public.move_task_fallback_creator(v_assignee), v_assignee);
  if v_creator is null then
    raise exception 'create_move_task: no active user available as task creator';
  end if;

  begin
    insert into public.tasks
      (title, details, status, priority, due_date, property_id,
       created_by, assigned_to, source, lease_id)
    values
      (v_title, v_details, 'open',
       case when p_kind = 'move_out' then 'high' else 'normal' end,
       v_due, p_property_id, v_creator, v_assignee, p_kind, p_lease_id)
    returning id into v_task;
  exception when unique_violation then
    -- Raced another writer on tasks_move_event_uniq; the task exists.
    select id into v_task from public.tasks
    where lease_id = p_lease_id and source = p_kind
    limit 1;
    return v_task;
  end;

  for v_i in 1 .. array_length(v_items, 1) loop
    insert into public.task_checklist_items (task_id, label, position)
    values (v_task, v_items[v_i], v_i - 1);
  end loop;

  return v_task;
end;
$$;

revoke all on function public.create_move_task(text, uuid, uuid, date, uuid, text) from public;
revoke execute on function public.create_move_task(text, uuid, uuid, date, uuid, text) from anon;
grant execute on function public.create_move_task(text, uuid, uuid, date, uuid, text) to authenticated;

-- ── (c) Leases trigger ───────────────────────────────────────────────────────

create or replace function public.leases_move_events()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_event date;
begin
  begin
    if tg_op = 'INSERT' then
      -- A lease commencing within the last 60 days (or in the future) is a
      -- live move-in; older commencements are historical backfill — skip.
      if new.status in ('active', 'pending')
         and new.commencement_date is not null
         and new.commencement_date >= current_date - 60 then
        perform public.create_move_task(
          'move_in', new.property_id, new.id, new.commencement_date);
      end if;

    elsif new.status is distinct from old.status then
      -- pending -> active can carry a move-in too (deduped if already created).
      if new.status in ('active', 'pending')
         and old.status not in ('active', 'pending')
         and new.commencement_date is not null
         and new.commencement_date >= current_date - 60 then
        perform public.create_move_task(
          'move_in', new.property_id, new.id, new.commencement_date);
      end if;

      -- active/pending -> terminated/expired = move-out. Recency guard keeps
      -- reconciliation loads from raising tasks for leases that ended long ago.
      if new.status in ('terminated', 'expired')
         and old.status in ('active', 'pending')
         and coalesce(new.expiration_date, current_date) >= current_date - 60 then
        v_event := case
          when new.expiration_date between current_date - 60 and current_date + 30
            then new.expiration_date  -- natural expiry near now: use it as the vacate date
          else current_date           -- early termination / far-off expiry: vacated now
        end;
        perform public.create_move_task(
          'move_out', new.property_id, new.id, v_event);
      end if;
    end if;
  exception when others then
    -- Task creation must never break a lease write (loaders included).
    raise warning 'leases_move_events skipped: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists leases_move_events_trg on public.leases;
create trigger leases_move_events_trg
  after insert or update on public.leases
  for each row execute function public.leases_move_events();

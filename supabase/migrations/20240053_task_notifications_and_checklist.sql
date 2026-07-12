-- 20240053_task_notifications_and_checklist.sql
-- Two follow-ups on the tasks feature (20240052):
--   (a) an "assigned to you" notification badge, and
--   (b) per-task checklists / subtasks.

-- ── (a) Assignment-seen flag ────────────────────────────────────────────────
-- seen_by_assignee is false while a task freshly assigned to someone is still
-- "new" to them; it drives the Tasks nav badge. A trigger keeps it correct no
-- matter which code path writes the row: reset to false whenever assigned_to
-- changes to someone, but a creator assigning to THEMSELVES is already "seen".
alter table public.tasks
  add column if not exists seen_by_assignee boolean not null default false;

create or replace function public.tasks_reset_seen()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.seen_by_assignee := (new.assigned_to is not null and new.assigned_to = new.created_by);
  elsif new.assigned_to is distinct from old.assigned_to then
    new.seen_by_assignee := (new.assigned_to is not null and new.assigned_to = new.created_by);
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_reset_seen_trg on public.tasks;
create trigger tasks_reset_seen_trg
  before insert or update on public.tasks
  for each row execute function public.tasks_reset_seen();

-- Backfill existing rows: treat everything already on the board as "seen" so the
-- badge starts clean (it only lights up for assignments made from here on).
update public.tasks set seen_by_assignee = true where seen_by_assignee = false;

-- ── (b) Checklists / subtasks ───────────────────────────────────────────────
-- A checklist item's visibility mirrors its parent task's. can_access_task is
-- SECURITY DEFINER so the subquery on tasks bypasses RLS — no policy recursion
-- (same pattern as is_admin()/can_access_property).
create or replace function public.can_access_task(p_task uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task
      and (t.created_by = auth.uid() or t.assigned_to = auth.uid() or public.is_admin_or_am())
  );
$$;

grant execute on function public.can_access_task(uuid) to authenticated;

create table if not exists public.task_checklist_items (
  id         uuid primary key default uuid_generate_v4(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  label      text not null,
  is_done    boolean not null default false,
  position   int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists task_checklist_items_task_id_idx
  on public.task_checklist_items (task_id, position);

alter table public.task_checklist_items enable row level security;

create policy "checklist_select" on public.task_checklist_items
  for select using (public.can_access_task(task_id));
create policy "checklist_write" on public.task_checklist_items
  for all using (public.can_access_task(task_id)) with check (public.can_access_task(task_id));

grant select, insert, update, delete on public.task_checklist_items to authenticated;

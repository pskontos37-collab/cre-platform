-- 20240052_tasks.sql
-- Team task / to-do feature. A task is a lightweight work item that a user
-- creates for themselves or assigns to a colleague, optionally tagged to a
-- property so it can be filtered by the dashboard's global View: filter.
--
-- Visibility (RLS): a task is readable by its creator, its assignee, and
-- admins / asset managers (who already have full-portfolio visibility via
-- is_admin_or_am()). This mirrors how the rest of the app scopes data — each
-- person's list stays focused on what's theirs, managers see everything.

create table if not exists public.tasks (
  id           uuid primary key default uuid_generate_v4(),
  title        text not null,
  details      text,
  status       text not null default 'open'    check (status   in ('open', 'in_progress', 'done')),
  priority     text not null default 'normal'  check (priority in ('low', 'normal', 'high')),
  due_date     date,
  property_id  uuid references public.properties(id) on delete set null,
  created_by   uuid not null references public.users(id) on delete cascade,
  assigned_to  uuid references public.users(id) on delete set null,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists tasks_assigned_to_idx on public.tasks (assigned_to);
create index if not exists tasks_created_by_idx  on public.tasks (created_by);
create index if not exists tasks_status_idx      on public.tasks (status);
create index if not exists tasks_due_date_idx    on public.tasks (due_date);
create index if not exists tasks_property_id_idx on public.tasks (property_id);

alter table public.tasks enable row level security;

-- SELECT: creator, assignee, or a manager.
create policy "tasks_select" on public.tasks
  for select using (
    created_by = auth.uid()
    or assigned_to = auth.uid()
    or public.is_admin_or_am()
  );

-- INSERT: any authenticated user, but only as themselves (can't spoof creator).
create policy "tasks_insert" on public.tasks
  for insert with check (created_by = auth.uid());

-- UPDATE: creator, assignee (e.g. to mark it done), or a manager.
create policy "tasks_update" on public.tasks
  for update using (
    created_by = auth.uid()
    or assigned_to = auth.uid()
    or public.is_admin_or_am()
  );

-- DELETE: creator or a manager.
create policy "tasks_delete" on public.tasks
  for delete using (
    created_by = auth.uid()
    or public.is_admin_or_am()
  );

grant select, insert, update, delete on public.tasks to authenticated;

-- Roster for the assignee picker. The users table's RLS only lets a user see
-- their OWN row (users_select_own), so a plain select can't populate an
-- "assign to…" dropdown. This SECURITY DEFINER helper returns just the
-- non-sensitive identity fields for active users, without loosening the table.
create or replace function public.assignable_users()
returns table (id uuid, full_name text, email text, role user_role)
language sql stable security definer
set search_path = public
as $$
  select id, full_name, email, role
  from public.users
  where is_active = true
  order by full_name nulls last, email
$$;

grant execute on function public.assignable_users() to authenticated;

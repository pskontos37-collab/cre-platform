-- 20240024_fix_rls_recursion.sql
-- FIX: 42P17 "infinite recursion detected in policy for relation users".
--
-- Three policies inlined `exists (select 1 from public.users ...)` directly in
-- their USING clause. The one on `users` itself recurses immediately; the ones
-- on `entitlements` and `audit_log` recurse transitively (a SELECT on
-- entitlements OR-evaluates the ALL-command policy, whose users subquery
-- re-triggers users RLS). Because nearly every table's SELECT policy subqueries
-- entitlements (via can_access_property), EVERY authenticated PostgREST request
-- returned 500 — the app UI was completely dark for logged-in users.
--
-- Fix: route the admin check through a SECURITY DEFINER helper (owner bypasses
-- RLS on public.users, breaking the cycle), mirroring is_admin_or_am().

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

-- Pin search_path on the existing helpers too (defense-in-depth; no behavior change).
create or replace function public.is_admin_or_am()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role in ('admin', 'asset_manager') and is_active = true
  );
$$;

drop policy if exists "users_admin_all" on public.users;
create policy "users_admin_all" on public.users
  for all using (public.is_admin());

drop policy if exists "entitlements_write" on public.entitlements;
create policy "entitlements_write" on public.entitlements
  for all using (public.is_admin());

drop policy if exists "audit_log_select" on public.audit_log;
create policy "audit_log_select" on public.audit_log
  for select using (public.is_admin());

-- Follow-up to 20240093: these functions were executable by anon via the
-- default PUBLIC grant, which a revoke from anon alone doesn't remove.
-- Revoke from PUBLIC and re-grant to the roles that actually need them.
revoke execute on function public.assignable_users() from public;
grant execute on function public.assignable_users() to authenticated, service_role;
revoke execute on function public.can_access_task(uuid) from public;
grant execute on function public.can_access_task(uuid) to authenticated, service_role;
revoke execute on function public.can_access_transaction(uuid) from public;
grant execute on function public.can_access_transaction(uuid) to authenticated, service_role;
revoke execute on function public.co_tenancy_risk() from public;
grant execute on function public.co_tenancy_risk() to authenticated, service_role;
revoke execute on function public.leases_move_events() from public;
grant execute on function public.leases_move_events() to authenticated, service_role;
revoke execute on function public.sync_co_tenancy_flags() from public;
grant execute on function public.sync_co_tenancy_flags() to authenticated, service_role;
revoke execute on function public.termination_risk() from public;
grant execute on function public.termination_risk() to authenticated, service_role;

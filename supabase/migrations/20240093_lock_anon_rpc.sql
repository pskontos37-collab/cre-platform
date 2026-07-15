-- Lock down SECURITY DEFINER RPCs that the linter flagged as executable by the
-- anon role. All app traffic is authenticated (staff login) or goes through
-- edge functions using the service role, so anon needs none of these.
revoke execute on function public.assignable_users() from anon;
revoke execute on function public.can_access_task(uuid) from anon;
revoke execute on function public.can_access_transaction(uuid) from anon;
revoke execute on function public.close_pipeline_deal(uuid, date, numeric, uuid) from anon;
revoke execute on function public.co_tenancy_risk() from anon;
revoke execute on function public.leases_move_events() from anon;
revoke execute on function public.resolve_service_agreement(uuid, text, text) from anon;
revoke execute on function public.sync_co_tenancy_flags() from anon;
revoke execute on function public.termination_risk() from anon;

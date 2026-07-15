-- Per-property data-load status for the onboarding UI treatment: a property is
-- "loaded" when it has active leases or GL months. Reads GL through
-- v_gl_pnl_monthly (the existing app-facing view) so grants keep working.
create or replace view public.v_property_data_status
with (security_invoker = on) as
select p.id as property_id,
       coalesce(l.n, 0)::int as active_leases,
       coalesce(g.n, 0)::int as gl_months,
       (coalesce(l.n, 0) > 0 or coalesce(g.n, 0) > 0) as data_loaded
from public.properties p
left join (select property_id, count(*) as n
           from public.leases where status = 'active' group by 1) l on l.property_id = p.id
left join (select property_id, count(*) as n
           from public.v_gl_pnl_monthly group by 1) g on g.property_id = p.id;
grant select on public.v_property_data_status to authenticated;

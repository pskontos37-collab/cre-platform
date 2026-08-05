-- REA members are parcel owners under the Reciprocal Easement Agreement, not
-- tenants (user-confirmed 2026-07-04): PH Developers, Kohl's, Target,
-- Home Depot, IHOP, Applebee's, Chick-fil-A, Chili's. MRI carries them in
-- RETAILRR for REA billing, which is how they seeded into `leases`.
alter table public.leases add column if not exists is_rea_member boolean not null default false;

update public.leases l set is_rea_member = true
from public.tenants t
where t.id = l.tenant_id
  and (
    t.name ~* '(ph developers|kohl|target|home depot|ihop|i-hop|applebee|chick.?fil.?a|chili)'
    or coalesce(t.trade_name, '') ~* '(ph developers|kohl|target|home depot|ihop|i-hop|applebee|chick.?fil.?a|chili)'
  );

notify pgrst, 'reload schema';
-- 20240201_gateway_0840_component_sf
-- "Additional Space 0840 - 024" (Gateway) is J. Crew's Space 24 carried as a
-- separate MRI component record — commencement 2023-05-19, expiration
-- 2034-01-31, and 1,110 sf all exactly match the J. Crew lease, whose own row
-- already holds the COMBINED premises (5,360 sf = 4,250 suite 013 + 1,110
-- space 24, per the 2026-07-28 J. Crew correction). Leaving 1,110 sf on the
-- component row double-counts Space 24 in every lease-derived SF sum at
-- Gateway (useLeaseRollover's WALT/rollover, the Executive Snapshot's
-- occupancy). Null it — the same non-summing convention the REA-member rows
-- follow — leaving the row itself intact as the MRI mirror.
do $$
declare v_lease uuid; v_sf numeric; n int; v_gw_sum_before numeric; v_gw_sum_after numeric;
begin
  select l.id, l.leased_sf into strict v_lease, v_sf
  from leases l join tenants t on t.id = l.tenant_id join properties p on p.id = l.property_id
  where p.name ilike '%gateway%' and t.name like 'Additional Space 0840%';
  if v_sf is distinct from 1110 then
    raise exception 'pre-state mismatch: component row leased_sf = %, expected 1110', v_sf;
  end if;
  select sum(coalesce(leased_sf, 0)) into v_gw_sum_before
  from leases l join properties p on p.id = l.property_id
  where p.name ilike '%gateway%' and l.status = 'active';

  update leases set leased_sf = null where id = v_lease;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'update touched % rows', n; end if;

  select sum(coalesce(leased_sf, 0)) into v_gw_sum_after
  from leases l join properties p on p.id = l.property_id
  where p.name ilike '%gateway%' and l.status = 'active';
  if v_gw_sum_after <> v_gw_sum_before - 1110 then
    raise exception 'Gateway active leased_sf sum moved % -> %, expected exactly -1110', v_gw_sum_before, v_gw_sum_after;
  end if;
end $$;

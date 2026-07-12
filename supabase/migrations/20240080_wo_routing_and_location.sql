-- 20240080_wo_routing_and_location.sql
-- Work-order feedback round 1 (user, 2026-07-12):
-- (1) "Assign to" is not a staff-name dropdown — orders route to a CONTRACTOR
--     (vendor). The picker recommends vendors first: learned from past
--     work-order routings (who you send each scope to, per property), seeded
--     by the service_agreements vendor book until history accumulates.
--     Recommendation ranking is client-side (src/hooks/useWorkOrders.ts) —
--     both inputs are already staff-readable under RLS.
-- (2) Tenants can flag COMMON-AREA issues (parking lot, corridors, exterior),
--     not just their own suite.

alter table public.work_orders
  add column if not exists assigned_vendor text,
  add column if not exists routed_at timestamptz,
  add column if not exists location_type text not null default 'unit'
    check (location_type in ('unit','common_area')),
  add column if not exists location_detail text;

-- assigned_to (staff uuid) is retained in the schema but no longer surfaced
-- in the UI; contractor routing is the operative assignment.

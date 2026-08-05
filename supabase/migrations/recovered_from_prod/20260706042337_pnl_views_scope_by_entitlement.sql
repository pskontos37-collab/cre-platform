-- Advisor 0010 root cause: v_gl_pnl_* are SECURITY DEFINER views over matviews
-- (which can't carry RLS), so any authenticated user read all-portfolio P&L.
-- Fix without touching the penny-accurate matview aggregation: filter each view
-- by can_access_property(). auth.uid() resolves to the real caller even inside a
-- definer view, so admins/AMs still see everything and scoped users see only
-- their assets. (The views stay SECURITY DEFINER by necessity — they must read
-- the perf matview, which is revoked from authenticated — so advisor 0010 will
-- still flag them, but the actual all-portfolio leak is closed.)

create or replace view public.v_gl_pnl_monthly as
  select property_id, period_year, period_month, revenue, opex, noi
  from public.mv_gl_pnl_monthly
  where public.can_access_property(property_id);

create or replace view public.v_gl_pnl_category as
  select property_id, period_year, period_month, line_type, category, amount
  from public.mv_gl_pnl_category
  where public.can_access_property(property_id);
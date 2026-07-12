-- ============================================================
-- Materialize the GL P&L rollups (APPLIED to prod 2026-07-01 via Management API).
-- v_gl_pnl_monthly / v_gl_pnl_category previously recomputed the name-based
-- classifier (v_gl_pnl_lines) over the full gl_entries table on every request
-- (~8s), tripping the authenticated role's statement timeout → blank widgets.
-- Now the heavy computation runs at refresh time; the app-facing view names
-- are unchanged (thin views over the matviews).
--
-- ⚠ LOADER CONTRACT: after ANY gl_entries load (gl_owned.ps1 etc.) run:
--   refresh materialized view mv_gl_pnl_monthly;
--   refresh materialized view mv_gl_pnl_category;
-- ============================================================

drop view if exists v_gl_pnl_monthly;
drop view if exists v_gl_pnl_category;

create materialized view mv_gl_pnl_monthly as
select property_id, period_year, period_month,
       coalesce(sum(amount) filter (where line_type = 'revenue'), 0::numeric) as revenue,
       coalesce(sum(amount) filter (where line_type = 'opex'),    0::numeric) as opex,
       coalesce(sum(amount) filter (where line_type = 'revenue'), 0::numeric)
     - coalesce(sum(amount) filter (where line_type = 'opex'),    0::numeric) as noi
from v_gl_pnl_lines
group by property_id, period_year, period_month;

create materialized view mv_gl_pnl_category as
select property_id, period_year, period_month, line_type, category, sum(amount) as amount
from v_gl_pnl_lines
group by property_id, period_year, period_month, line_type, category;

create index idx_mv_glm_prop on mv_gl_pnl_monthly(property_id);
create index idx_mv_glc_prop on mv_gl_pnl_category(property_id, period_year);

create view v_gl_pnl_monthly  as select * from mv_gl_pnl_monthly;
create view v_gl_pnl_category as select * from mv_gl_pnl_category;

grant select on mv_gl_pnl_monthly, mv_gl_pnl_category, v_gl_pnl_monthly, v_gl_pnl_category
  to anon, authenticated, service_role;

-- Also applied alongside: authenticated statement_timeout raised 8s → 20s
-- (alter role authenticated set statement_timeout = '20s') as headroom for the
-- remaining live views (v_gl_account_* drill-downs).

-- ============================================================
-- DASHBOARD WIDGET PRESETS
-- Migration 20240071
--
-- Lets an admin define which dashboard widgets an access template opens
-- with, following the exact materialization pattern of 20240039's
-- users.allowed_pages:
--   * access_templates.dashboard_widgets — ordered widget keys (see
--     src/lib/dashboardWidgets.ts). null = the role's built-in preset.
--   * users.dashboard_widgets           — materialized from the template on
--     apply/create (admin RLS already permits the write); hand-editable per
--     user afterward. null = follow the role preset.
--
-- Resolution in the app: user's own saved layout (localStorage) →
-- users.dashboard_widgets → role preset → full default. No RLS changes:
-- users already read their own row, admins already update users and manage
-- access_templates.
-- ============================================================

alter table access_templates add column if not exists dashboard_widgets text[];
alter table users            add column if not exists dashboard_widgets text[];

comment on column access_templates.dashboard_widgets is
  'Ordered dashboard widget keys (src/lib/dashboardWidgets.ts) this profile opens with; null = role default preset.';
comment on column users.dashboard_widgets is
  'Ordered dashboard widget keys forming this user''s default dashboard; materialized from access_templates.dashboard_widgets on template apply; null = role default preset.';

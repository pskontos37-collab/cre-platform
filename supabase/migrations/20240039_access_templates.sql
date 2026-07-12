-- ============================================================
-- ACCESS TEMPLATES + per-user page/access scoping
-- Migration 20240039
--
-- Adds the admin-facing "template profile" concept on top of the
-- existing roles + entitlements + RLS machinery (20240008 / 20240009):
--   * access_templates          — a named, reusable preset an admin can
--                                 apply to any user. Defines role, which
--                                 pages the user sees, and what portfolios /
--                                 properties / funds they can read.
--   * users.allowed_pages       — nav keys this user may see (null = all
--                                 pages permitted by their role). Materialized
--                                 from a template's `pages` on apply, but can
--                                 be hand-edited per user afterward.
--   * users.template_id         — which template was last applied (informational;
--                                 access itself lives in entitlements + allowed_pages).
--
-- Applying a template = set users.role/allowed_pages/template_id and REPLACE the
-- user's entitlement rows. That materialization is done by the admin UI (RLS lets
-- an admin write users + entitlements) or the admin-users edge function.
-- ============================================================

create table if not exists access_templates (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null unique,
  description  text,
  role         user_role not null default 'property_manager',
  -- nav page keys (see src/lib/pages.ts). null = every page allowed for the role.
  pages        text[],
  -- what the template grants. 'global' = everything; otherwise one entitlement
  -- row is created per id in resource_ids, keyed to the matching column below.
  grant_scope  entitlement_scope not null default 'global',
  resource_ids uuid[] not null default '{}',
  can_write    boolean not null default false,
  can_upload   boolean not null default false,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table users add column if not exists allowed_pages text[];
alter table users add column if not exists template_id  uuid references access_templates(id) on delete set null;

-- ── RLS: admins manage templates; asset managers may read them (for reference).
alter table access_templates enable row level security;

create policy "access_templates_select" on access_templates for select
  using (public.is_admin_or_am());

create policy "access_templates_write" on access_templates for all
  using (
    exists (select 1 from public.users u
            where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
  )
  with check (
    exists (select 1 from public.users u
            where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
  );

-- ── Seed the two role-level defaults. Property/portfolio-scoped templates are
--    created in the UI (they need real resource ids). Idempotent on name.
insert into access_templates (name, description, role, pages, grant_scope, can_write, can_upload)
values
  ('Asset Manager — Full',
   'Full portfolio visibility: every page, all properties, financial and capital data. Can edit and upload.',
   'asset_manager', null, 'global', true, true),
  ('Property Manager — All Properties (read-only)',
   'Operational pages across all properties, view-only. Excludes financials, waterfall, agreements and abstracts.',
   'property_manager',
   array['dashboard','ask','properties','receivables','rea','services','brokerage','documents','market'],
   'global', false, false)
on conflict (name) do nothing;

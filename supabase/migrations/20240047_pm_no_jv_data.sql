-- ============================================================
-- PROPERTY MANAGERS: no JV / waterfall data (migration 20240041)
--
-- Smoke test (2026-07-05) found a property manager entitled to a property could
-- read that property's `waterfall_tiers` (and `distributions` / `deals`) over the
-- API, because those policies granted access to anyone who could reach the deal's
-- property. The Waterfall PAGE was already hidden from PMs, but the DATA wasn't.
--
-- Fix: the deal-level branch is now limited to ASSET MANAGERS. Result:
--   * admin / full asset_manager  -> everything (is_admin_or_am()).
--   * scoped asset_manager        -> deal economics for THEIR assets only.
--   * property_manager            -> no deals / waterfall / distributions at all.
-- The already-locked capital tables (funds, investors, capital_accounts,
-- preferred_equity_positions, distribution_line_items) stay is_admin_or_am()-only.
-- ============================================================

create or replace function public.is_asset_manager()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'asset_manager' and is_active = true
  );
$$;

drop policy if exists "waterfall_tiers_select" on waterfall_tiers;
create policy "waterfall_tiers_select" on waterfall_tiers for select using (
  public.is_admin_or_am()
  or (
    public.is_asset_manager()
    and exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
  )
);

drop policy if exists "distributions_select" on distributions;
create policy "distributions_select" on distributions for select using (
  public.is_admin_or_am()
  or (
    public.is_asset_manager()
    and exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
  )
);

drop policy if exists "deals_select" on deals;
create policy "deals_select" on deals for select using (
  public.is_admin_or_am()
  or (public.is_asset_manager() and public.can_access_property(property_id))
);

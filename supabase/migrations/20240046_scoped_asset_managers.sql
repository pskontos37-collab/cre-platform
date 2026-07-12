-- ============================================================
-- SCOPED ASSET MANAGERS (migration 20240040)
--
-- Until now `is_admin_or_am()` treated EVERY asset_manager as full-portfolio,
-- so per-asset entitlements were ignored for them (only property_managers were
-- scoped). This redefines "full access" so an asset_manager who has been given
-- specific portfolio/property entitlements is limited to those assets — exactly
-- like a property manager, but keeping the AM's page + deal-level visibility for
-- the assets they hold.
--
-- Backward compatible: an asset_manager with NO entitlements, or one holding an
-- explicit `global` grant, keeps full-portfolio access (unchanged behavior).
-- Admins are always full access.
--
-- No policies change — only the two helper functions they already call. Also
-- pins search_path on both (clears the function_search_path_mutable advisory).
-- ============================================================

create or replace function public.is_admin_or_am()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.is_active = true
      and (
        u.role = 'admin'
        or (
          u.role = 'asset_manager'
          and (
            -- legacy full access: no entitlements assigned yet
            not exists (select 1 from public.entitlements e where e.user_id = u.id)
            -- or an explicit organization-wide grant
            or exists (
              select 1 from public.entitlements e
              where e.user_id = u.id and e.scope = 'global' and e.can_read = true
            )
          )
        )
      )
  );
$$;

create or replace function public.can_access_property(p_property_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    public.is_admin_or_am()
    or exists (
      select 1
      from public.entitlements e
      join public.users u on u.id = e.user_id
      where e.user_id = auth.uid()
        and u.is_active = true
        and e.can_read = true
        and (
          e.scope = 'global'
          or (e.scope = 'property'   and e.property_id = p_property_id)
          or (e.scope = 'portfolio'  and e.portfolio_id = (
                select portfolio_id from public.properties where id = p_property_id
              ))
        )
    );
$$;

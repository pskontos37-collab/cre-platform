-- ============================================================
-- ROW LEVEL SECURITY
-- Default: deny all. Each policy explicitly grants access.
-- ============================================================

alter table portfolios               enable row level security;
alter table properties               enable row level security;
alter table units                    enable row level security;
alter table tenants                  enable row level security;
alter table leases                   enable row level security;
alter table lease_rent_schedule      enable row level security;
alter table lease_cam_terms          enable row level security;
alter table lease_options            enable row level security;
alter table co_tenancy_clauses       enable row level security;
alter table co_tenancy_flags         enable row level security;
alter table critical_dates           enable row level security;
alter table financial_periods        enable row level security;
alter table operating_line_items     enable row level security;
alter table loans                    enable row level security;
alter table loan_covenant_checks     enable row level security;
alter table import_jobs              enable row level security;
alter table funds                    enable row level security;
alter table investors                enable row level security;
alter table deals                    enable row level security;
alter table waterfall_tiers          enable row level security;
alter table preferred_equity_positions enable row level security;
alter table capital_accounts         enable row level security;
alter table distributions            enable row level security;
alter table distribution_line_items  enable row level security;
alter table documents                enable row level security;
alter table document_chunks          enable row level security;
alter table inspections              enable row level security;
alter table users                    enable row level security;
alter table entitlements             enable row level security;

-- ── Helper: is the current user an admin or asset manager?
create or replace function public.is_admin_or_am()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role in ('admin', 'asset_manager') and is_active = true
  );
$$;

-- ── Helper: can the current user access a specific property?
create or replace function public.can_access_property(p_property_id uuid)
returns boolean language sql stable security definer as $$
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

-- ── Portfolios
create policy "portfolios_select" on portfolios for select using (
  public.is_admin_or_am()
  or exists (
    select 1 from public.entitlements e
    where e.user_id = auth.uid() and e.can_read = true
      and (e.scope = 'global' or (e.scope = 'portfolio' and e.portfolio_id = portfolios.id))
  )
);
create policy "portfolios_write" on portfolios for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Properties
create policy "properties_select" on properties for select
  using (public.can_access_property(id));
create policy "properties_insert" on properties for insert
  with check (public.is_admin_or_am());
create policy "properties_update" on properties for update
  using (public.is_admin_or_am());
create policy "properties_delete" on properties for delete
  using (public.is_admin_or_am());

-- ── Units
create policy "units_select" on units for select
  using (public.can_access_property(property_id));
create policy "units_write" on units for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Tenants (visible if user can access any of their leases' properties)
create policy "tenants_select" on tenants for select using (
  public.is_admin_or_am()
  or exists (
    select 1 from public.leases l
    where l.tenant_id = tenants.id and public.can_access_property(l.property_id)
  )
);
create policy "tenants_write" on tenants for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Leases
create policy "leases_select" on leases for select
  using (public.can_access_property(property_id));
create policy "leases_write" on leases for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Lease child tables
create policy "lease_rent_schedule_select" on lease_rent_schedule for select using (
  exists (select 1 from public.leases l where l.id = lease_id and public.can_access_property(l.property_id))
);
create policy "lease_cam_terms_select" on lease_cam_terms for select using (
  exists (select 1 from public.leases l where l.id = lease_id and public.can_access_property(l.property_id))
);
create policy "lease_options_select" on lease_options for select using (
  exists (select 1 from public.leases l where l.id = lease_id and public.can_access_property(l.property_id))
);
create policy "co_tenancy_clauses_select" on co_tenancy_clauses for select using (
  exists (select 1 from public.leases l where l.id = lease_id and public.can_access_property(l.property_id))
);
create policy "co_tenancy_flags_select" on co_tenancy_flags for select
  using (public.can_access_property(property_id));

-- ── Critical dates
create policy "critical_dates_select" on critical_dates for select
  using (public.can_access_property(property_id));

-- ── Financials
create policy "financial_periods_select" on financial_periods for select
  using (public.can_access_property(property_id));
create policy "operating_line_items_select" on operating_line_items for select using (
  exists (select 1 from public.financial_periods fp where fp.id = financial_period_id and public.can_access_property(fp.property_id))
);
create policy "loans_select" on loans for select
  using (public.can_access_property(property_id));
create policy "loan_covenant_checks_select" on loan_covenant_checks for select using (
  exists (select 1 from public.loans l where l.id = loan_id and public.can_access_property(l.property_id))
);
create policy "import_jobs_select" on import_jobs for select
  using (public.can_access_property(property_id));

-- ── Capital stack (asset manager / admin only — LP data is internal)
create policy "funds_select"      on funds      for select using (public.is_admin_or_am());
create policy "investors_select"  on investors  for select using (public.is_admin_or_am());
create policy "deals_select"      on deals      for select using (public.can_access_property(property_id));
create policy "waterfall_tiers_select" on waterfall_tiers for select using (
  public.is_admin_or_am()
  or exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
);
create policy "preferred_equity_positions_select" on preferred_equity_positions for select
  using (public.is_admin_or_am());
create policy "capital_accounts_select"   on capital_accounts   for select using (public.is_admin_or_am());
create policy "distributions_select"      on distributions      for select using (
  public.is_admin_or_am()
  or exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
);
create policy "distribution_line_items_select" on distribution_line_items for select
  using (public.is_admin_or_am());

-- ── Documents
create policy "documents_select" on documents for select using (
  property_id is null or public.can_access_property(property_id)
);
create policy "documents_insert" on documents for insert with check (
  public.is_admin_or_am()
  or exists (
    select 1 from public.entitlements e
    where e.user_id = auth.uid() and e.can_upload = true
      and (e.scope = 'global' or (e.scope = 'property' and e.property_id = documents.property_id))
  )
);
create policy "document_chunks_select" on document_chunks for select using (
  exists (
    select 1 from public.documents d
    where d.id = document_id and (d.property_id is null or public.can_access_property(d.property_id))
  )
);
create policy "inspections_select" on inspections for select
  using (public.can_access_property(property_id));

-- ── Users
create policy "users_select_own" on users for select using (id = auth.uid());
create policy "users_admin_all"  on users for all using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);
create policy "users_update_self" on users for update using (id = auth.uid());

-- ── Entitlements
create policy "entitlements_select" on entitlements for select using (
  user_id = auth.uid() or public.is_admin_or_am()
);
create policy "entitlements_write" on entitlements for all using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);

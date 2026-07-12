-- ============================================================
-- REMAINING MIGRATIONS (files 5 through 11)
-- Paste this entire file into Supabase SQL Editor and click Run
-- ============================================================


-- ── FILE 5: Financials ────────────────────────────────────────

create table import_jobs (
  id             uuid primary key default uuid_generate_v4(),
  property_id    uuid not null references properties(id) on delete cascade,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  file_name      text,
  import_type    import_type not null,
  status         import_status not null default 'pending',
  column_mapping jsonb,
  row_count      integer,
  error_log      jsonb
);

create table financial_periods (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references properties(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  period_type   period_type not null,
  is_budget     boolean not null default false,
  source        financial_source not null default 'manual',
  import_job_id uuid references import_jobs(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table operating_line_items (
  id                  uuid primary key default uuid_generate_v4(),
  financial_period_id uuid not null references financial_periods(id) on delete cascade,
  category            operating_category not null,
  line_name           text not null,
  amount              numeric not null,
  unit_id             uuid references units(id) on delete set null,
  tenant_id           uuid references tenants(id) on delete set null,
  notes               text,
  created_at          timestamptz not null default now()
);

create table loans (
  id                  uuid primary key default uuid_generate_v4(),
  property_id         uuid not null references properties(id) on delete restrict,
  lender_name         text,
  loan_amount         numeric,
  outstanding_balance numeric,
  interest_rate       numeric,
  rate_type           rate_type not null default 'fixed',
  origination_date    date,
  maturity_date       date,
  amortization_years  integer,
  io_period_months    integer,
  annual_debt_service numeric,
  dscr_covenant       numeric,
  ltv_covenant        numeric,
  notes               text,
  document_id         uuid references documents(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table loan_covenant_checks (
  id              uuid primary key default uuid_generate_v4(),
  loan_id         uuid not null references loans(id) on delete cascade,
  checked_at      date not null,
  trailing_12_noi numeric,
  annual_debt_svc numeric,
  dscr_actual     numeric,
  dscr_covenant   numeric,
  headroom        numeric,
  is_breach       boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table critical_dates
  add constraint critical_dates_loan_id_fkey
  foreign key (loan_id) references loans(id) on delete set null;


-- ── FILE 6: Capital Stack & Waterfall ─────────────────────────

create table funds (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  fund_type     text not null default 'equity',
  vintage_year  integer,
  target_return numeric,
  notes         text,
  created_at    timestamptz not null default now()
);

create table investors (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  entity_type  investor_entity_type not null default 'lp',
  contact_info jsonb,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table deals (
  id                      uuid primary key default uuid_generate_v4(),
  property_id             uuid not null references properties(id) on delete restrict,
  fund_id                 uuid references funds(id) on delete set null,
  name                    text not null,
  closing_date            date,
  total_equity            numeric,
  gp_equity               numeric,
  lp_equity               numeric,
  preferred_equity_amount numeric,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table waterfall_tiers (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  tier_order    integer not null,
  tier_type     waterfall_tier_type not null,
  description   text,
  hurdle_irr    numeric,
  pref_rate     numeric,
  lp_split_pct  numeric,
  gp_split_pct  numeric,
  is_cumulative boolean not null default true,
  is_pik        boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (deal_id, tier_order)
);

create table preferred_equity_positions (
  id               uuid primary key default uuid_generate_v4(),
  deal_id          uuid not null references deals(id) on delete cascade,
  investor_id      uuid not null references investors(id) on delete restrict,
  principal_amount numeric not null,
  preferred_rate   numeric not null,
  is_pik           boolean not null default false,
  accrued_return   numeric not null default 0,
  redemption_date  date,
  is_redeemed      boolean not null default false,
  priority_rank    integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table capital_accounts (
  id                   uuid primary key default uuid_generate_v4(),
  deal_id              uuid not null references deals(id) on delete cascade,
  investor_id          uuid not null references investors(id) on delete restrict,
  account_type         capital_account_type not null default 'common_equity',
  initial_contribution numeric not null,
  current_balance      numeric not null,
  contributed_to_date  numeric not null default 0,
  distributed_to_date  numeric not null default 0,
  pref_accrued_to_date numeric not null default 0,
  is_pref_redeemed     boolean not null default false,
  opened_at            date not null,
  closed_at            date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table distributions (
  id                 uuid primary key default uuid_generate_v4(),
  deal_id            uuid not null references deals(id) on delete restrict,
  distribution_date  date not null,
  total_available    numeric not null,
  waterfall_snapshot jsonb,
  created_at         timestamptz not null default now()
);

create table distribution_line_items (
  id                 uuid primary key default uuid_generate_v4(),
  distribution_id    uuid not null references distributions(id) on delete cascade,
  capital_account_id uuid not null references capital_accounts(id) on delete restrict,
  waterfall_tier_id  uuid references waterfall_tiers(id) on delete set null,
  investor_id        uuid not null references investors(id) on delete restrict,
  amount             numeric not null,
  tier_type          waterfall_tier_type,
  notes              text,
  created_at         timestamptz not null default now()
);


-- ── FILE 7: Documents & Inspections ───────────────────────────

alter table documents
  add column property_id     uuid references properties(id) on delete restrict,
  add column tenant_id       uuid references tenants(id) on delete set null,
  add column loan_id         uuid references loans(id) on delete set null,
  add column doc_type        doc_type not null default 'other',
  add column title           text not null default '',
  add column file_path       text,
  add column file_name       text,
  add column mime_type       text,
  add column file_size_bytes integer,
  add column version         integer not null default 1,
  add column superseded_by   uuid references documents(id) on delete set null,
  add column upload_date     date,
  add column uploaded_by     uuid,
  add column is_indexed      boolean not null default false,
  add column notes           text,
  add column created_at      timestamptz not null default now();

create table document_chunks (
  id          uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index integer not null,
  content     text not null,
  embedding   vector(1536),
  page_number integer,
  created_at  timestamptz not null default now()
);

create table inspections (
  id               uuid primary key default uuid_generate_v4(),
  property_id      uuid not null references properties(id) on delete cascade,
  document_id      uuid references documents(id) on delete set null,
  inspected_by     text,
  inspection_date  date not null,
  inspection_type  inspection_type not null default 'routine',
  summary          text,
  condition_rating condition_rating,
  uploaded_by      uuid,
  created_at       timestamptz not null default now()
);


-- ── FILE 8: Users & Access ─────────────────────────────────────

create table users (
  id         uuid primary key,
  email      text not null unique,
  full_name  text,
  role       user_role not null default 'property_manager',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table co_tenancy_flags
  add constraint co_tenancy_flags_reviewed_by_fkey
  foreign key (reviewed_by) references users(id) on delete set null;

alter table import_jobs
  add constraint import_jobs_created_by_fkey
  foreign key (created_by) references users(id) on delete set null;

alter table documents
  add constraint documents_uploaded_by_fkey
  foreign key (uploaded_by) references users(id) on delete set null;

alter table inspections
  add constraint inspections_uploaded_by_fkey
  foreign key (uploaded_by) references users(id) on delete set null;

create table entitlements (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references users(id) on delete cascade,
  scope        entitlement_scope not null,
  portfolio_id uuid references portfolios(id) on delete cascade,
  property_id  uuid references properties(id) on delete cascade,
  fund_id      uuid references funds(id) on delete cascade,
  investor_id  uuid references investors(id) on delete cascade,
  can_read     boolean not null default true,
  can_write    boolean not null default false,
  can_upload   boolean not null default false,
  granted_by   uuid references users(id) on delete set null,
  granted_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'property_manager'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ── FILE 9: Row Level Security ─────────────────────────────────

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

create or replace function public.is_admin_or_am()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role in ('admin', 'asset_manager') and is_active = true
  );
$$;

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

create policy "properties_select" on properties for select
  using (public.can_access_property(id));
create policy "properties_insert" on properties for insert
  with check (public.is_admin_or_am());
create policy "properties_update" on properties for update
  using (public.is_admin_or_am());
create policy "properties_delete" on properties for delete
  using (public.is_admin_or_am());

create policy "units_select" on units for select
  using (public.can_access_property(property_id));
create policy "units_write" on units for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

create policy "tenants_select" on tenants for select using (
  public.is_admin_or_am()
  or exists (
    select 1 from public.leases l
    where l.tenant_id = tenants.id and public.can_access_property(l.property_id)
  )
);
create policy "tenants_write" on tenants for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

create policy "leases_select" on leases for select
  using (public.can_access_property(property_id));
create policy "leases_write" on leases for all
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

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
create policy "critical_dates_select" on critical_dates for select
  using (public.can_access_property(property_id));

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

create policy "funds_select"     on funds     for select using (public.is_admin_or_am());
create policy "investors_select" on investors for select using (public.is_admin_or_am());
create policy "deals_select"     on deals     for select using (public.can_access_property(property_id));
create policy "waterfall_tiers_select" on waterfall_tiers for select using (
  public.is_admin_or_am()
  or exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
);
create policy "preferred_equity_positions_select" on preferred_equity_positions for select
  using (public.is_admin_or_am());
create policy "capital_accounts_select"  on capital_accounts  for select using (public.is_admin_or_am());
create policy "distributions_select"     on distributions     for select using (
  public.is_admin_or_am()
  or exists (select 1 from public.deals d where d.id = deal_id and public.can_access_property(d.property_id))
);
create policy "distribution_line_items_select" on distribution_line_items for select
  using (public.is_admin_or_am());

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

create policy "users_select_own"  on users for select using (id = auth.uid());
create policy "users_update_self" on users for update using (id = auth.uid());
create policy "users_admin_all"   on users for all using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);

create policy "entitlements_select" on entitlements for select using (
  user_id = auth.uid() or public.is_admin_or_am()
);
create policy "entitlements_write" on entitlements for all using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);


-- ── FILE 10: Audit Log ─────────────────────────────────────────

create table audit_log (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references users(id) on delete set null,
  action      audit_action not null,
  entity_type text,
  entity_id   uuid,
  property_id uuid,
  detail      jsonb,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

alter table audit_log enable row level security;

create policy "audit_log_insert" on audit_log for insert
  with check (auth.uid() is not null);

create policy "audit_log_select" on audit_log for select using (
  exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active = true)
);

create or replace function public.log_mutation()
returns trigger language plpgsql security definer as $$
begin
  insert into public.audit_log (user_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(),
    lower(TG_OP)::audit_action,
    TG_TABLE_NAME,
    coalesce(new.id, old.id),
    case
      when TG_OP = 'DELETE' then to_jsonb(old)
      when TG_OP = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      else to_jsonb(new)
    end
  );
  return coalesce(new, old);
end;
$$;

create trigger audit_leases
  after insert or update or delete on leases
  for each row execute procedure public.log_mutation();

create trigger audit_distributions
  after insert or update or delete on distributions
  for each row execute procedure public.log_mutation();

create trigger audit_capital_accounts
  after insert or update or delete on capital_accounts
  for each row execute procedure public.log_mutation();

create trigger audit_users
  after insert or update or delete on users
  for each row execute procedure public.log_mutation();

create trigger audit_entitlements
  after insert or update or delete on entitlements
  for each row execute procedure public.log_mutation();


-- ── FILE 11: Indexes ───────────────────────────────────────────

create index idx_properties_portfolio_id   on properties(portfolio_id);
create index idx_properties_asset_type     on properties(asset_type);
create index idx_units_property_id         on units(property_id);
create index idx_leases_property_id        on leases(property_id);
create index idx_leases_tenant_id          on leases(tenant_id);
create index idx_leases_expiration_date    on leases(expiration_date);
create index idx_leases_status             on leases(status);
create index idx_critical_dates_property_id on critical_dates(property_id);
create index idx_critical_dates_due_date   on critical_dates(due_date);
create index idx_critical_dates_completed  on critical_dates(is_completed);
create index idx_financial_periods_prop_id on financial_periods(property_id);
create index idx_financial_periods_start   on financial_periods(period_start);
create index idx_oli_financial_period_id   on operating_line_items(financial_period_id);
create index idx_oli_category              on operating_line_items(category);
create index idx_loans_property_id         on loans(property_id);
create index idx_loans_maturity_date       on loans(maturity_date);
create index idx_deals_property_id         on deals(property_id);
create index idx_waterfall_tiers_deal_id   on waterfall_tiers(deal_id, tier_order);
create index idx_capital_accounts_deal_id  on capital_accounts(deal_id);
create index idx_documents_property_id     on documents(property_id);
create index idx_documents_doc_type        on documents(doc_type);
create index idx_documents_is_indexed      on documents(is_indexed);
create index idx_document_chunks_doc_id    on document_chunks(document_id);
create index idx_entitlements_user_id      on entitlements(user_id);
create index idx_entitlements_property_id  on entitlements(property_id);
create index idx_audit_log_user_id         on audit_log(user_id);
create index idx_audit_log_created_at      on audit_log(created_at desc);
create index idx_audit_log_entity          on audit_log(entity_type, entity_id);

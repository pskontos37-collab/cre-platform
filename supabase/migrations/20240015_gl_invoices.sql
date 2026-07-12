-- ============================================================
-- PHASE 3.5 — General Ledger + Accounts-Payable (invoices)
-- Adds: vendors, gl_entries, invoices, invoice_distributions
-- Source formats: MRI_GENLEDG (xlsx), AvidXchange AP export (csv)
-- Completes the financial drill-down: IS line -> GL -> invoice -> image
-- Safe to re-run (IF NOT EXISTS + ON CONFLICT).
-- ============================================================

-- ── Vendors (portfolio-wide AP payees) ───────────────────────
create table if not exists public.vendors (
  id              uuid        primary key default uuid_generate_v4(),
  name            text        not null,
  normalized_name text        not null,                 -- lower/trimmed for dedupe
  avid_vendor_id  text,                                  -- MRI/Avid vendor code (e.g. WAKE1)
  created_at      timestamptz not null default now(),
  unique(normalized_name)
);

-- ── General ledger transactions (MRI_GENLEDG) ────────────────
create table if not exists public.gl_entries (
  id                 uuid        primary key default uuid_generate_v4(),
  property_id        uuid        references public.properties(id) on delete cascade,
  entity_code        text,                               -- MRI entity (0531/0532)
  account_code       text,                               -- e.g. 1001-00 (carried from block header)
  account_name       text,
  period             text,                               -- raw MRI period token (MM/YY)
  period_year        int,
  period_month       int         check (period_month between 1 and 12),
  entry_date         date,
  source_code        text,                               -- MRI src (NG, PY, AP, ...)
  reference          text,                               -- batch/reference number
  site_id            text,
  job_code           text,
  dept               text,
  description        text,
  debit              numeric     not null default 0,
  credit             numeric     not null default 0,
  balance            numeric,
  is_balance_forward boolean     not null default false,
  invoice_id         uuid,                               -- FK to invoices added after that table exists (below)
  raw                jsonb,
  created_at         timestamptz not null default now()
);

-- ── Invoices (AvidXchange AP header, one per Invoice ID) ──────
create table if not exists public.invoices (
  id                 uuid        primary key default uuid_generate_v4(),
  property_id        uuid        references public.properties(id) on delete cascade,
  vendor_id          uuid        references public.vendors(id) on delete set null,
  avid_invoice_id    text,                               -- source GUID
  invoice_number     text,
  invoice_type       text,
  invoice_state      text,                               -- Approved / etc.
  batch_name         text,
  entity_code        text,
  posting_date       date,
  invoice_date       date,
  due_date           date,
  payment_terms      text,
  entered_date       timestamptz,
  entered_by         text,
  approval_date      timestamptz,
  approved_by        text,
  workflow           text,
  workflow_step      text,
  memo               text,
  po_number          text,
  work_order_number  text,
  service_start_date date,
  service_end_date   date,
  previous_balance   numeric,
  invoice_subtotal   numeric,
  shipping_cost      numeric,
  tax                numeric,
  misc_cost          numeric,
  discount           numeric,
  invoice_total      numeric,
  invoice_url        text,                               -- AvidXchange portal deep-link
  image_url          text,                               -- ungated invoice image (col AF)
  accounting_system  text,
  document_id        uuid        references public.documents(id) on delete set null, -- set if image ingested to RAG
  raw                jsonb,
  created_at         timestamptz not null default now(),
  unique(avid_invoice_id)
);

-- ── Invoice distributions (GL-coded lines, one per CSV row) ───
create table if not exists public.invoice_distributions (
  id                     uuid        primary key default uuid_generate_v4(),
  invoice_id             uuid        not null references public.invoices(id) on delete cascade,
  property_id            uuid        references public.properties(id) on delete cascade,
  distribution_number    int,
  distribution_desc      text,
  amount                 numeric     not null default 0,
  gl_account_code        text,                           -- extracted from "Accounting Codes" code dimension
  gl_account_desc        text,
  property_code          text,                           -- extracted from "Property Codes" dimension
  codes                  jsonb,                          -- full Code 1..15 group/value/desc set
  gl_entry_id            uuid        references public.gl_entries(id) on delete set null,
  raw                    jsonb,
  created_at             timestamptz not null default now()
);

-- gl_entries.invoice_id FK references invoices, created above; add now that both exist.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gl_entries_invoice_id_fkey'
  ) then
    alter table public.gl_entries
      add constraint gl_entries_invoice_id_fkey
      foreign key (invoice_id) references public.invoices(id) on delete set null;
  end if;
end $$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.vendors               enable row level security;
alter table public.gl_entries            enable row level security;
alter table public.invoices              enable row level security;
alter table public.invoice_distributions enable row level security;

drop policy if exists "vendors_select" on public.vendors;
drop policy if exists "vendors_write"  on public.vendors;
create policy "vendors_select" on public.vendors for select using (public.is_admin_or_am());
create policy "vendors_write"  on public.vendors for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());

drop policy if exists "gl_select" on public.gl_entries;
drop policy if exists "gl_write"  on public.gl_entries;
create policy "gl_select" on public.gl_entries for select using (public.can_access_property(property_id));
create policy "gl_write"  on public.gl_entries for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());

drop policy if exists "inv_select" on public.invoices;
drop policy if exists "inv_write"  on public.invoices;
create policy "inv_select" on public.invoices for select using (public.can_access_property(property_id));
create policy "inv_write"  on public.invoices for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());

drop policy if exists "invd_select" on public.invoice_distributions;
drop policy if exists "invd_write"  on public.invoice_distributions;
create policy "invd_select" on public.invoice_distributions for select using (public.can_access_property(property_id));
create policy "invd_write"  on public.invoice_distributions for all    using (public.is_admin_or_am()) with check (public.is_admin_or_am());

-- ── Indexes ───────────────────────────────────────────────────
create index if not exists idx_gl_prop_acct_period on public.gl_entries(property_id, account_code, period_year, period_month);
create index if not exists idx_gl_account          on public.gl_entries(account_code);
create index if not exists idx_gl_reference        on public.gl_entries(reference);
create index if not exists idx_gl_entry_date       on public.gl_entries(entry_date);
create index if not exists idx_inv_property        on public.invoices(property_id);
create index if not exists idx_inv_vendor          on public.invoices(vendor_id);
create index if not exists idx_inv_posting         on public.invoices(property_id, posting_date);
create index if not exists idx_invd_invoice        on public.invoice_distributions(invoice_id);
create index if not exists idx_invd_glacct         on public.invoice_distributions(property_id, gl_account_code);
create index if not exists idx_invd_glentry        on public.invoice_distributions(gl_entry_id);

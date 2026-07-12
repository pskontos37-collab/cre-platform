-- 20240055_transactions.sql
-- Record of CLOSED transactions (acquisition / refinance / recap / disposition)
-- per owned asset — institutional memory with CERTAIN access to the governing
-- source documents. Design: docs/transactions-design.md.
--
-- Principle: CURATE, don't retrieve. Each transaction links an explicit, verified
-- set of `documents` rows (transaction_documents) — never a similarity guess.
--
-- Four tables:
--   transactions           one row per closed event (primary property anchor).
--   transaction_properties many-to-many — a deal can span properties (e.g. the
--                          MetLife cross-collateral refi across KM E/W/012).
--                          Ledger totals dedupe on transaction_id.
--   transaction_figures    named, cited amounts (contract_price / net_cash /
--                          total_basis / loan_amount ...) each traced to a
--                          document + page, marked preliminary vs final.
--   transaction_documents  the curated doc set: role, is_key, linked version +
--                          fingerprint (drift detection), sensitivity gate.

-- ── transactions ────────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id uuid primary key default uuid_generate_v4(),
  primary_property_id uuid not null references public.properties(id) on delete restrict,
  type text not null
    check (type in ('acquisition','refinance','recap','disposition')),
  -- sub-classification so a loan assumption rides INSIDE an acquisition rather
  -- than forcing a separate row; resolves refi (debt->debt) vs recap (debt->equity).
  debt_event text
    check (debt_event in ('assumed','originated','paid_off','recapped')),
  close_date date not null,
  counterparty text,
  loan_id uuid references public.loans(id) on delete set null,
  narrative text,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','verified','issues')),
  verified_by uuid references public.users(id) on delete set null,
  verified_at timestamptz,
  -- restatement chain: material corrections create a new row referencing the
  -- original rather than mutating a closed fact in place.
  superseded_by uuid references public.transactions(id) on delete set null,
  source_folder_path text,               -- authoritative V:\<prop>\ACQ-REFI-DISP\...
  source_manifest jsonb not null default '{}'::jsonb,  -- {files:[...], count:N, scanned_at}
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists transactions_primary_prop on public.transactions(primary_property_id);
create index if not exists transactions_close on public.transactions(close_date);
create index if not exists transactions_loan on public.transactions(loan_id);

-- ── transaction_properties (many-to-many) ───────────────────────────────────
create table if not exists public.transaction_properties (
  id uuid primary key default uuid_generate_v4(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  is_primary boolean not null default false,
  unique (transaction_id, property_id)
);
create index if not exists transaction_properties_txn on public.transaction_properties(transaction_id);
create index if not exists transaction_properties_prop on public.transaction_properties(property_id);

-- ── transaction_figures (named, cited amounts) ───────────────────────────────
create table if not exists public.transaction_figures (
  id uuid primary key default uuid_generate_v4(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  label text not null,                   -- contract_price | net_cash_to_close | total_basis | loan_amount | net_proceeds ...
  value numeric not null,
  document_id uuid references public.documents(id) on delete set null,  -- citation target
  page_number integer,
  basis text not null default 'final'
    check (basis in ('preliminary','final')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists transaction_figures_txn on public.transaction_figures(transaction_id);

-- ── transaction_documents (curated doc set) ──────────────────────────────────
create table if not exists public.transaction_documents (
  id uuid primary key default uuid_generate_v4(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  role text,                             -- 'settlement_statement' | 'psa' | 'deed' | 'loan_agreement' | 'title_policy' | 'note' | 'payoff_letter' | 'wire_instructions' | ...
  is_key boolean not null default false,
  linked_version integer,                -- documents.version at link time
  fingerprint jsonb not null default '{}'::jsonb,  -- {file_name, file_size_bytes} captured at link
  -- 'restricted' hides the row (wire instructions, guarantor financials) from
  -- non admin/AM roles even when they can see the transaction.
  sensitivity text not null default 'normal'
    check (sensitivity in ('normal','restricted')),
  created_at timestamptz not null default now(),
  unique (transaction_id, document_id)
);
create index if not exists transaction_documents_txn on public.transaction_documents(transaction_id);
create index if not exists transaction_documents_doc on public.transaction_documents(document_id);

-- ── access helper: can the current user see this transaction? ─────────────────
-- True if they can access ANY of its linked properties. SECURITY DEFINER so it
-- reads transaction_properties past RLS (no recursion — it never queries
-- transactions). search_path pinned per the security-hardening convention.
create or replace function public.can_access_transaction(txn_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.transaction_properties tp
    where tp.transaction_id = txn_id
      and public.can_access_property(tp.property_id)
  );
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.transactions enable row level security;
create policy "transactions_select" on public.transactions
  for select using (public.can_access_transaction(id));
create policy "transactions_write" on public.transactions
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.transactions to authenticated;

alter table public.transaction_properties enable row level security;
create policy "transaction_properties_select" on public.transaction_properties
  for select using (public.can_access_property(property_id));
create policy "transaction_properties_write" on public.transaction_properties
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.transaction_properties to authenticated;

alter table public.transaction_figures enable row level security;
create policy "transaction_figures_select" on public.transaction_figures
  for select using (public.can_access_transaction(transaction_id));
create policy "transaction_figures_write" on public.transaction_figures
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.transaction_figures to authenticated;

alter table public.transaction_documents enable row level security;
create policy "transaction_documents_select" on public.transaction_documents
  for select using (
    public.can_access_transaction(transaction_id)
    and (sensitivity = 'normal' or public.is_admin_or_am())
  );
create policy "transaction_documents_write" on public.transaction_documents
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.transaction_documents to authenticated;

-- ── audit (closed facts are history) ─────────────────────────────────────────
create trigger audit_transactions
  after insert or update or delete on public.transactions
  for each row execute procedure public.log_mutation();
create trigger audit_transaction_figures
  after insert or update or delete on public.transaction_figures
  for each row execute procedure public.log_mutation();

notify pgrst, 'reload schema';

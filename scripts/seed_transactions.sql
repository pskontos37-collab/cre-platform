-- seed_transactions.sql — the three known closed deals (hand-entered, verified).
-- Run AFTER migration 20240055_transactions.sql is applied. Idempotent: deletes
-- the three seeded transactions by fixed id first, cascades to children.
--
--   Gateway Port Chester — ACQUISITION (with NY Life loan assumption), 10-28-25
--   Magnolia Park       — RECAP (mortgage paid off -> MetLife pref equity), 06-15-26
--   Knightdale (Consol) — REFINANCE (MetLife cross-collateral, KM E/W), 01-25-24
--
-- Figures are cited to source docs where we have them (Gateway Closing Statement).
-- Magnolia/KM figures carry no doc link yet — those folders' key docs get linked
-- by the extract-from-binder pass; until then the panel honestly shows the gap.

begin;

-- fixed ids so re-running is clean and children can reference the parents
delete from public.transactions where id in (
  '10000000-0000-0000-0000-0000000000a1',
  '10000000-0000-0000-0000-0000000000a2',
  '10000000-0000-0000-0000-0000000000a3'
);

-- ── 1. Gateway Port Chester — Acquisition (fee purchase + loan assumption) ────
insert into public.transactions
  (id, primary_property_id, type, debt_event, close_date, counterparty, loan_id,
   verification_status, source_folder_path, narrative)
values
  ('10000000-0000-0000-0000-0000000000a1',
   'd5a4ed03-0b60-4168-9208-83822dd24884', 'acquisition', 'assumed', '2025-10-28',
   'DPPC Holdings L.P. (seller)',
   'b99dcf76-16d5-4b00-bcad-76c3bbf8c898',   -- assumed New York Life loan
   'verified',
   'V:\Gateway Port Chester\ACQ-REFI-DISP',
   'Fee purchase of the ground-lessor interest closing the Gateway buyout — $103,478,461.14 total consideration, funded by assumption of the existing New York Life mortgage (~$88.98M balance) plus cash. Seller DPPC Holdings L.P.');

insert into public.transaction_properties (transaction_id, property_id, is_primary) values
  ('10000000-0000-0000-0000-0000000000a1', 'd5a4ed03-0b60-4168-9208-83822dd24884', true);

insert into public.transaction_figures (transaction_id, label, value, document_id, basis, sort_order) values
  ('10000000-0000-0000-0000-0000000000a1', 'contract_price',       103478461.14, 'ce3bd790-3ac3-4af6-9f8d-7e3d7946a941', 'final',       0),
  ('10000000-0000-0000-0000-0000000000a1', 'assumed_loan_balance',  88980000.00, 'ce3bd790-3ac3-4af6-9f8d-7e3d7946a941', 'preliminary', 1),
  ('10000000-0000-0000-0000-0000000000a1', 'net_cash_to_close',     14498461.14, 'ce3bd790-3ac3-4af6-9f8d-7e3d7946a941', 'preliminary', 2);

-- curated key docs (from the ingested "Gateway Buyout - NN." closing binder)
insert into public.transaction_documents
  (transaction_id, document_id, role, is_key, linked_version, fingerprint) values
  ('10000000-0000-0000-0000-0000000000a1', 'ce3bd790-3ac3-4af6-9f8d-7e3d7946a941', 'settlement_statement',   true,  1, '{"file_size_bytes":249501}'::jsonb),
  ('10000000-0000-0000-0000-0000000000a1', '0845d9f3-97ce-439e-976a-600ec9eda5c1', 'deed',                   true,  1, '{"file_size_bytes":282951}'::jsonb),
  ('10000000-0000-0000-0000-0000000000a1', '090127cb-95fe-4292-87f2-ffb6c6b40e3a', 'bill_of_sale',           false, 1, '{"file_size_bytes":164049}'::jsonb),
  ('10000000-0000-0000-0000-0000000000a1', '2f52bdc9-c64a-4072-a2a1-47812c7eec80', 'ground_lease_assignment',false, 1, '{"file_size_bytes":381033}'::jsonb),
  ('10000000-0000-0000-0000-0000000000a1', '8019bd73-3595-4a11-a0be-c5b13b8620b6', 'escrow_instructions',    false, 1, '{"file_size_bytes":4495359}'::jsonb);

-- ── 2. Magnolia Park — Recap (mortgage retired -> MetLife preferred equity) ───
insert into public.transactions
  (id, primary_property_id, type, debt_event, close_date, counterparty, loan_id,
   verification_status, source_folder_path, narrative)
values
  ('10000000-0000-0000-0000-0000000000a2',
   'd4f08824-2d88-472d-b7aa-a703310c2aaf', 'recap', 'recapped', '2026-06-15',
   'MetLife (preferred equity)',
   null,
   'unverified',
   'V:\Magnolia Park Shopping Center\ACQ-REFI-DISP',
   'Existing mortgage paid off 06-15-26 and replaced by a MetLife preferred-equity position of $6,843,702.22 (Base Return SOFR+1.70%, 5% floor). Debt-to-equity recapitalization — no mortgage remains on the asset.');

insert into public.transaction_properties (transaction_id, property_id, is_primary) values
  ('10000000-0000-0000-0000-0000000000a2', 'd4f08824-2d88-472d-b7aa-a703310c2aaf', true);

insert into public.transaction_figures (transaction_id, label, value, basis, sort_order) values
  ('10000000-0000-0000-0000-0000000000a2', 'preferred_equity_amount', 6843702.22, 'final', 0);

-- ── 3. Knightdale (Consolidated) — Refinance (MetLife, cross-collateral) ──────
insert into public.transactions
  (id, primary_property_id, type, debt_event, close_date, counterparty, loan_id,
   verification_status, source_folder_path, narrative)
values
  ('10000000-0000-0000-0000-0000000000a3',
   '00000000-0000-0000-0000-000000000012', 'refinance', 'originated', '2024-01-25',
   'MetLife Real Estate Lending LLC',
   'c89bccc9-87e4-463f-ba0f-dae57ff41356',   -- the MetLife loan row
   'unverified',
   'V:\Knightdale\ACQ-REFI-DISP',
   '$34,000,000 MetLife refinance on the Knightdale Marketplace consolidated entity, cross-collateralized by KM East and KM West. Debt-yield / LTV covenants; DSCR ~2.5x at close.');

-- borrower entity (primary) + both collateral properties, mirroring the loan model
insert into public.transaction_properties (transaction_id, property_id, is_primary) values
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000012', true),
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000010', false),
  ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000011', false);

insert into public.transaction_figures (transaction_id, label, value, basis, sort_order) values
  ('10000000-0000-0000-0000-0000000000a3', 'loan_amount', 34000000.00, 'final', 0);

commit;

-- sanity: 3 transactions, 5 property links, 5 figures, 5 docs
-- select type, close_date, verification_status from public.transactions
--   where id::text like '10000000-0000-0000-0000-0000000000a%' order by close_date;

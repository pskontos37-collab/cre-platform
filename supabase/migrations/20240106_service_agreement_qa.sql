-- 20240106_service_agreement_qa.sql
-- Service-contract phase of the abstractor-v2 program: the /services tracker's
-- extracted fields (vendor, dates, auto-renewal, cancel notice, value) get an
-- adversarial document-verification pass (agreement-verify kind='svc') — the
-- tracker row IS the abstract; verification checks it field-by-field against
-- the contract's brief/text and stores the verdict here.

alter table public.service_agreements
  add column if not exists qa jsonb,
  add column if not exists qa_status text,
  add column if not exists qa_model text,
  add column if not exists qa_at timestamptz;

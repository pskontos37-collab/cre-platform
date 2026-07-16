-- 20240104_agreement_abstracts.sql
-- REA/PMA phase of the abstractor-v2 program (docs/abstraction-standard.md):
-- verified abstracts for property-level instruments. The agreement-abstract
-- edge fn synthesizes from doc_briefs of each agreement's source documents;
-- agreement-verify runs the adversarial second pass. Same column vocabulary
-- as lease_abstracts so the QA surfaces read identically.

alter table public.rea_agreements
  add column if not exists abstract jsonb,
  add column if not exists abstract_model text,
  add column if not exists abstract_generated_at timestamptz,
  add column if not exists qa jsonb,
  add column if not exists qa_status text,
  add column if not exists qa_model text,
  add column if not exists qa_at timestamptz;

alter table public.management_agreements
  add column if not exists abstract jsonb,
  add column if not exists abstract_model text,
  add column if not exists abstract_generated_at timestamptz,
  add column if not exists qa jsonb,
  add column if not exists qa_status text,
  add column if not exists qa_at timestamptz,
  add column if not exists qa_model text;

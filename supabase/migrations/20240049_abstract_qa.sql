-- 20240049_abstract_qa.sql
-- QA / verification layer for AI-generated lease abstracts.
--
-- The abstract-verify edge function re-reads the SAME governing PDFs the
-- abstractor used (source_doc_ids) and adversarially checks the stored abstract
-- against them — the human-in-the-loop assurance step the commercial tools sell,
-- without the silo or the license. Results land here:
--
--   qa         jsonb   the verdict (confidence, per-field checks, arithmetic,
--                      amendment-currency, fabrication risk, recommended fixes)
--   qa_status  text    verified | issues | review | null (never verified)
--   qa_at      timestamptz  when the last verification ran
--   qa_model   text    model that produced the verdict

alter table public.lease_abstracts add column if not exists qa jsonb;
alter table public.lease_abstracts add column if not exists qa_status text;   -- verified | issues | review | null
alter table public.lease_abstracts add column if not exists qa_at timestamptz;
alter table public.lease_abstracts add column if not exists qa_model text;

-- Regenerating an abstract invalidates any prior verdict; the edge function
-- clears these on regenerate, but this documents the intended lifecycle.
comment on column public.lease_abstracts.qa_status is
  'verified = every checked term confirmed against source; issues = a high-severity discrepancy/unsupported claim or failed arithmetic/amendment-currency check; review = only low/medium flags; null = not yet verified.';

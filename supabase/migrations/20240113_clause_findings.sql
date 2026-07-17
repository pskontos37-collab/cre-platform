-- 20240113_clause_findings.sql
-- Clause-specialist verify layer (abstract-clause-verify edge function).
--
-- The single verifier (abstract-verify) and the 2-lens ensemble
-- (abstract-ensemble) are GENERALISTS: one prompt spread across many fields.
-- They catch wrong scalar values well, but structurally cannot produce the
-- "the value is right but a material nuance is missing" finding, and they do not
-- carry deep per-clause domain rules (sequenced-option notice math, guaranty
-- release/replacement conditions, co-tenancy vs go-dark characterization,
-- exists=false on a lease whose exclusive would live in a missing exhibit).
--
-- abstract-clause-verify runs N single-clause SPECIALISTS concurrently, each
-- seeing only its own deep rubric plus the shared brief/MRI/registry evidence.
-- Prototype (Qdoba stress + Athlete's Foot control, 2026-07-17): 4/4 material
-- catches on the hard tenant the generalists missed; 0 false positives on the
-- clean tenant. See docs/clause-specialist-findings.md.
--
-- This is a SEPARATE provenance layer from:
--   - abstract.open_items   (generator self-report, write-time)
--   - qa / qa_status        (abstract-verify adversarial audit)
--   - field_confidence      (abstract-ensemble 2-lens cross-check)
-- so it never clobbers, and survives independently of, any of them.
--
-- Shape of clause_findings (jsonb):
-- {
--   "generated_at": ts, "model": str, "specialists": [str], "errors": [str],
--   "findings": [ {
--     "specialist": str, "field": str,
--     "verdict": "confirm|revise|cannot_verify|enrich", "severity": "high|medium|low",
--     "current_value": str, "correct_value": str|null, "missing_nuance": str|null,
--     "citation": str, "quote": str, "rationale": str,
--     "settled": bool,                       -- human already ruled on this field
--     "cross_model": { "verdict": str, "note": str } | null   -- OpenAI adjudication
--   } ],
--   "summary": { "run": n, "revise": n, "enrich": n, "cannot_verify": n,
--                "confirm": n, "actionable": n, "settled": n }
-- }
-- Each actionable finding's worklist key is 'field:' || lower(field) — identical
-- to keyForField in AbstractsPage.tsx / v_abstract_open_items / the ensemble
-- disagreements, so one resolution clears the generator open item, the verifier
-- check, the ensemble disagreement, AND the clause finding about the same field.

alter table public.lease_abstracts
  add column if not exists clause_findings       jsonb,
  add column if not exists clause_findings_model text,
  add column if not exists clause_findings_at    timestamptz;

comment on column public.lease_abstracts.clause_findings is
  'abstract-clause-verify: N single-clause specialist findings (verdict/severity/missing_nuance/quote per clause) + optional cross-model adjudication. Separate provenance layer from open_items (generator), qa (verifier), field_confidence (ensemble). See migration 20240113.';

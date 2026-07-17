-- 20240110_field_confidence.sql
-- Stage 2 of the parallel+ensemble abstraction upgrade
-- (docs/abstraction-parallel-ensemble-plan.md).
--
-- The abstract-ensemble edge function cross-checks the HIGH-STAKES fields of a
-- lease abstract with 2 independent, differently-framed model "lenses" and scores
-- their AGREEMENT with the stored value. The result is a per-field confidence map
-- + a disagreement list, stored here. This is a SEPARATE provenance layer from:
--   - abstract.open_items   (generator self-report, write-time)
--   - qa / qa_status        (abstract-verify adversarial audit)
-- so it never clobbers, and survives independently of, either.
--
-- Shape of field_confidence (jsonb):
-- {
--   "fields": {
--     "exclusives.exists":   { "abstract_value": str, "confidence": "high|medium|low",
--                              "agreement": "n/m",
--                              "lenses": [ { "lens": str, "verdict": "agree|disagree|cant_verify",
--                                           "correct_value": str|null, "citation": str, "quote": str } ] },
--     "term.expiration":     { ... }, ...
--   },
--   "disagreements": [ { "field": str, "abstract_value": str, "correct_value": str,
--                        "citation": str, "votes": "n disagree / m checked" } ]
-- }
-- Each disagreement's worklist key is 'field:' || lower(field) — identical to
-- keyForField in AbstractsPage.tsx and v_abstract_open_items, so one resolution
-- clears the generator open item, the verifier check, AND the ensemble
-- disagreement about the same field.

alter table public.lease_abstracts
  add column if not exists field_confidence       jsonb,
  add column if not exists field_confidence_model text,
  add column if not exists field_confidence_at    timestamptz;

comment on column public.lease_abstracts.field_confidence is
  'abstract-ensemble cross-check: per-field {confidence, agreement, lenses[]} + disagreements[]. Separate provenance layer from open_items (generator) and qa (verifier). See migration 20240110.';

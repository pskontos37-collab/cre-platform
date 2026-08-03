-- 20240182 — Backfill the two data corrections that accompany the 2026-08-02
-- generator fixes. Both are IDEMPOTENT: re-running finds nothing left to change.
--
-- Recorded as a migration because the repo must reflect prod (CLAUDE.md), and
-- because 20240178 set the precedent of recording exactly this kind of data
-- correction. Neither statement needs AI.

-- ── 1. qa_status re-derived from already-stored citation_check evidence ────────
-- The deterministic citation validator has been stamping citation_check onto each
-- verifier field_check for a while, but deriveStatus ignored it, on the theory
-- that a quote from an attached-but-untextracted PDF could legitimately sit
-- outside the searched corpus. Measured over all 69 QA'd abstracts, that theory
-- does not hold: unlocatable quotes run 20.5% where the ENTIRE source text fit
-- the verifier's 350K window and 20.7% where it was truncated, so the unsearched
-- tail explains none of it. 210 field_checks read verdict='confirmed' while their
-- quote could not be found anywhere in the sources (94 severity=high).
--
-- New rules (mirrored in supabase/functions/_shared/verifyStatus.ts):
--   HIGH-severity 'confirmed' + citation_check='not_found'  => issues
--   any citation_check in (not_found, quote_too_short)      => cannot be 'verified'
--
-- Monotone by construction: it can only move a row toward MORE scrutiny, never
-- less, so it is safe to re-apply. The qa jsonb is never modified, which means the
-- pre-change value stays recomputable.
--
-- Applied 2026-08-02: 27 rows moved — 26 review->issues, and Kay Jewelers
-- verified->issues. Kay Jewelers was the ONLY 'verified' abstract in the corpus
-- and it rested on 11 unlocatable quotes. Result: 52 issues / 17 review /
-- 0 verified.
with c as (
  select la.id, la.qa_status,
         bool_or(fc->>'verdict' = 'confirmed' and fc->>'citation_check' = 'not_found'
                 and fc->>'severity' = 'high')            as unsourced_high,
         bool_or(fc->>'citation_check' in ('not_found','quote_too_short')) as any_unverifiable
  from lease_abstracts la, jsonb_array_elements(la.qa->'field_checks') fc
  where la.qa ? 'citation_summary'
  group by 1, 2
), t as (
  select id, qa_status,
         case when unsourced_high                              then 'issues'
              when qa_status = 'verified' and any_unverifiable  then 'review'
              else qa_status end as new_status
  from c
)
update lease_abstracts la
   set qa_status = t.new_status, updated_at = now()
  from t
 where la.id = t.id and t.new_status <> t.qa_status;

-- ── 2. The x100 management fee, still present in stored abstracts ─────────────
-- management_agreements.mgmt_fee_pct STORES A PERCENT, not a decimal (Gateway
-- 1.75, KM 3.1, Magnolia 2.75) — the documented exception to the "percentages are
-- decimals" convention. 20240178 fixed the x100 at the producer, but 32 abstracts
-- REGENERATED AFTER IT still stored "mgmt fee 175.00%", and one stored
-- "300.00% / 275.00%". Per the abstractor's own comment that value reaches the UI
-- and the exported PDFs. Several abstracts had even self-flagged it ("likely a
-- data artifact", "CONFIRM this fee figure, appears anomalous").
--
-- Corrected by the six distinct bad tokens rather than by arithmetic, so the
-- change is auditable token-by-token and cannot touch anything else. The 3
-- abstracts already reading 3.10% are deliberately left alone.
--
-- LESSON: a producer fix does not backfill stored rows, and rows generated AFTER
-- a corrective migration can still carry the old bug if the edge function was
-- deployed later than the migration.
update lease_abstracts la
   set abstract = jsonb_set(la.abstract, '{rea_pma,pma_manager}',
                            to_jsonb(replace(replace(replace(replace(replace(replace(
                              la.abstract->'rea_pma'->>'pma_manager',
                              '310.00%','3.10%'), '300.00%','3.00%'), '275.00%','2.75%'),
                              '175.00%','1.75%'), '300%','3.00%'), '275%','2.75%'))),
       updated_at = now()
 -- ⚠️ ANCHORED with (^|[^0-9.]) ON PURPOSE. Unanchored, this pattern matches the
 -- "75%" inside a perfectly correct "1.75%" — during development that reported 22
 -- phantom findings (18 at 1.75% + 4 at 2.75%) and made the completed fix look
 -- like a failure. The same anchored pattern guards v_property_data_quality.
 where (la.abstract->'rea_pma'->>'pma_manager') ~ '(^|[^0-9.])([2-9][0-9]|[0-9]{3,})(\.[0-9]+)?%';

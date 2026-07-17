# Abstraction Pipeline — Parallel + Ensemble Upgrade Plan

**Author:** Claude · **Date:** 2026-07-16 · **Status:** DRAFT — awaiting user approval, nothing deployed.

Two goals, explicitly not a trade-off in this design:
1. **Latency** — cut per-abstract wall-clock (today dominated by sequential document briefing).
2. **Accuracy** — cross-check high-stakes fields with independent lenses; surface disagreement; verify clean verdicts; attach a confidence score to every field.

Enabling fact: the per-document work is embarrassingly parallel and cost is not the constraint, so we can fan out concurrently — which makes each request *faster* and simultaneously buys room to run accuracy layers *inside the freed latency* rather than on top of it.

---

## The problem (verified in code)

Both paths brief a tenant's documents strictly one-at-a-time:
- `scripts/batch_briefs.ps1:63` — `foreach ($doc in $need)` wrapping a blocking `while` that POSTs `doc-brief` and waits before the next doc.
- `src/pages/AbstractsPage.tsx:205` — `for (const d of toBrief) { await fetch('/doc-brief') }`.

Each `doc-brief` runs ~60–80 tok/s against a 150s edge wall (often multiple segments for large leases). A 30-document tenant therefore serializes into 15–25 min of Stage-1 time. Synthesis (`lease-abstract`) and audit (`abstract-verify`) are one call each — **not** the bottleneck. This is an orchestration limit, not a model-speed limit.

---

## Stage 1 — Parallelize the fan-out (latency)

No schema change, no model change, no change to brief *content*. Prerequisite for cheap ensembling.

### 1a. Frontend — `AbstractsPage.tsx` `onGenerate`/`generate` (~line 205)
- Replace the sequential `for … await` with a **bounded-concurrency pool** (K in flight; start K=8).
- Each document is one async task that **internally** loops on `done:false` (segment resume) with 429/529 backoff — preserving today's semantics. The pool runs K *documents'* tasks at once; a single doc's segments still run in order (avoids segment races).
- Small inline `pMap(items, K, fn)` helper (~15 lines, no new dependency).
- Phase text → `briefing 12/30 (8 in flight)`.

### 1b. Batch — `scripts/batch_briefs.ps1`
- PS 5.1 (no PS7 `-Parallel`): use a **runspace pool** or `Start-ThreadJob` (ThreadJob module) with throttle K; fall back to `Start-Job` if ThreadJob absent. Keep everything ASCII per repo rule.
- Parallelize **within a tenant** (across its docs) and optionally **across tenants**. Idempotency holds: `doc-brief` is resume-aware, keyed on `document_id` + `text_chars`; concurrent invocations on *different* docs are safe. Never two on the *same* doc (pool is per-doc).

### Ceiling & tuning
K is bounded only by API rate limits (raise tier as needed). The 150s edge wall is per-invocation and unaffected — parallelism is across invocations.

### Acceptance
- Benchmark a 20–30 doc tenant before/after (expect ~K× reduction in Stage-1 wall-clock; 30-doc target < 3 min).
- **Byte-identical brief output** vs sequential run (parallelism must not alter content).
- `segments_done` monotonic per doc (no races).

---

## Stage 2 — Ensemble + reconcile on high-stakes fields (accuracy)

Do **not** regenerate the whole abstract N times. Primary synthesis stays single-pass and authoritative; ensemble is a **field-scoped annotation + disagreement** layer.

### Fields (from the audit log's recurring defect classes)
- `exclusives` (exists · exact_language · beneficiary) — highest defect rate
- `options[].notice_by` · `status` · `exercise_evidence`
- `base_rent_schedule` (amounts; PSF×SF arithmetic)
- `amendment_currency` · `guaranty_chain` currency
- `expiration` · RCD

### Flow
1. `lease-abstract` runs once → full abstract (unchanged; source of record).
2. **New:** `abstract-ensemble` (or an extended `abstract-verify` mode) runs **2–3 independent extractors, concurrently**, each scoped to *only* the high-stakes fields, each with a **different lens** reading the same briefs:
   - **Lens A — beneficiary-test** (exclusives): is the covenant landlord-restricting *for this tenant*? Requires a quoted covenant; MRI flag / permitted-use / warranty insufficient (encodes the v27 hard rule).
   - **Lens B — MRI-reconciliation** (dates/rent/options): reconcile doc values against MRI `lease_options` + `rent_roll_rows`; flag doc-vs-MRI divergence.
   - **Lens C — chain-currency** (amendment/guaranty): latest operative instrument governs; is the primary's pick current?
3. **Reconciler** compares primary vs lenses per field:
   - Deterministic first (ISO-date equality, numeric equality within tolerance) — cheap, auditable.
   - Genuine semantic disagreement → one lightweight **judge** call picks best-cited value + writes rationale (judge, not naive vote — a shared prompt shares blind spots).
   - Outcome per field → `high` (all agree) / `medium` (primary + one lens) / `low` (dissent).
4. **Disagreement → existing ResolutionWorklist.** Write `abstract_item_resolutions` with the SAME `keyForField` convention (`field:<path>`) so it dedups with generator/verifier items and clears on correction. `kind='discrepancy'`, note carries competing values + citations.

Because lenses run in parallel, added latency ≈ **one** extra call, not N.

### Acceptance
- Pilot on known-hard exclusives tenants (Club Pilates, Old Navy, Nordstrom Rack, Athlete's Foot, B&N): the 3 residual exclusives land `low` confidence + queued; cured ones read `high`.
- Disagreements appear once in the worklist (no dup vs existing verifier items).

---

## Stage 3 — Verify clean verdicts + per-field confidence (accuracy + enterprise)

### 3a. Verify covers clean verdicts
Extend `abstract-verify` to confirm the high-stakes fields **even when the generator reported them clean** (closes the documented false-negative class — the audit only ever adversarially checked *defects*). Parallelism makes checking all high-stakes fields every run affordable.

### 3b. Confidence + provenance schema (the enterprise piece)
- **Migration** (⚠ verify next free number against disk + `list_migrations` + memory before claiming; memory currently says 20240110): add `field_confidence jsonb` to `lease_abstracts` — `{ field_path: { confidence, agreement:'n/n', lenses:[…], reconciled_by, citations:[…] } }`.
- **UI:** confidence chip beside each high-stakes field in `AbstractsPage` `AbstractView` and the PDF report; `low` auto-links to the worklist.
- **Portfolio stat:** extend `v_abstract_accuracy` to report the confidence distribution — this becomes the defensible accuracy metric (vs Prophia).

---

## Rollout order
1. **Stage 1** (no schema, low risk): deploy → benchmark 3 tenants → confirm identical briefs.
2. **Stage 2** on the pilot exclusives set → confirm disagreement queueing.
3. **Stage 3** + confidence UI.
4. Portfolio backfill (now parallelized) once pilot passes.

## Cost / latency envelope (honest)
- Stage 1: same tokens, ~K× faster wall-clock.
- Stage 2: +2–3 *field-scoped* calls per abstract (small — high-stakes fields only, not full abstracts), run in parallel → ~+1 call of latency.
- Stage 3: verify grows to cover clean fields → modest token increase.
- Money is not the constraint (user); latency stays low via parallelism.

## Risks & mitigations
- **Rate limits at high K** → raise API tier; K is tunable.
- **PS 5.1 concurrency** → ThreadJob/runspace (no PS7); test on the user's box (no node/python locally).
- **Early ensemble noise** → tune lens prompts on the pilot before portfolio.
- **Determinism/auditability** → primary abstract stays authoritative; ensemble only annotates + queues (never silently rewrites base fields). Mirrors the existing `applyOverrides` display-layer design.
- **Concurrent repo sessions** → scope commits tightly; new doc/migration files avoid conflicts.

## Deliberately unchanged
- Base abstract JSON authoritative; confidence + overrides are layers on top.
- Quote-grounding / `source_doc_ids` provenance.
- ResolutionWorklist (`abstract_item_resolutions`) as the single human surface.

# Refinement Roadmap — Hero Assets (Knightdale · Gateway · Magnolia)

_2026-07-02. Working document for the best-in-class push on the three hero assets.
Annotate freely — this is meant to collect your edits._

## Where the data actually stands (audited 2026-07-02)

| | Gateway | Magnolia | KM East | KM West | KM Consol. |
|---|---|---|---|---|---|
| GL months (penny-tied NOI) | 89 | 140 | 84 | 84 | — |
| Rent-roll snapshots | 1 | 1 | 1 | 2 | — |
| **Structured leases / units** | **0 / 0** | **0 / 0** | **0 / 0** | **0 / 0** | — |
| Loans (w/ covenants) | 1 | 0 (pref eq.) | 1 | 1 | 1 |
| Waterfall deals modeled | 2 | 2 | — | — | 2 |
| Management agreements | 2 | 6 | 1 | 1 | — |
| Documents in corpus | 1,537 | 3,045 | 1,356 | 794 | 1,156 |
| Appraised value (for LTV) | — | — | — | — | — |

**The big structural gap:** the lease-level model (leases, units, options, co-tenancy,
percentage rent) is empty everywhere. Everything leasing-related currently rides on flat
rent-roll snapshots. The source documents (every lease + amendment) are already in the
corpus — they just haven't been abstracted into structured rows.

## Documents / exports needed FROM YOU (not on V:/K: or not exportable by me)

1. **Most-recent appraisals** for all three (KM: the 2024 MetLife refi appraisal;
   Gateway: 2025 lender/buyout appraisal; Magnolia: 2026 recap appraisal if one exists).
   → Unlocks LTV on the debt widget and value tracking.
2. **2026 approved operating budgets** (MRI budget export, or the approved budget Excel,
   per property). → Unlocks budget-vs-actual variance — the #1 monthly AM workflow.
3. **Monthly MRI exports going forward** (or a recurring calendar reminder to drop them):
   GL (MRI_GENLEDG), rent roll (MRI_CMROLL), and **A/R aging**. A/R aging unlocks the
   delinquency widget, which is currently dark.
4. **Tenant sales reports** for percentage-rent tenants (unlocks pct-rent breakpoint
   tracking, currently dark).
5. **CAM reconciliation workbooks** (2024–2025 recs per property) → CAM recovery
   tracking + reconciliation status widget.
6. **Current insurance program summary** (carriers, limits, premiums, renewal dates)
   → renewal critical dates + PMA insurance-compliance checks.
7. **Real estate tax bills / assessment notices** (current year) → tax appeal deadlines.
8. Optional: **Argus or underwriting models** if maintained → forward-looking NOI vs
   the platform's trailing NOI.

## What I can self-serve (no action needed from you)

- **Ingest the rest of V:/K: for the heroes** — so far only TENANTS + Management
  Agreements + entity docs are ingested. Missing: Knightdale `ACQ-REFI-DISP` (incl. the
  2024 MetLife refi docs — may contain the appraisal), `OPERATIONS`; Magnolia + Gateway
  `OPERATIONS`, `ACCOUNTING`; the K: working-file trees for Gateway/Magnolia.
- **Lease abstraction → structured model.** Pipeline: per tenant, run the existing
  `lease-consolidate` engine over the corpus → write `leases`/`units`/`lease_options`
  rows + push option/expiration dates into `critical_dates`. This is the single highest-
  value build; it lights up rollover-by-tenant, option notice windows, co-tenancy
  monitoring, real WALT, and an expirations calendar.
- **Search precision** (in flight — see below).
- **In-browser document viewing**: mirror hero-asset PDFs into Supabase Storage so
  search results open with one click instead of copy-paste path (also enables preview
  panes). Storage cost is modest; can be done per-property.

## Prioritized roadmap to best-in-class

| # | Item | Why | Needs |
|---|---|---|---|
| 1 | **Lease abstraction into structured model** | Turns the doc corpus into an operating system: options, co-tenancy, rollover, WALT, critical dates | Self-serve |
| 2 | **Search precision v5** | Reranked, sectioned retrieval — precise answers | Self-serve (in flight) |
| 3 | **Finish hero-asset V:/K: ingestion** | Complete document coverage incl. refi/appraisal docs | Self-serve |
| 4 | Budget vs actual + monthly data cadence | The core monthly AM workflow | Your #2, #3 |
| 5 | LTV / valuation layer + a real Loans page | Complete the debt picture | Your #1 |
| 6 | Delinquency + CAM + pct-rent modules | Currently dark widgets → live | Your #3, #4, #5 |
| 7 | One-click document viewing (Storage mirror) | UX polish; removes copy-paste step | Self-serve |
| 8 | Insurance & tax critical dates | Round out the obligations calendar | Your #6, #7 |
| 9 | **Your review feedback** | The product owner pass | You |

## Search precision — what changed (v5, live)

1. **Intent parsing** (tenant / property / document-kind) routes queries to targeted
   folder+title search before semantic search.
2. **Reranking**: an LLM pass now scores every candidate for "does this actually answer
   the question" (cosine similarity only measures "same topic") and drops the noise.
3. **Section-level embeddings**: the 102 long curated abstractions (PMAs, JV agreements,
   closing binder) are being split into heading-level sections, each with its own
   embedding — so "emergency spending authority" lands on §5 of the right PMA instead
   of vaguely matching the whole document.

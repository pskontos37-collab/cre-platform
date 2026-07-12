# Transactions — Record of Closed Deals (Design Spec)

_Status: DESIGN — not yet built. Author handoff for the acquisition / refinance / recap / disposition
record. Consolidates the design discussion of 2026-07-07._

## 1. What this is (and isn't)

A **record of closed transactions** — institutional memory for the lifecycle events of each owned asset:
acquisitions, refinancings, recaps, and dispositions. One row per event, anchored to the property, with
verified headline economics and **direct, certain access to the governing source documents**.

**It is NOT** a deal pipeline / CRM, prospective underwriting, or an AI-summary layer. We link the *real
PDFs*; we do not let a generated summary stand in for a document.

### Guiding principle: curate, don't retrieve
Everywhere else, documents surface via fuzzy semantic search (`doc-ask` / `doc-search`). That is wrong for a
transaction record — "the settlement statement for the Gateway buyout" cannot be a similarity guess. Each
transaction links an **explicit, verified set** of `documents` rows (a join, not a query). Verify once; the
page shows exactly those materials thereafter.

### Certainty has three independent axes
1. **Authenticity** — each linked doc is the real, correct file (link integrity, fingerprint, version).
2. **Completeness** — this is the *whole* record, not a partial binder (manifest reconciliation).
3. **Accessibility** — the user can actually open it now (`viewable` ≠ `searchable`).

All three must be *visible on the page*, not assumed.

## 2. Data model

Migrations start at **`20240055`** (through `20240054` is used; note the historical double-use of `20240053`).

### `transactions`
| Column | Notes |
|---|---|
| `id` uuid pk | |
| `primary_property_id` uuid → properties | timeline anchor |
| `type` enum | `acquisition` \| `refinance` \| `recap` \| `disposition` |
| `debt_event` enum null | `assumed` \| `originated` \| `paid_off` \| `recapped` — sub-classification so a loan assumption rides *inside* an acquisition rather than forcing a separate row |
| `close_date` date | |
| `counterparty` text | buyer/seller free-text (see §7) |
| `loan_id` uuid → loans null | refi/assumption points at the single-sourced loan row |
| `narrative` text | short "why we did this deal" |
| `verification_status` enum | `unverified` \| `verified` \| `issues` (reuses the abstract-QA `QaBadge` grammar) |
| `verified_by` / `verified_at` | stamped on human sign-off |
| `superseded_by` uuid → transactions null | restatement chain (§6) |
| `source_folder_path` text | authoritative `V:\<prop>\ACQ-REFI-DISP\...` path |
| `source_manifest` jsonb | snapshot of the folder's file list + count at ingest (§ completeness) |

### `transaction_properties` (many-to-many — REQUIRED)
`transaction_id`, `property_id`, `is_primary bool`. A single deal spans properties (MetLife loan is
cross-collateralized across KM East + West + Consolidated 012; Knightdale is a Consolidated entity). Mirrors
the existing `loans.collateral_property_ids` pattern. **Portfolio ledger totals dedupe on `transaction_id`**,
so a cross-collateral refi counts once, not thrice. Respect the standing rule: don't double-count Knightdale
via entity 012.

### `transaction_figures` (named, cited amounts — NOT a single `amount`)
`transaction_id`, `label` (e.g. `contract_price`, `net_cash_to_close`, `total_basis`, `loan_amount`),
`value numeric`, `document_id`, `page_number`, `basis` enum (`preliminary` \| `final`).
Rationale: "purchase price" is three different numbers (contract / net cash / basis) and settlement statements
get restated post-close. Every figure traces to a doc + page and is marked preliminary vs final.

### `transaction_documents` (the curated doc set)
`transaction_id`, `document_id`, `role` (controlled vocab, §3), `is_key bool`,
`linked_version int`, `fingerprint jsonb` (`{file_name, file_size_bytes}` captured at link time),
`sensitivity enum` (`normal` \| `restricted`, §5).
Link by `document_id` **and** fingerprint so re-ingest drift is detectable; link the version executed at close
and flag if `documents.superseded_by` has since grown (don't auto-follow to newest).

## 3. Document role vocabulary + expected-key checklist

Each type declares its expected key docs; the page renders present/absent, so a **missing settlement
statement shows as a red gap**, not silent absence (same "surface the gaps" philosophy as abstract-QA /
services).

| Type | Expected key docs |
|---|---|
| Acquisition | PSA, deed, settlement/closing statement, title policy, loan assumption (if any) |
| Refinance | loan agreement, note, mortgage/deed of trust, payoff letter, closing statement |
| Recap | equity agreement, amended JV/OA, closing statement |
| Disposition | PSA, deed, settlement statement, payoff letter |

## 4. Certainty on the page

- **Link integrity** — UUID + captured fingerprint; amber flag if `file_name`/`file_size_bytes` drift or a
  `superseded_by` chain appears. `file_size_bytes` is already populated at ingest — no pipeline work.
- **Completeness** — reconcile three numbers from `source_manifest` vs corpus vs links:
  _"48 files in source folder · 46 ingested · 9 marked key"_. Divergence is shown ("2 source files not yet in
  app"), turning completeness from assumption into a displayed fact.
- **Accessibility — two badges per doc**: 🔍 `searchable` (from `documents.is_indexed`) and 📄 `viewable`
  (actual storage-object presence check — the mirror has run ahead/behind, e.g. 8,118/8,759, and ~40% of docs
  are scanned/not-OCR'd). Never assume "in corpus ⇒ opens." View PDF uses client-side `createSignedUrls`
  (storage.objects RLS policy, migration 20240042).
- **Verified figures** — headline numbers render with a citation chip → doc + page; click opens the PDF at
  that page (`document_chunks.page_number`).

## 5. Sensitivity / access

Closing binders carry the most sensitive material in the app — wire instructions (active fraud target),
guarantor SSNs/EINs, personal financials. Two levels:
- **RLS inheritance** via `can_access_property` governs who sees the transaction at all.
- **`transaction_documents.sensitivity = 'restricted'`** hides specific rows (wire instructions, personal
  financials) from non-admin/AM roles even when they can see the transaction. Everything else defaults
  `normal`.

## 6. Immutability & restatement

Closed facts are history. Once `verified`, economics lock. Material corrections create a **restatement row**
referencing the original via `superseded_by` (mirrors the corpus `documents.superseded_by` model) — preserving
the prior figure and the reason — rather than silently mutating. Trivial typo fixes stay in-place + audited
(`audit_log` already auto-triggers). This is more honest for a *record* than in-place editing.

## 7. Integration edges (link, don't duplicate)

- **Refi ↔ loans**: `documents.loan_id` already exists; `transactions.loan_id` added. Loan docs already tagged
  with `loan_id` **auto-nominate** into the doc set. Covenant/DSCR stays single-sourced in `loans`.
- **Counterparties**: normalize *lender* names and link to `loans` so the debt side is queryable
  ("every deal with MetLife"); buyers/sellers stay free-text for a ~20-property firm.
- **Disposition ↔ waterfall** (deferred): a sale is the dated distribution event `runIrrWaterfall` consumes;
  `close_date` + proceeds are the inputs. Shape for it, don't wire it yet.
- **Cost-basis chain** (deferred): acquisition price → basis → +capex → gain at disposition. Natural future
  home; don't let its absence block the schema.

## 8. Population workflow — review, not transcription

Manual keying is where certainty dies. Reuse the extractor pattern (abstract-QA / service-agreements /
brokerage): an **"extract from binder" assist** reads the settlement statement / loan agreement, **proposes**
figures + nominates key docs; a human confirms → `verified`. Population becomes review.
- **Seed by hand (known economics):** Gateway acquisition ($103,478,461.14; $88.98M assumed NY Life + ~$14.5M
  cash; seller DPPC Holdings; closed 10-28-25 — binder's 68 PDFs already ingested); Magnolia recap (mortgage
  paid off 6-15-26 → $6,843,702.22 MetLife pref); KM MetLife cross-collateral refi.
- **Draft the rest** from each property's `ACQ-REFI-DISP` folder (already on the self-serve ingest list).

## 9. Presentation

- **Per-property lifecycle timeline** on `PropertyDetailPage` — acquired → refinanced → recapped → (sold);
  each node expands to verified figures + key docs. The "story of the asset."
- **Portfolio ledger** at `/transactions` — filter by type/year/property/verification status; totals by type
  (deduped on `transaction_id`).
- **Doc tiering** — Key Documents (cited, checklist-backed) up top; full binder expandable. Each row:
  role · View PDF · source path · 🔍/📄 badges · sensitivity lock.

## 10. Out of scope (v1)

Deal pipeline/CRM · prospective underwriting · re-abstracting docs into AI summaries · disposition→waterfall
wiring · cost-basis/gain computation.

## 11. Build phasing

1. **Migration `20240055`** — tables/enums above; RLS via `can_access_property`; audit triggers.
2. **Seed** the three known deals (hand-entered, `verified`).
3. **`/transactions` ledger page** + `useTransactions` hook (PostgREST select validated live, dedupe on id).
4. **`PropertyDetailPage` timeline** section.
5. **Doc panel** — curated links, 🔍/📄 badges, View PDF (signed URL), completeness reconciliation, sensitivity.
6. **Extract-from-binder assist** (edge fn, reuses extractor pattern) — draft remaining deals for confirmation.
7. Ingest remaining `ACQ-REFI-DISP` folders so linked docs are viewable.

Deploys (`deploy_vercel.ps1` / `deploy_edge.ps1`) and `apply_migration` require explicit per-turn user
authorization.

## 12. Open decisions (recommendations)

1. **Sensitivity model** — _recommend_ role-based `restricted` flag on sensitive doc rows (§5), not
   property-RLS alone.
2. **Figures** — _recommend_ named multi-figure model (§ `transaction_figures`), not a single headline
   `amount`.
3. **Manifest source** — _recommend_ snapshot folder listing at ingest (always available in-app) with a
   re-scan action, over live V:\ reconciliation (machine-bound).
4. **Auto-nominate** — _recommend_ auto-link all ingested folder docs as the binder + auto-flag likely key
   docs for confirmation, over hand-picking from scratch.

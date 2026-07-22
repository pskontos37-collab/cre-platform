# Construction & Contingency Dates — Scope (2026-07-21)

## Problem

The critical-events ledger (mig 20240117-121) is deterministic from **structured**
data only: lease expirations, option notices, loan dates, PMA dates. Construction-phase
and contingency dates exist **only in the lease documents** and are tracked nowhere:

- Tenant plan submittal deadlines ("Tenant shall submit plans within 60 days of delivery")
- Landlord plan-approval windows (landlord must approve/reject in N days — LANDLORD obligation)
- Permit contingencies / outside dates (permits by X or either party may terminate)
- Delivery-of-possession deadlines (landlord delivers by X or tenant gets abatement/termination)
- Construction commencement / completion outside dates
- Tenant opening deadlines (open for business by X; often gates rent commencement & co-tenancy)
- TI-allowance requisition deadlines (requisition by X or tenant forfeits the allowance)
- Rent-commencement outside dates (RCD formula triggers, e.g. earlier-of open / N days after delivery)

Sales-kickout terminations are ALREADY tracked (termination_rights, mig 20240072,
Rights Radar) but never materialize as **dated** rows on the Critical Dates widget.

## Honest value assessment (read before approving spend)

The portfolio is stabilized retail — for most of the ~77 active leases these dates are
**historical** (tenant opened years ago). The ledger design handles this correctly
(`obligation_class='historical'` = retained for audit, excluded from alerts). The live
payoff is concentrated in:

1. **Recently signed / in-buildout leases.** Barnes & Noble (Knightdale E) is live TODAY:
   delivery 2/9/26 → buildout expiration **7/24/26** = RCD outside date, three days from
   this spec's date. That date exists only because a human backfilled it by hand on 7/12.
   This feature makes that systematic.
2. **Every future deal/amendment** — dates land automatically at ingest+abstract time.
3. **Completeness/audit answer** — "are you checking leases for permit contingencies,
   plan submittal dates…" becomes yes, with evidence links.

If the demo needs a live example, Barnes & Noble is it.

## Architecture — follows the existing trust-layer pattern exactly

AI never writes operational dates directly. AI extracts → **structured rows with
evidence** → the **deterministic generator** materializes ledger events. Same shape as
lease_options → generator, termination_rights → radar.

```
lease PDFs (document_chunks kind='text' + doc_briefs)
   │  extract_construction_dates.ps1  (report-first → -Load; Batches API)
   ▼
lease_construction_dates          ← NEW structured table (evidence + provenance)
   │  critical_event_generator v4 (additive loop; deterministic)
   ▼
critical_events                   ← existing ledger (mig 20240117)
   ▼
active_critical_events → CriticalDatesWidget (already reads the ledger, P1d-c)
```

### 1. Migration (ONE migration: table + generator v4 + vocab)

Number = next free at build time — verify migrations ledger + disk + `list_migrations`
per protocol (20240123 as of 2026-07-21 late; 20240122 is on disk unapplied).

`lease_construction_dates`:

| column | notes |
|---|---|
| id, lease_id (FK), property_id (FK) | |
| obligation_type | enum-check: `plan_submittal` \| `plan_approval` \| `permit_contingency` \| `delivery_deadline` \| `construction_completion` \| `opening_deadline` \| `ti_allowance_request` \| `rcd_outside_date` |
| obligor | `tenant` \| `landlord` \| `either` — who owes the performance |
| trigger_event, offset_days, fixed_date | formula-based dates: "60 days after delivery"; `computed_date` derived when the trigger is dated, else conditional |
| computed_date, window_earliest/latest | |
| remedy | text — what happens on miss (termination right? abatement? forfeiture? self-help?) |
| grants_termination | boolean — drives `obligation_class='legal'` |
| status | `open` \| `satisfied` \| `lapsed` \| `waived` \| `historical` |
| source_document_id, source_page, source_quote | VERBATIM evidence — required for every extracted row |
| extraction_model, extraction_confidence, extracted_at, human_verified | provenance; Verified = human-only per audit posture |

RLS: select via `can_access_property`, write `is_admin_or_am()`; new-RPC/anon rule per
mig 20240098 (`revoke from public, anon`). Same posture as every recent table.

Generator v4: additive loop over `lease_construction_dates` (keep v3 loops byte-identical).
`dedupe_key = 'construction:<id>'`. Mapping:
- status open + date in future → `obligation_class` = `legal` if grants_termination else `operational`
- satisfied/lapsed/historical → `historical` (audit-retained, never alerts)
- undated formula rows (trigger not yet occurred) → `is_conditional=true`, no computed_date
  (ledger supports this; they surface when dated, not before)
- `reconciliation_status`: `no_mri` for all types except `rcd_outside_date`, which
  cross-checks `leases.commencement_date` (MRI-fed) → `match` / `deterministic_differs_from_mri`
- `generated_by='import'` (AI-sourced provenance, distinct from 'deterministic')

Bonus loop (same migration, zero extraction cost): materialize **termination_rights**
rows that carry a dated window (`window_end`, incl. sales-kickout exercise windows) as
`event_type='termination_window'` events, `dedupe_key='termright:<id>'`. Deterministic
from an existing human-reviewable table; puts kickout windows on the dashboard.

### 2. Extraction script — `scripts/extract_construction_dates.ps1`

Clone of extract_landlord_reminder_provisions.ps1 mechanics: per active lease, pull the
verbatim text layer (document_chunks kind='text' via lease_abstracts.source_doc_ids,
else documents by tenant/property; ~50k-char cap **prioritizing work-letter/exhibit and
construction-article chunks**), fall back to doc_briefs where text is thin. Ask for the
8 obligation types with verbatim quote + doc + page per hit, explicit
`tenant_open_and_operating` classification so stabilized leases come back historical.

- Report-first (`.jsonl`, resumable) → human skim → `-Load` writes rows + runs generator.
- Bulk sweep via **Message Batches API** (offline job, ~50% cheaper — per standing
  feedback), Sonnet. Then an **Opus confirmation pass only on rows classed live or
  grants_termination** (the few that will actually alert) — mirrors the cross-model
  hardening philosophy from clause-verify at a fraction of the cost.
- Known gaps to report honestly: ~4 leases with no text layer (un-OCR'd, from the 7/12
  reminder run); Bucket-B tenants with missing base leases/work letters (KPOT, Wild
  Wings, Good Feet, Elase…) → `cannot_extract` rows listed as DOC GAPS, not silently skipped.

### 3. UI (small)

CriticalDatesWidget already renders unknown event types via `DEFAULT_STATUS_OPTIONS` +
raw-type fallback, and already reads the ledger. Polish:
- `DATE_LABELS` entries for the 8 types + `termination_window`
- per-type `STATUS_OPTIONS`: e.g. plan_submittal → Received·Waived(reason);
  permit_contingency → Satisfied·Terminated·Waived(reason); opening_deadline →
  Opened·Waived(reason); termination_window → Lapsed·Exercised·Ignored(reason)
- an "AI-extracted" pill when `generated_by='import'` && !human_verified (consistent
  with the VerificationBadge philosophy: visible but honest about provenance)
- AbstractsPage: construction-dates rows listed in the abstract detail (read-only v1)

## Cost & effort

Anchored on observed comparable runs (clause-verify = $1.14/tenant, 4 Opus specialists;
landlord-reminder Sonnet run = trivial):

| item | est. |
|---|---|
| Sonnet batch sweep, ~77 active leases (~100 abstracts) | ~$3–6 |
| Opus confirm pass on live/termination positives (est. 10–30 rows) | ~$5–10 |
| **Total AI spend** | **~$10–15** (firm up at build) |
| Build effort | ~2–3 sessions: (1) migration+generator+widget, (2) script+golden-set, (3) portfolio batch+review |

## Validation plan (golden set)

- **Barnes & Noble** — must reproduce the hand-backfilled chain: delivery 2/9/26 →
  buildout exp 7/24/26 RCD outside date, live, from the Certificate of Delivery +
  lease work letter. THE acceptance test.
- **Bober Tea / Bad Daddy's / CONDADO** (Magnolia) — formula-based RCD, no executed CDA
  in file: must come back as formula rows (`is_conditional` or historical), NOT invented dates.
- **2–3 stabilized anchors** (e.g. Kohl's, PetSmart) — construction articles present but
  tenant long open: everything must class `historical`, zero new live alerts.
- **A kickout tenant** from termination_rights with dated window → termination_window
  event appears with correct window.
- Acceptance: 0 fabricated dates (every row quote-verifiable), 0 live alerts on
  stabilized controls, Barnes & Noble chain reproduced.

## Risks / open decisions

1. **Alert gate for AI-extracted live dates** — REC: surface immediately with the
   "AI-extracted" pill (missing a real permit outside date is worse than showing an
   unverified one); per-type status dropdown = the human resolution path. Stricter
   alternative: hold in `needs_review` until human_verified — rejected by default
   because it recreates the two-stores-disagree problem the ledger exists to kill.
2. **Model strategy** — REC: Sonnet sweep + Opus confirm on live positives (above).
   All-Opus alternative ≈ $30–40, buys little on historical rows.
3. **Kickout materialization** — REC: include (deterministic, free, directly answers
   the original question).
4. **Population scope** — REC: all active leases on the 4 demo properties (= effectively
   the whole portfolio per corpus state).
5. Mostly-historical yield is a feature, not waste (audit trail), but set expectations:
   expect a handful of live rows, dozens of historical ones.

Out of scope: email alerting (RESEND blocked), VTS, any auto-apply/auto-correct,
abstract-schema changes (this deliberately does NOT touch the abstractor/ensemble).

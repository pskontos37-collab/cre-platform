# M&J Wilkow Lease Abstraction Standard

**Status: v1 — 2026-07-12.** This document is the firm's methodology for AI lease abstraction.
The `doc-brief` and `lease-abstract` edge-function prompts are distilled from it; when this
document and a prompt disagree, fix the prompt. It exists because a lease abstract is only
useful if it is *trustworthy* — an abstract that is 95% right and silent about which 5% is
wrong is worse than no abstract.

---

## 1. What an abstract is, and the failure that kills trust

An abstract is a structured restatement of the **current effective deal** between landlord and
tenant, with a citation trail. It is not a summary of documents — it is a synthesis of an
instrument *chain*, where later instruments amend, restate, or void earlier ones.

The four failure classes observed in production (2026-07 audit, 98 abstracts):

1. **Coverage failure** — "NOT FULLY REVIEWED" (91/98). A document was truncated, so a term was
   guessed or omitted. *Structural cause:* single-call design with a character budget.
2. **Inventory failure** — "MISSING FROM FILE" for documents that exist (90/98 flagged; e.g.
   BCBS executed SNDA present in the acquisition binder while the abstract claimed missing).
   *Structural cause:* retrieval caps + folder-biased scoring.
3. **Taxonomy failure** — correspondence/default notices in `lease_documents` (23/98),
   other tenants' exclusives in the tenant's `exclusives` field (13/98 with no exclusive
   language), one flat guarantor field that can't represent succession.
4. **Integration failure** — MRI option notice deadlines, RETAILRR exercise state, REA and PMA
   context all in the database and never fed to the abstractor.

The rebuild addresses each structurally, not with prompt exhortation.

---

## 2. Pipeline architecture (map → reduce → verify)

**Stage 1 — Document briefs (`doc-brief`).** Every document in a tenant's file gets its own
extraction pass that reads **100% of the text** (giant instruments are walked in segments and
merged). Output: a structured *brief* — classification, parties, execution status, dates,
defined terms set/changed, rent tables, options, clause inventory with verbatim operative
language, cross-references to other instruments. Briefs are stored (`doc_briefs`) and reused;
a document is re-briefed only when its text changes.

**Stage 2 — Synthesis (`lease-abstract`).** The abstract is assembled from briefs (not raw
truncated text), the full file inventory, MRI cross-checks (`leases`, `lease_options`,
`rent_roll_rows`), and property-level instruments (`rea_agreements`, `management_agreements`).
Because every operative instrument was fully read in Stage 1, "NOT FULLY REVIEWED" is no
longer a normal outcome — it survives only for documents whose brief genuinely failed.

**Stage 3 — Verification (`abstract-verify`).** An adversarial second model on the strongest
tier re-reads the primary sources and tries to refute every material value. Plus deterministic
checks (arithmetic, date sequencing, option-notice reconciliation vs MRI).

**Stage 4 — Human lock.** Review & correct → lock. Locked abstracts are the accuracy ground
truth (v_abstract_accuracy) and are never regenerated automatically.

---

## 3. Source hierarchy and date governance

Authority order when instruments disagree (highest first):

1. Executed lease + executed amendments, in chain order (**the latest amendment IS the lease**);
   executed Commencement Date Agreements / Lease Supplements / Acknowledgments of Commencement
   (these FIX formula dates).
2. Executed option-exercise notices and confirmations (they roll the term).
3. Executed guaranties, assignments, SNDAs, estoppels.
4. MRI system-of-record — **governs current-term window, and supplies the RCD when no executed
   commencement instrument is in the file** (see below).
5. Landlord summaries, CAM/RET reconciliations, control sheets, correspondence — corroboration
   only; never override 1–4.

### Date rules (the "noting dates properly" standard)

- Every date field holds a **bare ISO date (`YYYY-MM-DD`) or null. Never prose.** Basis and
  commentary go in the companion `basis`/`section`/note fields.
- **Rent Commencement Date (RCD):**
  - If an executed CDA / Lease Supplement / Acknowledgment states it → use it (`basis: "executed
    commencement instrument"`).
  - Else → **use the MRI RCD** from the rent roll / RETAILRR (`basis: "MRI system of record"`).
    MRI billing history is authoritative evidence of when rent actually commenced; the firm
    provides it for exactly this purpose.
  - A lease-formula projection ("240 days after delivery of possession") is **never** presented
    as the RCD. It may be recorded in the basis note, with an open item only if it materially
    contradicts the MRI date.
- **Original commencement vs current term:** both are reported, separately labeled. MRI
  `commencement/expiration` = current-term window (correct, not a conflict with the original
  lease commencement).
- **Expiration:** the latest executed instrument that extends/resets the term governs;
  cross-checked against MRI current-term end. Disagreement → DISCREPANCY open item naming both.

---

## 4. Document taxonomy (what belongs in "Lease Documents")

Every file document is classified in its brief:

| Class | Examples | Abstract treatment |
|---|---|---|
| `operative_instrument` | Lease, amendments, CDA/lease supplement, assignment & assumption, termination, executed option-exercise notice | The lease-documents chain, in execution order |
| `ancillary_executed` | Guaranty, SNDA, estoppel, license agreements, MOL | Listed separately under the chain |
| `notice_correspondence` | **Default notices**, past-due letters, force-majeure letters, address changes, broker emails | **NEVER in lease_documents.** Material events (e.g. uncured default, exercised kickout) surface in notes/open items with the source named |
| `financial_operational` | CAM/RET recons, sales reports, invoices, budgets | Corroboration only |
| `property_level` | REA/OEA/declarations, PMA | Feed §8, cited as "on file at property level" |
| `draft_unexecuted` | Drafts, redlines, unsigned copies | Excluded from the chain; noted only if no executed copy exists |

A **default notice is a fact about lease administration, not a lease document.** It never
appears in the instrument chain.

### "Missing" discipline

"MISSING FROM FILE" may be asserted **only after a targeted corpus search for that instrument
type has run and come back empty** (the synthesis request includes a dedicated ancillary-
instrument sweep across the whole property corpus — tenant folders, acquisition binders,
closing sets). If the instrument is anywhere in the corpus, it is IN the file. If a document
is in the file but its brief failed, that is "BRIEF FAILED: <doc>", not missing.

---

## 5. Clause education — the distinctions the abstractor must hold

### 5.1 Permitted use ≠ exclusive use ≠ use restrictions (three different clauses)

- **Permitted use** — what THIS tenant may do in its premises ("solely for the operation of a
  full-service restaurant…"). Defines the tenant's operating scope. Often paired with
  operating covenants and named-brand requirements.
- **Tenant's exclusive (protection FOR the tenant)** — a covenant BY LANDLORD restricting
  *other* occupants ("Landlord shall not lease space in the Center to any other business whose
  primary use is…"). Abstract: the protected use, carve-outs (existing leases, anchors, REA
  parcels, size thresholds), conditions (tenant must be operating, not in default), and
  **remedies** (rent abatement %, alternative/substitute rent, termination right, cure period).
  The remedy is the economics — never omit it.
- **Use restrictions ON the tenant (burden)** — *other tenants'* exclusives and the property's
  prohibited-use schedule as they bind THIS tenant (typically via an exhibit: "Existing
  Exclusives", "Use Restrictions", Exhibit D/G/H…). These are NOT the tenant's exclusive.
  Kirkland's Exhibit D and Yard House Exhibit H both burned us here: exhibits listing OTHER
  tenants' protections were abstracted as the tenant's own exclusive.

**Test before filling `exclusives`:** does the quoted language restrict *the landlord/other
tenants* for this tenant's benefit? If it restricts *this tenant*, it belongs in
`use_restrictions_on_tenant` or `prohibited_uses`. If the tenant's own protection can't be
quoted, `exclusives.exists` is **not** set true on the strength of an MRI note code.

### 5.2 Options and notices (the option lifecycle)

An option is a lifecycle, not a row: **granted → (notice window opens) → exercised / lapsed /
renegotiated → term rolls**.

- **Grant**: instrument + section; count, length, rent basis (fixed table, FMV w/ arbitration,
  CPI). Later amendments frequently VOID and REGRANT options (BCBS 4th Amd voided prior rights
  and granted a new single option) — the current grant is the latest one.
- **Notice mechanics**: the *deadline date matters more than the period*. Abstract both: the
  contractual period ("no later than 180 days prior…") and the **computed notice-by date**
  for each open option. MRI RETAILRR is the firm's system of record for option notice dates —
  the synthesis payload includes `lease_options` (notice_deadline, is_exercised) and the
  abstract must carry those dates, flagging any disagreement with its own computation.
- **Exercise evidence**: an executed exercise notice in the file, an amendment reciting
  exercise, or MRI showing the rolled term. An exercised option's period IS the current term —
  it stops being a future option and the remaining options renumber accordingly.
- **Landlord-reminder obligations**: some leases require LANDLORD to notify tenant of the
  approaching deadline (anchor leases especially) — capture as a flag, it creates a duty.
- Whether option rights survive assignment / are personal to the named tenant — capture when
  stated.

### 5.3 Guaranty succession (assignments change who stands behind the lease)

One flat guarantor field cannot represent reality. The abstract carries a **guaranty chain**:

- Original guaranty: guarantor, instrument/date, scope (full, capped, "good-guy", burn-off
  conditions).
- **Every assignment**: does the assignor (and its guarantor) remain liable, or is it released?
  Post-2008 market standard is original guarantors remain jointly liable after assignment
  unless expressly released — silence means *not released*. Does the assignee deliver a
  **replacement guaranty**? (This is the complaint: replacement guarantors per
  assignments/amendments were not reflected.)
- Amendments can reaffirm (Select Comfort 1st Amd §9), replace, or release a guaranty;
  bankruptcy/restructuring amendments (Regal/Cineworld) often re-cut the guaranty — check the
  amendment's guaranty section every time.
- Output: `guaranty_chain[]` with per-event status, and a derived **current guarantor(s)**
  line. A guarantor is asserted only from an executed guaranty or an instrument reciting one —
  never inferred from a franchise/parent relationship.

### 5.4 Co-tenancy

Opening co-tenancy (conditions to opening/RCD) vs **operating co-tenancy** (ongoing). Capture:
the trigger precisely (named anchors vs percentage of GLA; "operating" definitions), the
**remedy ladder** (alternative rent — % of sales in lieu of fixed rent — then termination
right after a cure/continuation period), landlord's replacement-tenant rights, and how the
remedy interacts with percentage rent. Note anchors that are REA parcel owners rather than
tenants (their "operating" status is judged under the REA, not a lease).

### 5.5 Kickout / termination rights

Who holds it (tenant sales kickout, landlord recapture, either-party), the measurement window
and sales threshold, the exercise window ("one-time right within 60 days after Year 5 sales
statement"), payback obligations (unamortized TI/commissions), and the notice date arithmetic.
These are option-grade critical dates and land in `critical_dates`.

### 5.6 Percentage rent

Rate(s), **natural vs artificial breakpoint** (artificial = stated dollar amount; natural =
annual fixed rent ÷ rate — verify the arithmetic), gross-sales definition highlights
(exclusions: returns, employee sales, online-order treatment), reporting cadence, audit
rights, and *in-lieu* structures (co-tenancy alternative rent, restructuring deals like
Regal's tiered % in lieu). Later amendments frequently reset breakpoints per period — the
schedule is per-period, not a single number.

### 5.7 CAM / taxes / insurance

Methodology (pro-rata vs fixed w/ escalator; Regal's fixed-CAM schedule), the denominator
(leased vs leasable vs "floor area of the Center", anchor/REA-member exclusions), admin/mgmt
fee cap, cap structure (cumulative vs non-cumulative, compounding, controllable-only),
exclusions list, audit rights and look-back, tax appeal cost pass-through and the tenant's
right to compel appeal, insurance types/limits required of tenant + waiver of subrogation.

### 5.8 Ancillary instruments

- **SNDA**: the lease's *obligation* to deliver one (timing) is a different fact from an
  *executed* SNDA in the file (lender, date). Both are captured, separately.
- **Estoppel**: delivery obligation (days, permitted reliance) vs executed estoppels on file
  (which are also *evidence* — a certified expiration date in an estoppel corroborates or
  contradicts the chain, at hierarchy level 3).
- **Assignment/subletting**: consent standard (sole discretion / not-unreasonably-withheld /
  permitted transfers to affiliates/franchisees without consent), recapture-on-request,
  transfer-premium splits, and the guaranty consequences (§5.3).

### 5.9 Other retail clauses always checked

Radius restriction (distance, whose sales count, remedy), continuous operations / go-dark
(and landlord's recapture trigger on going dark), signage (pylon/monument position, exhibit),
parking ratios and protected areas, relocation (size/location limits, who pays, refusal
right), purchase options / ROFR / ROFO on the parcel (ground leases especially), rooftop/
telecom, delivery/loading restrictions, hazardous-use limits.

---

## 6. REA / PMA integration (property-level instruments)

- **REA/OEA**: if the property has one and the premises/center is subject to it, the abstract
  states: agreement name/date, whether the tenant's parcel is IN the REA or the tenant merely
  benefits/burdens through the center's obligations, anchor operating covenants relevant to
  this tenant's co-tenancy math, REA-driven CAM contributions that shape the denominator, and
  use restrictions imported from the REA. REA members (Kohl's, Target, PH Developers…) own
  their parcels — they have REA obligations, NOT leases; never abstract them as tenants.
- **PMA**: the abstract notes the current manager and the management-fee context from
  `management_agreements` (e.g. admin-fee caps in the lease vs management fee actually charged
  under the PMA) so CAM admin-fee review reads against the real fee structure.
- Both are cited as "on file at property level" — never "missing" because they live outside
  the tenant folder.

---

## 7. Grounding, provenance, and open items

- Every concrete value traces to a brief quote/citation or an attached PDF. Values the
  documents don't state are null + open item — never estimated, never padded.
- MRI is a labeled source: values taken from MRI say so (`basis: "MRI"`); values contradicting
  MRI raise DISCREPANCY items scoped to the fields MRI governs (current-term dates, SF, suite,
  current rent, pct-rent flag).
- Open-item prefixes (unchanged): `MISSING FROM FILE:` (only after the §4 sweep),
  `NOT FULLY REVIEWED:` (brief failed only), `CONFIRM:`, `DISCREPANCY:`.
- Every date in the abstract that creates a future duty (option notice-by, kickout window,
  co-tenancy cure, expiration) is ALSO emitted in `critical_dates` for the workflow engine.

---

## 8. Honesty clause — what this system is and is not

Verification-first AI abstraction with human lock-off is the industry-leading *architecture*
(pure-AI vendors advertise accuracy; the credible ones all pair extraction with human QA).
**No abstraction system — AI or human — is 100% accurate with zero human review**, and this
standard does not pretend otherwise. What it guarantees instead:

1. Every document fully read (briefs, no truncation).
2. Every value cited or flagged — errors are *self-announcing*, never silent.
3. An adversarial second pass on every abstract.
4. A measured accuracy number (v_abstract_accuracy) against human-locked ground truth, so the
   claim "this is accurate" is a statistic, not a promise.

The lock workflow is not an apology — it is the mechanism that makes the accuracy number real.

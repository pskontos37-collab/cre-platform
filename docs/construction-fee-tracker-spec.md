# Construction Management Fee Tracker — Design Spec (v2)

**Status:** spec / not yet built. Companion to [construction-fee-gl-convention.md](construction-fee-gl-convention.md).
**Model:** an **active review queue** (not passive watchdog, not auto-biller). Capex invoice distributions flow into an inbox; the PM assigns each to a project or excludes it; the system computes the fee, generates a billing packet for accounting, and reconciles. PMs keep accruing the fee in MRI (per user constraint); the platform reads data and computes/prompts/reconciles, it does not post entries.

## 1. Data source — the AVID distribution report (driver)

- The PM submits an **AVID report of paid invoices on a daily or weekly basis** (daily preferred — a weekly batch makes the 7-day SLA "up to 7 days after the batch").
- Report is **split by distribution** — one row per invoice × GL code, with the distribution amount. Confirmed available.
- **Ingestion rule:** for each distribution row, if the GL code is a **capex account**, create a queue item. Otherwise ignore.
  - Capex accounts: KM/Mag `1202-00`, `1267-01`, `1321-00`, `1322-00`, `1234-00`; Gateway `155300`, `149800`. (Any new capital/CIP account → still queue; surfaces in review.)
- **Required report fields:** vendor, invoice #, invoice/payment date, property, GL code, **distribution amount**, **line description** (carries the `[JOB# CODE]` tag), **invoice image link** (for backup). Basics exist today; GL-code split confirmed; *confirm line description + image link are exportable.*
- MRI GL is NOT the driver — it remains the periodic true-up / NOI source and a secondary reconciliation check.
- **Why AVID, not GL:** continuous (supports the 5/7-day timers) and carries the invoice image for backup. The GL feed is batch and its lines aren't linked to invoice images.

## 2. Tag as pre-classifier (not a competing path)

Parse the distribution's line description: `^\[\s*(?<job>\S+)\s+(?<code>CAP|LLW|SOFT|REPL|ALLOW|FEE)\s*\]`.
- Tagged → item arrives **pre-assigned** to its project + pre-typed; PM confirms in one click.
- Untagged → lands in `Open` for full triage.
- The tag reduces manual work and is what makes any auto-action (§6) safe (only pre-classified items qualify).

## 3. Queue item state machine

`Open` → **Assign to project** | **Exclude** (reason required, audit-logged, reversible) | **Waiting** (reason required)
- `Waiting` > 5 days → auto-return to `Open`. Re-Waiting restarts the timer but is capped: after 3 Waiting cycles → escalate instead of allowing another.
- `Open` > 7 days (no PM review) → **escalation** (see §6).
- Excluded items are retained (visible under an "Excluded" filter) for audit; re-open is allowed and logged.

## 4. Project

One project = one `JOB#` within a property. Auto-created on first assignment; multiple invoice distributions assign to it.
Lifecycle: `Accumulating` → `Fee calculated` → `Invoice generated / sent to accounting` → **`Accrued / Reconciled`** (matching fee payment/accrual observed — see §8).
KM adds an optional **budget** + **completion** flag (its fee is earned only at completion, within owner-approved budget).

## 5. Fee computation (per verified PMA regime — from `management_agreements.terms.construction_fee`)

- **Gateway / Magnolia (`tiered_per_draw`):** marginal tiers (0% ≤$10k, 5% $10,001–125k, 3% >$125k) on the project's **cumulative** eligible basis. Each billing = tiered fee on cumulative basis **minus fees already billed** (the prior-fee check — stateful; requires the billing ledger §7). Basis = distributions tagged/classified `CAP` or `LLW`; `REPL` excluded here.
- **KM E/W (`flat_at_completion`):** 5% × eligible basis; `REPL` (roof/HVAC replacement) **is** eligible at KM. Earned only when project marked complete and within owner-approved budget; over-budget portion earns nothing. Until then shows "accruing — not yet due."
- **Minimum thresholds:** KM no fee if project total < $5,000; Gateway/Magnolia first $10k earns $0. If below threshold, item is **not billable yet** — PM chooses **Waiting** (accumulate) or **Exclude** (reason). Never force exclusion (a small project may cross the threshold as invoices post).
- **Excluded from basis always:** `SOFT`, `ALLOW`, `FEE`, plus noise (opening balances, reclasses, PIS, accruals). Credits/reversals (negative distributions) reduce the basis and can trigger a fee adjustment.

## 6. Escalation (the 7-day trigger)

**Recommended: escalate, do not auto-bill.** Auto-generating a fee bill on an unreviewed, unclassified item risks charging the owner/partner wrongly (e.g., a replacement or soft cost) — an outward-facing error that's hard to reverse. So:
- Red dot on the sidebar icon while any item is `Open` (count of the current user's pending items).
- `Open` > 7 days → notify the AM/controller + open a `/tasks` item for the PM.
- *Optional, only if desired:* auto-generate a draft fee bill **solely** for items that arrived tag-pre-classified and unambiguous — never raw items. **[DECISION PENDING: escalate-only vs. auto-draft-for-tagged.]**

## 7. Billing packet ("send to accounting")

On PM action, generate a **fee billing packet**: fee amount + **calculation methodology** (show the tier math / prior-fee offset), payer = owner entity (from PMA who-pays), payee = M&J Wilkow, and the **contractor invoices attached as backup** (from the AVID image links). Records a `capex_fee_billings` row (project, basis, fee, date).
**Delivery: in-app handoff/queue to accounting recommended** over auto-email (emailing on the user's behalf is a per-action confirm; an in-app packet the PM forwards is simpler and auditable). **[DECISION PENDING: email vs. in-app handoff.]**

## 8. Reconciliation (fee can still slip at the accounting step)

Because accrual is manual, watch for the fee actually being processed: the **payment to M&J Wilkow appears as a vendor line in the AVID report** (and/or the `FEE`-tagged line in MRI GL). When it matches a generated billing → project → `Reconciled/Closed`. Until then: "billed, awaiting accrual." Variance (expected vs processed) beyond a small rounding tolerance → flag.

## 9. Data model (proposed)

- `capex_queue_items` — one per capex distribution row: `(id, property_id, source_ref, vendor, invoice_no, invoice_date, gl_account, amount, line_description, image_url, job_no?, code?, status, status_reason, waiting_count, project_id?, excluded_reason, created_at, updated_at)`. Status ∈ open/waiting/assigned/excluded.
- `capex_projects` — `(id, property_id, job_no, name, type, budget?, is_complete, completion_date, notes)`.
- `capex_fee_billings` — `(id, project_id, basis_amount, cumulative_basis, fee_amount, methodology jsonb, packet_document_id, generated_by, generated_at, reconciled_at)`.
- All reasons/exclusions/status changes → `audit_log`.

## 10. UI

- `/construction-fees` (sidebar, **red dot when Open items exist**): tabs/filters Open · Waiting · Assigned · Excluded · Reconciled. Inbox rows with vendor/amount/account/description; assign-to-project, exclude (reason), waiting (reason). Project view: assigned invoices, computed fee (with methodology), prior fees, generate-packet button, reconciliation status.
- Dashboard widget: "Unbilled CM Fees" — total + oldest, by property (mirrors A/R aging).

## 11. Scheduler

Nightly job (pg_cron / edge fn): Waiting>5d → Open; Open>7d → escalation; Waiting-cycle>3 → escalation. Clocks start from queue-entry (payment date on the report), independent of MRI GL cadence.

## 12. Open decisions
1. **7-day behavior** — escalate-only (recommended) vs. auto-draft for tagged items.
2. **Billing delivery** — in-app handoff (recommended) vs. auto-email to accounting.
3. Confirm the AVID report can export **line description** + **invoice image link** (GL-code split already confirmed).
4. KM budget/completion capture UI.
5. Reconciliation tolerance (rounding on tiered math).

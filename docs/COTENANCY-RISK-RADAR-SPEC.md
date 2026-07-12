# Co-Tenancy Risk Radar — Implementation Spec

**Status:** 🚀 DEPLOYED 2026-07-11 — migration 20240072 applied (live RPCs carry two
post-apply patches, synced back into the migration file: min_named_open/condition_logic
respected in the trigger test, and kickout lapse applies to ANY passed window even for
recurring tests), data loaded 56/56 abstracts, frontend on cre-platform-mjw2.vercel.app.
First real finding: Michaels @ KM East triggered (90% occupancy clause vs 88.4% actual,
$225,792/yr exposed) → pending flag in the dashboard review queue.
**Operational cadence:** run `reconcile_option_notices.ps1` (report) after every corpus
sync and MRI RR load; `-Load` applies high-confidence exercised fixes.

---

## 1. Problem

The dashboard "Co-Tenancy Alerts" widget is present-day only *and has never fired*:
`co_tenancy_clauses` and `co_tenancy_flags` both contain **0 rows**. The widget reads
`co_tenancy_flags where status='pending_review'` — nothing writes to that table.

Meanwhile the intelligence already exists, unstructured:

| Input | Where it lives today |
|---|---|
| Clause terms (thresholds, named anchors, remedies) | `lease_abstracts.abstract->'co_tenancy'` — **29 abstracts** with `exists=true` (33 with language): Magnolia 10, KM East 10, Gateway 7, KM West 2. Plus verbatim `document_chunks` (kind='text'). |
| Anchor leases + expirations | Rent roll (`leases`) — e.g. Gateway Kohl's exp 2029-01-31, Ross KM East exp 2027-01-31 |
| Renewal options + notice deadlines | `lease_options` (MRI RETAILRR-reconciled) |
| Occupancy per property | Computable: `units.rentable_sf` vs active leases (Gateway 85.2%, KM East 88.4%, KM West 100%, Magnolia 84.3%) |

**Critical lesson from scoping (2026-07-11):** the structured option data is STALE and
must not be trusted blind. Initial scoping flagged Ross @ KM East as "notice deadline
2026-08-04, unexercised" — **wrong**: Ross exercised on 11/24/2025 (term now runs to
1/31/2032), and the notice PDF was already ingested in the corpus
(`NTC LTR-LSE Ext-Ross (11-24-25).pdf`, doc ec606378) but nothing propagated it into
`leases.expiration_date` / `lease_options.is_exercised`. Same pattern at KM East for
Kay Jewelers (Sterling, exercised 10/23/25 → exp 12/31/2031), Wells Fargo (10/14/25 →
exp 10/31/2031), Subway #37092 (6/10/26), and Starbucks @ KM West (10/2/25). This is
why §4.5 (exercise-notice reconciliation) is mandatory, not optional. Gateway Kohl's
(notice 2028-07-31, exp 2029-01-31, no newer notice found) remains a genuine Watch-tier
candidate.

## 2. Why the existing schema can't hold real clauses

`co_tenancy_clauses` (20240004) models one `named_tenant_id` and one `remedy` enum.
Real clauses in this portfolio are compound:

- "at least **2 of** Buy Buy Baby, HomeGoods, A.I. Friedman, Kohl's open" (Ulta)
- "Target **AND** at least 2 of PetSmart/Ross/Michaels/Academy" (HomeGoods KM East)
- "less than 2 of Whole Foods/Target/Kohl's open **and/or** <65% of Rentable Area
  (excluding Anchor space and Building III) open" (Warby Parker)
- Multiple stacked remedies: alternate rent (5% gross sales / 50% base) → go dark →
  terminate after N days.

## 3. Phase 1 — Structure the clauses

### Migration `20240072_cotenancy_clauses_v2.sql`

```sql
-- Named-anchor conditions: many per clause, incl. non-rent-roll anchors
create table co_tenancy_named_tenants (
  id            uuid primary key default uuid_generate_v4(),
  clause_id     uuid not null references co_tenancy_clauses(id) on delete cascade,
  tenant_id     uuid references tenants(id) on delete set null,  -- null if not our tenant
  tenant_label  text not null,          -- as written in the lease ("Kohl's", "Target")
  is_rea_member boolean not null default false,  -- KM East Target / KM West Kohl's: status not derivable
  created_at    timestamptz not null default now()
);

alter table co_tenancy_clauses
  add column min_named_open      integer,           -- "at least 2 of [named list]"
  add column occupancy_basis     text,              -- 'total_gla'|'ground_floor'|'shops_excl_anchors'|...
  add column condition_logic     text default 'and',-- how named + occupancy combine: 'and'|'or'
  add column conditions          jsonb,             -- non-computable nuances (exclusions, SF floors, cure detail)
  add column remedies            jsonb,             -- ordered remedy ladder [{type, rent_pct|desc, after_days}]
  add column verbatim_language   text,              -- exact clause text from abstract/chunks
  add column source_abstract_id  uuid references lease_abstracts(id) on delete set null,
  add column extraction          jsonb,             -- raw model output for audit
  add column human_verified      boolean not null default false;
-- keep legacy remedy/remedy_rent_pct as the PRIMARY remedy for backward compat
```

RLS: `co_tenancy_clauses` select policy exists from 20240009; add select policy for the
new junction table (mirror clause policy via lease→property). Loader uses service role.

### Extraction — `scripts/extract_cotenancy_clauses.ps1`

Same pattern as `extract_notice_addresses.ps1`:

1. Candidate set = union of: abstracts with `co_tenancy->exists=true`, abstracts with
   non-null `exact_language_and_remedies`, leases with `has_co_tenancy_clause=true`
   (29/33/27 — reconcile all three).
2. Per lease: feed abstract co_tenancy JSON + top verbatim chunks (kind='text' scored
   on co-tenancy terms: "co-tenancy", "open and operating", "alternate rent",
   "inducement", "go dark") to Claude API → structured JSON matching the schema above.
3. Write JSONL for human review (`-Extract` → review → `-Load` upserts). Tenant-name →
   `tenant_id` resolution via `tenants.name/trade_name/file_aliases`; unresolved anchors
   load with `tenant_label` only (and `is_rea_member` heuristic: 0-SF lease or no lease).
4. Idempotent: keyed on `lease_id`; re-run refreshes non-human-verified rows only.

**Phase 1 deliverable UI:** clause grid on `/clauses` (new "Co-Tenancy Radar" section
alongside the existing clause matrix + semantic search) — property, protected tenant,
condition summary, remedy ladder, verbatim expander. First time all ~29 clauses are
visible in one place.

## 4. Phase 2 — Risk engine

### RPC `co_tenancy_risk(p_property_ids uuid[])`

Pure SQL, computed live (no cron, never stale). Returns one row per clause:

| column | notes |
|---|---|
| clause_id / lease_id / property_id | protected tenant's clause |
| tier | `triggered` \| `high` \| `watch` \| `ok` \| `unknown` |
| reasons | jsonb array of human-readable reason strings |
| named_at_risk | anchors driving the tier (label, expiration, notice_deadline) |
| occupancy_pct / threshold_pct | property occupancy proxy vs clause threshold |
| exposed_annual_rent | protected lease's current annual base rent (what drops to alternate rent) |

### Tier logic

- **triggered** — condition fails *today*: a named (non-REA) anchor has no active lease,
  or occupancy < threshold. (Whether this auto-writes a `co_tenancy_flags` row is
  decision #1, §8.)
- **high** — named anchor lease expires ≤ 12 mo with renewal option unexercised, **or**
  option `notice_deadline` ≤ 90 days out and unexercised, **or** occupancy within 2 pts
  of threshold.
- **watch** — anchor expires 12–24 mo (unexercised), or occupancy within 5 pts.
- **unknown** — condition rests solely on REA-member anchors (`is_rea_member`) whose
  operating status we can't derive → "monitor manually" chip.

Occupancy source: `sum(rentable_sf where active lease) / sum(rentable_sf)` per property —
same basis as the dashboard occupancy widget.

### §4.5 Exercise-notice reconciliation (MANDATORY — added after the Ross miss)

The corpus receives option-exercise / extension / non-renewal notices via the nightly
storage sync, but nothing updates the structured lease data from them. The risk engine
must therefore never treat `is_exercised=false` as ground truth on its own:

1. **Reconciler script** (`scripts/reconcile_option_notices.ps1`): scan `documents` for
   notice docs (file_name patterns `LSE Ext|LSE Renewal|Renewal Option|Exercise.*Option|
   Non-Renewal` + AI-title patterns `exercis|extend|renew`), match to tenant/lease
   (tenant_id is often NULL on these docs — resolve via title + property + alias),
   compare notice date/terms vs `lease_options.is_exercised` and `leases.expiration_date`.
   Emit a discrepancy report; `-Load` applies corrections (sets `is_exercised`, updates
   expiration, links `documents.tenant_id`). Run after every corpus sync / RR load.
2. **Risk-engine guard**: when an unexercised option drives a High/Watch tier, the RPC
   checks for a newer matching notice doc; if found, tier drops to `stale-data` with a
   "notice on file — structured data not updated" chip instead of a false alarm.
3. Known backlog from the 2026-07-11 audit (all KM, all already in corpus, all stale in
   structured data): Ross → 1/31/2032, Kay Jewelers → 12/31/2031, Wells Fargo →
   10/31/2031, Subway #37092 (terms in notice), Starbucks KM West (terms in notice).
   Related: data-delivery memory's "9 KM tenants stale expirations vs amendments."

### Honest limitations (displayed in UI, not hidden)

1. Clauses measure **"open and operating"**; we know **"leased."** A dark-but-paying
   anchor is invisible. (Phase 3: per-tenant operating-status toggle.)
2. Clause GLA denominators vary (ground-floor-only, exclusions) — property occupancy is
   a proxy; `occupancy_basis` is stored and shown next to the number.
3. REA anchors (KM East Target exp 2065, KM West Kohl's exp 2073 — both 0-SF rows) are
   not rent-roll tenants; two-Targets rule applies (do not conflate with Gateway Target).

### UI

- **Dashboard widget** (`CoTenancyWidget.tsx`, key `co_tenancy` in `dashboardWidgets.ts`,
  currently `def:false`): two sections — "Triggered" (existing flags flow, confirm/dismiss
  intact) + "At Risk" (RPC rows, tier badge, countdown chip, exposed rent). Consider
  flipping to `def:true` for the AM preset after launch.
- **/clauses** — Co-Tenancy Radar grid (Phase 1) gains tier chips (Phase 2).
- **PropertyDetailPage** — co-tenancy card: this property's clauses + risk status.

## 5. Phase 3 (optional, later)

- `tenant_operating_status` toggle (open / dark / closed) editable by PMs → closes the
  "leased ≠ operating" gap and lets the engine catch dark anchors.
- REA-anchor watch list with manual status + notes.
- Auto-flag writes + email/notification on tier escalation.

## 6. Verification plan

- SQL spot-checks against known clauses: J.Crew (75% + WF/Target named), Ulta (2-of-4
  named + 200k SF floor), Warby Parker (2-of-3 anchors and/or 65%), HomeGoods KM East
  (Target AND 2-of-4). Ross/KM East must surface as **ok/exercised** (exercised
  11/24/2025 → exp 1/31/2032) once the reconciler has run — if it shows High, the
  reconciliation leg is broken. Gateway Kohl's as **watch/high** depending on horizon.
- Browser-verify widget + /clauses on prod after deploy.
- Deploys: migration via `apply_migration` (requires same-turn deploy permission),
  frontend via `scripts/deploy_vercel.ps1`.

## 7. Effort

| Work | Size |
|---|---|
| Migration 20240072 + RLS | small |
| Extraction script + review + load (~29 leases) | ~½ session |
| /clauses radar grid | ~½ session |
| Risk RPC + widget upgrade + property card | ~1 session |

## 8a. Termination Rights Radar (added 2026-07-11, same build)

Sibling engine to the co-tenancy radar, same pattern, covering tenant-held EARLY
termination rights — surfaced regardless of stated expiration (user direction: a tenant
who can terminate on notice today is live exposure even if their lease runs years more).

- **Data**: 50 of 98 abstracts carry `termination_kickout` language. Structured into
  `termination_rights` (migration 20240072) by the same extraction script
  (`scripts/extract_lease_rights.ps1`), typed as:
  - `sales_kickout` — terminate if gross sales below a floor; measured against **TTM
    sales from `pct_rent_records`** (window anchored on latest reported month, same
    basis as the Health Ratio widget)
  - `fixed_window` — one-time date window
  - `ongoing_notice` — terminate any time on N days' notice (**always shown while open**)
  - `cotenancy_termination` — the termination rung of a co-tenancy remedy ladder
- **RPC `termination_risk()`** tiers: `triggered` (sales below floor) / `high` (within
  10% of floor) / `watch` (within 25%, or window opens ≤12 mo) / `open` (window or
  notice right currently exercisable) / `unknown` (kickout with no reported sales) /
  `lapsed` / `informational`.
- **Lapse rule (user direction 2026-07-11):** one-time kickouts (e.g. "lease year 5")
  are DEAD once their measuring/exercise period passes — tier `lapsed`, never alarmed.
  `recurring` kickouts ("any lease year", rolling 12 months) never lapse. The loader
  dates undated one-time kickouts from lease commencement ("lease year N" → window =
  commencement+N years, +9 months reporting/notice grace); undatable one-time kickouts
  tier `unknown` for manual dating, and future windows cap at `watch` (early tracking,
  not exercisable yet).
- **UI**: second table in the Rights Radar (/clauses radar mode + property card);
  `open`/`triggered`/`high` rows also feed the dashboard widget's At Risk section.

## 8b. Build status (2026-07-11)

- ✅ `scripts/reconcile_option_notices.ps1` — built AND run (report mode): 10 candidate
  docs in 24-month window, 1 discrepancy (Burlington @ Gateway, exercised 4/16/26 →
  1/31/2032, high confidence) staged in `scripts/option_notice_reconciliation.jsonl`
  for `-Load`.
- ✅ Migration `20240072_lease_rights_radar.sql` — written, NOT applied.
- ✅ `scripts/extract_lease_rights.ps1` — built; extraction run 56/56 ok, 0 fail →
  `scripts/lease_rights.jsonl`: 29 co-tenancy clauses, 92 termination rights
  (58 other/contingent → informational tier, 26 cotenancy_termination, 6 sales_kickout,
  1 fixed_window, 1 ongoing_notice); `-Load` pending migration.
- ✅ Frontend — `hooks/useLeaseRights.ts`, `components/RightsRadar.tsx`, /clauses
  "Rights radar" mode, CoTenancyWidget At-Risk section + auto-flag sync call,
  PropertyDetailPage card. NOT deployed.
- Decisions taken (user: "do all of them"): auto-flag ON; all three surfaces.

## 8. Open decisions (blocking build)

1. **Auto-flag on trigger?** When a condition currently fails, should the engine insert
   a real `co_tenancy_flags` row (enters confirm/dismiss + audit flow; needs dedup via
   partial unique index on `(co_tenancy_clause_id) where status='pending_review'`) — or
   stay display-only until a human confirms? *Recommend: auto-create — that's what the
   existing widget flow was designed for, and dismiss is one click.*
2. **Surface area:** dashboard widget only, or also the /clauses radar grid + property
   card? *Recommend: all three — the grid is nearly free once the table is populated.*

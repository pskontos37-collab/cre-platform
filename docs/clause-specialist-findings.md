# Clause-specialist verify — validation results (2026-07-17)

`abstract-clause-verify` (migration 20240113) runs N single-clause SPECIALISTS
concurrently — each sees only its own deep domain rubric plus the shared brief +
MRI + exclusives-registry evidence — instead of the generalist 2-lens ensemble.
Specialists shipped v1: **exclusives, options, guaranty, co-tenancy/continuous-ops**.
Optional cross-model (OpenAI) adjudication runs on high-severity findings to break
the shared single-model-family blind spot. DETECTION ONLY — findings flow to the
human worklist keyed `field:<path>`; no auto-correct.

## Prototype + live validation (2 tenants)

Run against the same brief evidence the ensemble uses. Cost: ~$1.14/tenant at 4
specialists (Opus) + a few cents cross-model.

### Qdoba (KM West) — stress test. 4 NEW material catches the generalists missed.

| Clause | Current pipeline (qa verifier + ensemble) | Clause specialist | 2nd model |
|---|---|---|---|
| **Exclusives** | `exists=false` **"confirmed"** (qa); ensemble 2/2 **high** | **cannot_verify (high)** — the tenant's own exclusive would live in "Exhibit E – Prohibited *and Exclusive* Uses," referenced but not in the file. A confident `false` is unsupported. | confirm |
| **Options** | ensemble flagged empty `[]`; its own proposed fix put **both** renewals at `2034-08-31` | **revise (high)** — sequenced options can't share a notice date; the 5th renewal runs off the *4th* renewal's expiry → **~2039-08-31**. Catches an error the ensemble would have baked in. | confirm |
| **Guaranty** | `guarantor.name` **"confirmed"**; ensemble 2/2 **high** | **enrich (high)** — name right, but the guaranty can **evaporate**: Rolphs released at 14+ stores; whole group released on a $10M replacement guarantor; entire guaranty **null & void** if no Closing Notice by 2025-12-31. | confirm |
| **Co-tenancy** | not checked at all; abstract stored `exists=true` | **revise (high)** — it's a **go-dark waiver + landlord recapture right**, not a tenant co-tenancy protection; the stored value overstates tenant protection. | confirm |

The OpenAI cross-model adjudicator independently **confirmed all four** high-severity findings.

### Athlete's Foot (KM East) + Barnes & Noble (KM East) — controls. 0 false defect claims.

- **Athlete's Foot** — 5 confirm; affirmed the genuine athletic-shoe exclusive
  (explicitly noting it's fully quoted, *not* in a missing exhibit — the opposite
  call from Qdoba); only actionable item is the known 1-day option→MRI reconciliation.
- **Barnes & Noble** — 5 confirm, 0 revise, 0 cannot_verify; 2 additive `enrich`
  nuances (medium). No false defect claims on clean data.

## Why it lifts accuracy

The single biggest win is the **`enrich` verdict** — "the value is right but a
material nuance is missing" — which the pass/fail generalist verifier structurally
cannot produce. Guaranty release/replacement/void conditions and clause
mischaracterization (co-tenancy vs go-dark) are the recurring, high-consequence
classes it surfaces. The lift on the hard tenant came with zero false positives on
the clean ones.

## Cost / posture

- ≈ 2× the ensemble at 4 specialists (~$1.14/tenant → ~$115 for a full 100-tenant
  pass). Gating: a specialist is skipped when its clause is absent (`present`
  test) or the field is human-settled (locked / override / resolution).
- Cross-model adjudication capped at 8 high-severity findings/run.
- Detection only → worklist. No auto-correct (auto-apply proven unsafe).

## Architecture

`abstract-clause-verify/index.ts` mirrors `abstract-ensemble` plumbing (overrides
applied before audit, sticky-decision suppression, briefs/MRI/registry context,
exclusives-ownership registry guard). Writes its own `clause_findings` provenance
column (never clobbers open_items / qa / field_confidence). Surfaced in
`AbstractsPage.tsx`: "Clause check" button, `ClauseBadge`, `ClauseFindingsPanel`,
and actionable findings merged into the unified worklist (origin `clause`, keyed
`field:<path>` so one resolution clears every layer).
Rollout: `scripts/batch_clause_verify.ps1`.

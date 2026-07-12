# Coding Capital Invoices — Construction Management Fee Tag

**Who:** Property managers coding/approving invoices in AVID.
**When:** Any invoice coded to a **capital account** (list below).
**Why:** So the system can automatically compute the construction-management fee for each project, prompt you to bill it, and flag any that get missed. Fees currently slip through the cracks because nothing watches them — this tag turns that watching on.

---

## The one rule

When you code an invoice line to a capital account, **start the description with a tag**:

```
[<JOB#> <CODE>] then your normal description
```

**Example:** `[240117 LLW] HomeGoods storefront — pay app 5 of 8`

Everything after the `]` you can write exactly as you do today.

---

## The two pieces

### 1. JOB# — the project number
- Use the **same number on every invoice for the same project**, start to finish.
- Reuse the contractor's job number if there is one (e.g. `240117`), or assign your own. Format doesn't matter — it only has to be **consistent and unique per project**.
- This is what lets the system group a project's many checks together and total it.

### 2. CODE — what the line is (pick one)

| Code | Use it for | Earns a fee? |
|---|---|---|
| `CAP` | Capital improvement — building or site work | Yes |
| `LLW` | Landlord work inside a tenant space | Yes |
| `SOFT` | Architect, engineer, permits, drawings, design | **No** |
| `REPL` | Like-for-like replacement (roof, HVAC unit, glass, caulking) | Gateway/Magnolia: **No** · Knightdale: Yes |
| `ALLOW` | Tenant allowance / amount reimbursed to a tenant | **No** |
| `FEE` | The construction-management fee accrual itself | Excluded — but **tag it so the system knows the fee was taken** |

> **Tag the FEE line too.** Keep accruing the fee exactly as you do now — just put `[<JOB#> FEE]` on it, with the **same JOB#** as the project. That's how the system confirms the fee got billed and reconciles it against what was owed.

---

## Examples

| Description you type | What the system does |
|---|---|
| `[240117 LLW] HomeGoods — pay app 3` | Adds to project 240117's fee basis |
| `[240117 SOFT] architect — construction docs` | Ignored (soft cost, no fee) |
| `[240117 FEE] construction mgmt fee — HomeGoods` | Records fee taken for 240117; reconciles |
| `[23050 CAP] rooftop unit replacement` | Fee basis at KM; **no** fee at Gateway/Magnolia (mark `REPL` there) |
| `[23050 REPL] roof replacement — Bldg C` | No fee at Gateway/Magnolia |

---

## Don'ts
- **Don't** vary the JOB# between invoices on the same project.
- **Don't** leave a capital-account line untagged — untagged capital lines go to a "needs tagging" review queue and hold up the reconciliation.
- **Don't** put the tag in the middle of the description — it must be **first**.

---

## Capital accounts this applies to

| Property | Accounts |
|---|---|
| Knightdale E/W, Magnolia | `1202-00` Site Improvements · `1267-01` Building Improvements · `1321-00` / `1322-00` Tenant Improvements · `1234-00` CIP Hard Costs |
| Gateway | `155300` Building Improvements · `149800` Land Improvements |

*(If you code to any other capital/CIP account, tag it too — the review queue will catch anything new.)*

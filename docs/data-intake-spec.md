# CRE Platform — Data Intake Spec (draft)

What documents to provide to onboard a property, and what to provide on a recurring basis.
Living document — refine as functionality finalizes.

## Format & delivery conventions

- **Structured data** (rent rolls, financials, GL, invoices, budgets): **Excel/CSV** preferred —
  parsed deterministically, no AI cost. MRI exports are ideal.
- **Legal/source documents** (leases, estoppels, REAs, loan docs, insurance): **PDF** — read by the
  AI extraction pipeline. Text-based or OCR'd PDFs preferred (scanned-only still works, costs more).
- **Naming + folders:** drop files following the indexing convention so the pipeline auto-ingests:
  `<Property>/Financials/<YYYY>/<MM>/<Type>/…` for periodic data, `<Property>/Leases/<Tenant>/…`
  for lease lifecycle docs. Avoid Office lock files (`~$…`) and `Thumbs.db` — they're auto-excluded.
- **One authoritative source per metric.** The Income Statement is the P&L source of truth;
  GL and invoices are drill-down beneath it, never re-summed into the same totals.

---

## A. Initial onboarding set (once per property)

### A1. Property & ownership
| Document | Format | Feeds |
|---|---|---|
| Property profile (address, GLA, year built, asset type, acquisition date & price) | form/Excel | properties |
| Ownership/entity structure (LLCs, consolidated ↔ entity mapping, e.g. 0530/0531/0532) | form/PDF | properties, portfolios |
| Unit/suite schedule (suite IDs, sizes, anchor flags) | Excel | units |
| Site plan, ID/signage plans | PDF | documents |

### A2. Leases & tenancy (the lease file, per tenant)
| Document | Format | Feeds |
|---|---|---|
| Most recent **rent roll** | Excel | rent_roll_snapshots/rows |
| **Executed lease** + ALL amendments (in order) | PDF | leases, lease_rent_schedule, options |
| **Guaranties** | PDF | leases (guarantor) |
| Most recent **estoppels** | PDF | documents (estoppel) |
| **SNDAs** | PDF | documents |
| Commencement / delivery-date letters, option notices | PDF | critical_dates |
| **REAs / OEAs** (property-level easement & operating agreements) | PDF | co-tenancy / exclusive-use analysis |
| Co-tenancy & exclusive-use provisions (if abstracted separately) | PDF/Excel | co_tenancy_clauses |
| Existing lease abstracts (if any) | Excel/PDF | leases (accelerates load) |

### A3. Financial baseline (history)
| Document | Format | Feeds |
|---|---|---|
| **Monthly Income Statements — from acquisition to present** (actual vs budget + variance) | Excel | operating_line_items, trailing-12 NOI, full-history trends |
| **Trial balances** for the same span (acquisition→present) | Excel | reconciliation / balance sheet |
| **General ledger** (acquisition→present, as available) | Excel/CSV | gl_entries (drill-down) |
| Current-year **budget** + prior-year actuals | Excel | budget vs actual |
| AR aging, security-deposit schedule | Excel | supporting schedules |
| CAM / recovery **reconciliations** (historical true-ups) | Excel | recovery analysis |

### A4. Debt
| Document | Format | Feeds |
|---|---|---|
| Loan agreement / note (amount, rate, maturity, amortization, IO period) | PDF | loans |
| Current outstanding balance & amortization schedule | Excel | loans |
| Covenant terms (DSCR / LTV) + lender reporting requirements | PDF | loan_covenant_checks |

### A5. Capital / JV (if applicable)
| Document | Format | Feeds |
|---|---|---|
| JV / operating agreement, waterfall terms | PDF | deals, waterfall_tiers |
| Investor roster & capital accounts | Excel | investors, capital_accounts |
| Distribution history | Excel | distributions |

### A6. Operations & compliance
| Document | Format | Feeds |
|---|---|---|
| Current insurance policies | PDF | documents, critical_dates (renewals) |
| Service / vendor agreements | PDF | documents |
| Most recent property condition / inspection reports | PDF | inspections |
| Real-estate tax bills | PDF | taxes, critical_dates |
| Title | PDF | documents |

---

## B. Recurring data

### B1. Monthly
| Document | Format | Feeds |
|---|---|---|
| **Income statement** (actual vs budget + variance) | Excel | operating_line_items, NOI |
| **Trial balance** | Excel | reconciliation control |
| **General ledger** (month detail) | Excel/CSV | gl_entries |
| **Rent roll** | Excel | rent_roll_snapshots/rows |
| **AP / invoice breakdowns** | Excel/PDF | invoices (expense drill-down) |
| CAM / recovery billing detail (billbacks) | Excel | recovery analysis |
| Lender monthly reporting (if required) | Excel/PDF | loan reporting |

### B2. Quarterly
| Document | Format | Feeds |
|---|---|---|
| Distribution calc / capital-account statements | Excel | distributions |
| DSCR / covenant compliance certificate | PDF/Excel | loan_covenant_checks |
| Reforecast (if applicable) | Excel | budget |

### B3. Annual
| Document | Format | Feeds |
|---|---|---|
| Next-year **budget** | Excel | budget |
| CAM / tax **reconciliations** (true-ups) | Excel | recovery analysis |
| Insurance renewals | PDF | critical_dates |
| Audited/reviewed financials | PDF/Excel | reporting |
| Property tax bills / appeals | PDF | taxes |
| Refreshed estoppels (lender/buyer driven) | PDF | documents |

### B4. Event-driven (as they occur)
| Event | Provide | Feeds |
|---|---|---|
| New lease / renewal / amendment / termination | Executed doc **+ updated rent roll** | leases, options, critical_dates |
| New guaranty / SNDA / estoppel | PDF | documents |
| Option exercise / notice letters | PDF | critical_dates |
| Tenant default / co-tenancy trigger | Notice PDF | co_tenancy_flags |
| New or refinanced loan | Loan docs | loans |
| Capital call / distribution | Docs/schedule | capital_accounts, distributions |
| Sale / acquisition | PSA + closing docs | documents, properties |
| Inspection / incident / insurance claim | Report PDF | inspections, documents |

---

## C. File naming & folder convention

Following this lets the pipeline auto-classify and dedupe with **no manual review**. It is not
load-bearing for correctness (PDF content is read regardless of filename), but off-convention
files land in the "unclassified" queue and cost more to process.

### Folder layout (per property)
```
<PropertyCode>/                         # stable id, e.g. KM-EAST-0532 — never the drifting alias
  Financials/<YYYY>/<MM>/
      Rent Roll/  Trial Balance/  Income Statement/  General Ledger/  Invoices/  Budget/
  Leases/<Tenant>/
      Lease/  Amendments/  Estoppels/  SNDA/  Guaranty/  Notices/  Correspondence/
  Property/   Inspections/  Insurance/  Photos/  Site Plans/  Service Agreements/
  Capital/    Legal/    Lender/
```

### Periodic financial files
`MM.YYYY <Type> - <Property>.xlsx` — keep **date and property in fixed positions** (the fields
people most often fat-finger).
- e.g. `06.2026 Income Statement - Midway.xlsx`, `06.2026 General Ledger - Consolidated.xlsx`
- **Property tokens (authoritative):** `Midtown`/`Midtown Commons` → KM West (0531) ·
  `Midway`/`Midway Plantation` → KM East (0532) · `Consolidated`/`Knightdale` → Knightdale
  Marketplace (0530)
- **Type tokens:** Rent Roll · Trial Balance · Income Statement · General Ledger · Invoices · Budget

### Legal / tenant documents
Keep the coded scheme + tenant + `(date)`:
- `LSE` lease · `AMD` amendment · `MEM` memorandum · `GUAR` guaranty · `REA`/`OEA` easement-operating ·
  `EST CERT` estoppel · `SNDA` · `LTR`/`NTC LTR` letter/notice
- e.g. `LSE-Academy (5-22-23).pdf`, `EST CERT-Home Depot (6-28-19).pdf`
- When both a scan and an `…OCR.pdf` exist, the OCR/text copy is preferred; the scan twin is
  auto-deduped, as are the same agreement copied across multiple tenant folders.

### Excluded automatically (don't rely on these for anything)
`~$…` Office lock files · `Thumbs.db` / `*.db` · `*.lnk` / `*.tmp`. If you generate file lists or
names programmatically, save as **UTF-8 with LF** line endings — a stray `\r` (CRLF) inside a name
breaks downstream tooling.

---

## Notes
- **Historical depth: from each property's acquisition date to present.** Provide the full monthly
  history since acquisition so trendlines and historicals are complete (Knightdale acquisition:
  2019-07-15). ≥12 months is the minimum for trailing-12 NOI/DSCR, but full-since-acquisition is
  the goal. The platform stores every period; more history = richer trends with no downside.
- Anything provided as **Excel/CSV** loads via deterministic parsers (free, instant). Anything as
  **PDF** runs through AI extraction (small per-doc cost) and becomes semantically searchable.
- Recurring drops that follow the naming/folder convention are picked up automatically by the
  catalog + import pipeline; off-convention files land in an "unclassified" queue for review.

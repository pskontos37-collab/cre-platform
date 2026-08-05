# ASSET_UPLOAD_GUIDE

Every asset the application still expects, where it goes, and how to verify it landed.
Updated 2026-08-04. **No upload here requires a build or deployment** — all assets are
data (Supabase Storage + Postgres rows), never bundled into the frontend.

## How ingestion works (context)

All documents live in the single Supabase Storage bucket **`documents`**, referenced by
rows in the `documents` table (UUID ids; families/versions tracked in DB). Three intake
paths:

1. **In-app upload** — page-specific pickers (formats enforced by each picker, listed below).
2. **`doc-inbox` edge function** — programmatic intake: **PDF only**, `.pdf` extension enforced, **20 MB cap** (`MAX_BYTES`), base64 body; returns 202.
3. **`drive-import` / `drive-inventory`** — Google Drive nightly scan 01:00 (needs `GOOGLE_SERVICE_ACCOUNT` + `GOOGLE_DRIVE_FOLDER_ID`; keep/kill decision open with owner).

After upload, text extraction/indexing runs via `pdf-extract` (⚠️ currently DOWN — Anthropic credits, KI-1).
Verification for any document asset: the row appears in `documents`, and (once credits
are restored) `document_chunks` gains `kind='text'` rows; the doc becomes findable in `/ask`.

## Assets still expected

| # | Asset | Who | Where to put it | Format | Size | Notes / metadata |
|---|---|---|---|---|---|---|
| 1 | **Rent-roll workbook** (onboarding test) | Owner picks file | `/onboarding` step 4 upload | `.xlsx` / `.xls` (picker-enforced) | keep < 20 MB | THE untested workflow; after load run `scripts/reconcile_rentroll_terms.ps1` (MRI carries extensions as second future-term rows) |
| 2 | Monthly MRI GL + rent-roll exports | Owner (monthly) | `/imports` (Excel import pipeline; column-mapping UI) | `.xlsx` | < 20 MB | period lives on `rent_roll_snapshots.period_year/month`; never trust `max(period)` across properties |
| 3 | 2026 budgets | Owner | `/imports` (budget mapping) | `.xlsx` | < 20 MB | unblocks budget-vs-actual (KI-7); MTD/YTD actual/budget/variance columns |
| 4 | Appraisals | Owner | `/documents` upload or doc-inbox | PDF | ≤ 20 MB via inbox; larger → in-app | attach to property; feeds valuation context |
| 5 | Insurance certificates (COIs) | PM staff | `/insurance` (COI tracker) | PDF (ACORD) | ≤ 20 MB | auto-parse via `coi-extract` (AI — down until KI-1 resolved); routes to tenant/vendor |
| 6 | Tax bills | Owner | `/documents` | PDF | ≤ 20 MB | tag property + year |
| 7 | Lease documents (new/amendments) | Staff | `/abstracts` upload (`accept=application/pdf`) | PDF | ≤ 20 MB inbox; edge-fn OOM risk ≥ ~40 MB (KM East max seen 41.1 MB) — split large scans | abstraction pipeline picks up after upload |
| 8 | PH Developers' agreement | Owner | `/documents` | PDF | ≤ 20 MB | referenced by REA work, never delivered |
| 9 | Lease-abstract TEMPLATE FORM inputs | Owner | not a file — form spec to the dev session | n/a | n/a | blocked since 7/04 (KI-7) |
| 10 | Inspection photos | Field staff | `/inspections` (`accept=image/*`, multiple) | JPG/PNG/HEIC | phone-photo sized | stored under `documents` bucket path per inspection |
| 11 | Tenant work-order photos | Tenants | `/portal` (`accept=image/*`) | JPG/PNG | phone-photo sized | via edge-fn gateway (custom portal auth) |
| 12 | Contacts workbook | Staff | `/contacts` import (`accept=.xlsx`) | `.xlsx` | small | 24 leases still need manual contact entry |
| 13 | Acquisition OMs / diligence docs | Staff | `/pipeline` + `/diligence` (`accept=application/pdf`) | PDF | ≤ 20 MB | uw-extract / om-extract parse (AI — down per KI-1) |
| 14 | Service-agreement Exhibit A | Staff | `/services/new` builder | PDF | small | merged into the generated agreement PDF |

## Naming conventions

- Documents: descriptive original filenames are kept (e.g. `AMD-3rd-Kay Jewelers (7-9-26).pdf` — the doc-inbox example). No renaming required; identity is the UUID row.
- Rent rolls / GL exports: keep MRI's export name + add period if absent (`RETAILRR_2026-07.xlsx`).
- Migrations (not an asset, but same discipline): claim number only at apply time; next free = 20240195.

## Validation rules (enforced by code today)

- doc-inbox: `.pdf` extension regex + 20 MB cap + base64 integrity — errors return 4xx with a plain message.
- Pickers: extension filters as listed above (client-side only — server re-validation exists only on doc-inbox; in-app uploads go straight to Storage with staff JWT + RLS).
- Image dimensions: no constraints enforced; photos render responsive.

## How to verify an asset after upload

1. Row exists: `/documents` (or feature page) lists it. DB truth: `select id, file_name, created_at from documents order by created_at desc limit 5`.
2. For rent rolls: new `rent_roll_snapshots` row for the right property+period; run the term reconciler; check `/properties/:id` rent roll tab.
3. For Excel imports: `import_jobs` row reaches `succeeded`, mapped rows visible in the target page.
4. For AI-parsed docs (COI, OM, leases): parse fields populate **only after KI-1 (credits) is resolved** — until then a successful upload sits unparsed by design.

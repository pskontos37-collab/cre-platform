# CRE Platform — Project Status & Resume Guide

_Last updated: 2026-07-04 (PM). This file is the durable handoff so any new chat (or person) can resume without losing context. The detailed running log lives in Claude Code memory (see bottom)._

> **2026-07-04 (PM) — delivery queue drained + A/R aging live.** All remaining delivered files loaded:
> (1) **Gateway 2025 INS + RET recs** (`scripts/load_ins_ret_recs.ps1`) → `cam_reconciliations` with new
> `rec_type` column ('cam'/'ins'/'ret', migration 20240032); INS from 'B4-PT Summary' (22 rows), RET from
> 'Rec' (20 rows); RET billed sum ties to the MRI Tenant Charges RTX total ($972,300.78) exactly.
> (2) **Magnolia 2025 combined rec** (`scripts/load_cam_recs_mag.ps1`) from 'B5- PT Summary' of CAM Rec V3
> (the A-series tabs are the PRIOR-year 2024 rec — B-series is current): 34 tenants split into 85
> cam/ret/ins rows; all six sums (billed+due × 3 types) tie to the workbook NET TOTAL row.
> (3) **2025 RET lump sums** (`scripts/load_ret_lumpsums.ps1`): KM East 7 tenants (from per-tenant tabs;
> 'Revised' tabs supersede — they SWAP Arby's/Wells Fargo vs the Input Sheet) + KM West 3 tenants
> ($158,266.43 ties to BAF). Magnolia's lump sums NOT loaded — already inside its CAM Rec V3 rows.
> (4) **MRI A/R AGING LOADED** — user dropped 4 'Aged Delinquencies' exports (as of 7/3/2026) in Downloads;
> new `ar_aging` table (migration 20240033) + `scripts/load_ar_aging.ps1` (re-runnable; validates each file
> against its Grand Total): Magnolia $837,856 / Gateway $868,557 / KM East $156,629 / KM West $77,383, 87
> tenant rows with Current/30/60/90/120+ buckets + per-category jsonb. **DelinquencyWidget REWIRED** to
> ar_aging (was dead on lease_payments) and mounted; CAMReconWidget renamed 'Expense Reconciliations' with
> a CAM/INS/RET filter; unmatched tenants fall back to the loader's notes name.
> (5) **2026 site plans ingested** (K:\RETAIL\PROPERTY INFORMATION\<prop>\Site Plan\2026): Gateway 1pg,
> KM 3pg (tagged Consolidated 012), Magnolia 1pg. (6) **Magnolia Monthly Reports ingestion COMPLETE**
> (2025+2026 folders, ~965 docs; 12 fails = giant combined monthly PDFs, 1 oversize dead-letter).
> (7) Storage sync relaunched (mirror was 8,118/8,759 before the new ingests; nightly task continues).
> **NOT DEPLOYED YET:** the widget changes (Delinquency, Expense Recon filter) need `scripts/deploy_vercel.ps1`
> — deploy was blocked pending user approval. `tsc -b` still never run (no Node).
>
> **2026-07-04 (later) — /receivables A/R panel BUILT, DEPLOYED + BROWSER-VERIFIED** (deploy
> dpl_AJWHeHUchcFNRcDfKYZrx7g8oVti; verified live: KPIs tie to source totals, 90d+ filter surfaces Urban
> Air's $405k inactive-tenant delinquency, Target row-expand shows the $171k prepaid-rent credit).
>
> **2026-07-04 (evening) — TRUE REA PANEL + INVOICE DRILL-DOWN BUILT (⚠️ awaiting deploy).** "REA" in the
> user's request meant **Reciprocal Easement Agreements** (misread as "receivables" at first — both now
> exist). Migration `20240034_rea_and_ar_detail.sql`: (1) `rea_agreements` — 8 instruments seeded from
> corpus docs (`scripts/seed_rea_agreements.sql`): Midway OEA 6-27-05 (Target + Home Depot + operator
> **BBK Midway Plantation LLC**), KM-West Kohl's REA 3-13-08 (BBK Midtown Commons), Gateway 1963/64
> Declarations + **NYS Thruway drainage easement w/ ACTIVE $767,831.23 claim (NTC 8-8-24)**, Magnolia
> Costco COREA, RTG Supplemental ($2.00/SF, CPI-or-5% escalator), Ruby Tuesday pad/$0.23/SF (now Diamonds
> Direct), Amerishop Mutual Access + Plaza REA ($0.25/SF, Plaza Green LP). members jsonb carries MRI lease
> ids so live A/R balances join onto the /rea panel. (2) `ar_aging_detail` — 536 invoice-level lines
> (loader extended; per-tenant bucket sums tie exactly). (3) `ar_notes` — durable annotations that survive
> snapshot reloads: **Urban Air = eviction settlement ($385k RNT + $20k BAD); KM-East Target 0532-M00080 =
> REA-member CAM overbilling credit (−$12,676.95 OXR)** [both user-confirmed]; Gateway Target = distinct
> leased tenant. UI: ReaPage.tsx (/rea, sidebar 'REAs') + ReceivablesPage upgrades (clickable KPI cards,
> bucket-cell drill to invoice lines with bucket chips, REA badges linking to /rea, 📝 note callouts).
> All four new PostgREST selects validated live (HTTP 200). Deploy + browser-verify = next action.
>
> **2026-07-04 (night) — user-testing round 2, three fixes.** (1) **Header portfolio chips**: the "static"
> BBK Knightdale chip was simply the only row in `portfolios` — seeded 'Gateway JV — MetLife/MJW' and
> 'Magnolia JV — MetLife/MJW' (+ property assignments). Header is data-driven, so this is live now.
> (2) **Lease-abstract quality** (the AT&T / Moe's "documents not received" complaint): root cause was
> corpus chunks are extraction SUMMARIES + those abstracts were generated before the storage mirror
> finished (0 PDFs attached). Edge fn **v6**: attaches up to 5 governing PDFs (was 2) with
> amendment-ordinal scoring (4th > 3rd > …; 'unexecuted/draft' −5; 'control sheet' −3) and stepped
> 5→2→text-only fallback. AT&T + Moe's regenerated with 5 primary-source PDFs each — abstracts now cite
> the executed Fourth Amendment directly and quote CAM language verbatim; remaining open items are
> genuine lease questions. TODO candidate: batch-regenerate the other ~53 abstracts (~$1/tenant).
> (3) **Duplicate-payment dismissals**: `invoice_dup_dismissals` (migration 20240035; flag key = sorted
> invoice-id set so a NEW duplicate re-surfaces) + Dismiss/Restore UI on /financials (awaiting deploy).
> Dedicated page for the MRI Aged Delinquencies snapshots in `ar_aging`: portfolio KPI band (total /
> current / past-due 30+ / at-risk 90+ / credits), stacked aging-composition bar per property, and a
> sortable tenant table (search + All/Past-due/90d+/Credits quick filters, severity-colored buckets,
> accounting-style negatives, expandable per-row income-category breakdown from the categories jsonb,
> MRI lease id, last payment). Files: `src/pages/ReceivablesPage.tsx`, `src/hooks/useArAging.ts` (latest
> snapshot per property; PostgREST select string validated live), route in App.tsx, sidebar 'Receivables',
> ARWidget + DelinquencyWidget now drill to /receivables. **Branding per wilkow.com:** slate `#466371`
> (site primary), wordmark grey-blue `#8FA2AD`, corporate serif **Frank Ruhl Libre** (added to index.html
> Google-Fonts link) for the page title/KPI figures, uppercase letter-spaced kickers echoing the M&J WILKOW
> wordmark; theme variables still respected so all four app themes work.

> **2026-07-03 — THE APP ACTUALLY WORKS NOW (RLS recursion fixed) + full functional audit.**
> A 24-agent audit + live browser pass found the app had NEVER worked for authenticated users: three RLS
> policies from `20240009_rls.sql` inlined `EXISTS (SELECT … FROM users)` in their USING clauses
> (`users_admin_all` self-recursed → Postgres 42P17 → **every PostgREST call 500'd** → every page silently
> dark; all prior data checks used the service key, masking it). **Fixed + applied:** migration
> `20240024_fix_rls_recursion.sql` (SECURITY DEFINER `is_admin()` helper) and
> `20240025_write_policies_and_hardening.sql` (critical_dates INSERT/UPDATE + co_tenancy_flags UPDATE
> policies; revoked anon access to the P&L views — they were world-readable with the anon key;
> `account_invoices` got a pagination tiebreaker; **waterfall data fix**: the 3 Layer-2 syndication IRR prefs
> were `preferred_return` tiers the engine no-ops → re-modeled as hurdled 100/0 promote tiers — GP was
> overstated 2–12x, now verified exact on the live page). **Code fixes (deployed):** `src/lib/fetchAll.ts`
> paged-fetch helper wired into useGlPnl / usePropertyHub doc-type chips / GL drill-down RPCs (PostgREST
> silently caps at 1,000 rows — drill-down now shows all 15,751 txns on Gateway 115000 with a "showing 2,000
> most recent" render cap); DocumentCorpusWidget counted only `drive:%` docs (showed 2, now 8,048); dead
> "+ Add Property" button removed; retired `/import` route removed (bulk-import there could double-count
> Knightdale via the Consolidated entity); AskPage surfaces non-200s. Deploy now scripted:
> `scripts/deploy_vercel.ps1` (env vars live on the Vercel project). **Verified in the browser:** dashboard
> (NOI $23.0M T12, DSCR cards, rent roll, rollover, critical dates incl. Arby's 7/4, top vendors, corpus,
> tenant concentration), properties list + Gateway hub, financials drill-down, waterfall (Magnolia L2 GP
> $2,202,164 at defaults — matches hand-calc), agreements, documents search. **Also done tonight:**
> dead-letter recovery COMPLETE (83 oversized anchor leases — Ross/DSW/HomeGoods/Chick-Fil-A/OfficeMax etc. —
> split + ingested; corpus 8,003 → 8,048+); storage backfill relaunched and mirroring (~2,000 files done, rest
> continues via nightly task). **Known cosmetics left:** rollover shows stale/0-SF buckets from source rent
> rolls; tenant concentration ranks lease-rows not grouped tenants; useQuery hides errors as skeletons;
> RentRoll "as of" chip shows newest vintage only; 7 legacy widget files unmounted (Delinquency/CAM/PctRent/
> CoTenancy await A/R aging, CAM workbooks, tenant sales data); tsc still never run (no Node); drive-import
> edge fn + GOOGLE_SERVICE_ACCOUNT secret still deployed (retirement cleanup candidate); 3 storage patchfail
> files + 1 orphaned storage_path.

> **2026-07-01 update:** (1) **Knightdale V: TENANTS scan complete** + all oversized leases/plans split (30-page pieces, token-limit fix) and ingested — **doc corpus = 8,382**. (2) **Entity/JV structures** for Gateway, Magnolia, Knightdale reviewed from the V:\ENTITY DOCS OAs (extracted via `scripts/extract_entity.ps1` on Opus; synthesized+verified via a multi-agent workflow) → memos in Claude memory (`project_{gateway,magnolia,knightdale}_jv_structure`). (3) **Entity docs ingested** into the corpus (19 docs, `doc_type=jv_agreement`, tagged per property, embedded/searchable). (4) **Waterfalls modeled** in `deals`/`waterfall_tiers`: 6 deals = each property × Layer 1 (institutional JV) + Layer 2 (MJW syndication), with `preferred_equity_positions` for Magnolia's $6.84M MetLife pref and Gateway's $1.55M Class D. All three follow the same 2-layer Wilkow promote pattern (MetLife/URS, MetLife, and Bailard as the respective institutional partners). Loaders: `scratchpad/model_waterfalls.ps1` + `scratchpad/ingest_entities.ps1`. (5) **Waterfall engine upgraded to a true IRR-hurdle solver** — `src/lib/waterfall.ts` now exports `xnpv`/`xirr` (dated, Actual/365), `cashToHitIrr` (closed-form distribution-to-hurdle via XNPV linearity), `computeIrrWaterfall` (single event: exact hurdle breakpoints + senior preferred equity), and `runIrrWaterfall` (multi-event runner returning each partner's realized XIRR). The original `computeWaterfall` is retained for backward compatibility. Tests in `src/lib/__tests__/irrWaterfall.test.ts`. NOTE: this machine has no node/deno, so vitest was not run here — the algorithm was validated via an independent PowerShell port (all hand-checked cases matched to the cent / to 5 dp on IRR); run `npm test` once Node is installed. (6) **New `/waterfall` page** (`src/pages/WaterfallPage.tsx` + `src/hooks/useDeals.ts`, linked in the sidebar) — pick any of the 6 modeled deals, set equity / sponsor % / hold / payout, and it runs `computeIrrWaterfall` live: tier-by-tier LP/GP breakdown (with hurdle-met vs cash-exhausted status), realized LP & GP IRRs, and a "promote sweep" table showing how the split shifts as the payout grows. Not visually run here (no Node) — verify with `npm run dev`. (7) **Property Management Agreements (PMA) — COMPLETE:** migration `20240022_management_agreements.sql` **applied** to production (`management_agreements`, `management_agreement_deadlines`, `critical_dates.management_agreement_id`); the **12 PMA abstractions ingested** into the corpus (property-tagged, embedded → **corpus = 8,394**); and **10 `management_agreements` rows + 18 `management_agreement_deadlines`** seeded (Gateway base+1st amd; Magnolia base+3 amds+CHI sub-mgmt base+CHI amd; KM-East base; KM-West base). Current management-fee rates captured: **Magnolia 2.75%** (2024 3rd amd), **Gateway 1.75%**, **KM 3.1%** (+5% construction, 4% leasing). The `/management` page reads these live. **LOADER GOTCHA (documented for reuse):** the `sb_secret_` key is rejected on a browser-like User-Agent (use `curl`, or PowerShell IRM `-UserAgent`), and PostgREST `Prefer: return=minimal` inserts can silently fail to persist — use `return=representation`; bulk array inserts need identical keys (PGRST102).

> **2026-07-01 (later) — DEMO IS LIVE: https://cre-platform-mjw2.vercel.app** (login pskontos@wilkow.com). Vercel project
> `cre-platform` (team team_8u90qS4wCl8RhHbboldHZyzT, token in `.env`), deployed via REST API (no local Node): base64 file
> payload → `POST /v13/deployments`; `vercel.json` overrides buildCommand to `vite build` (**tsc type-check skipped — run
> `tsc -b` once Node exists**) + SPA rewrite; production ssoProtection off (previews stay protected). **New this session:**
> (1) **Gateway buyout closing binder** — all 68 PDFs abstracted + ingested (**corpus = 8,470**; fee purchase
> **$103,478,461.14** = $88.98M assumed NY Life loan + ~$14.5M cash, seller DPPC Holdings L.P., closed 10-28-25;
> Zoning/Phase-I giants: front-60pp findings abstracted, appendices not — deliberate). (2) **`/properties` +
> `/properties/:id` hub** (KPIs, NOI trend, top tenants, debt+covenants incl. cross-collateral, waterfall, PMA terms,
> docs, critical dates). (3) **`/ask` AI Q&A** → new `doc-ask` edge fn: hybrid retrieval (pgvector +
> `search_documents_by_title` SQL fn that length-normalizes title keyword hits) + claude-sonnet-5 cited answers —
> verified on the Magnolia fee history (3.0% → $18,857 floor → 2.75%). (4) CriticalDatesWidget on the dashboard + 8
> PMA submittal dates seeded into `critical_dates` (note: `alert_days_before` is int[]). (5) Sidebar dead links removed,
> "Ask AI" added. **Open:** delete dormant `operating_line_items`/`financial_periods` (1,431+23 rows — mass-delete blocked
> pending explicit approval); appraised values for LTV; visual click-through of the live site.

## How to resume in a new chat
1. Open **Claude Code** in `C:\Users\pskontos\Desktop\Software` (the same folder). Memory auto-loads from
   `…\.claude\projects\C--Users-pskontos-Desktop-Software\memory\` — that carries the full history, decisions, and roster.
2. Say something like: *"Continue the CRE platform work — pick up from PROJECT-STATUS.md."*
3. **Local access matters:** reading the V:/K: file servers, running the loader scripts, and Excel/PDF
   extraction only work in **Claude Code on this machine** — not in a claude.ai web project.

## Stack & locations
- Frontend/back: React + Vite + Supabase. Repo: `C:\Users\pskontos\Desktop\Software\cre-platform`.
- Supabase project ref: `vsqcykdpilfaockyfhuk`. Keys in `cre-platform\.env` (Supabase + ANTHROPIC + OPENAI).
- Reusable scripts: `cre-platform\scripts\` (GL/invoice/IS loaders, PDF extractors, inventory, backfill).
- Migrations: `cre-platform\supabase\migrations\` (through `20240019_gl_pnl_namebased.sql`).
- File servers (read-only): **V:\** = formal archive (per-property ACCOUNTING/ACQ-REFI-DISP/OPERATIONS/TENANTS);
  **K:\Working Files - <property>** = live working files (year-organized). ~128 properties total; ~20 OWNED.

## What's built (deployed + working)
- **Document AI:** 2,978 PDFs extracted + embedded (Knightdale Drive corpus, property_id null); `doc-search`
  semantic search; `pdf-extract` (Drive, handles oversized via split, pdf-lib + MuPDF). Documents page (`/documents`).
- **Local doc ingestion (NEW):** `scripts/ingest_local_docs.ps1` scans a property's V:/K: lease/tenant PDFs into
  the corpus **tagged to property_id** (extract via Haiku + embed via OpenAI + store). **Gateway + Magnolia
  TENANTS fully scanned + oversized giants pre-split (qpdf) and ingested.** FINAL corpus **~7,461 docs**
  (Knightdale ~2,978 [property_id backfilled], Gateway 1,453, Magnolia 3,030). Every lease incl. Staples +
  Wild Wing captured; only 2 single fold-out drawing PAGES (>32MB) un-ingestable (need rasterization).
  Pipeline notes: use the UNC path (not V:) in background; per-folder manifest (full recursive scan hangs);
  oversized (>24MB/100pg) -> `scripts/presplit.ps1` (qpdf portable in scratchpad, adaptive ~15MB pieces) then
  ingest the pieces. Remaining ~16 owned properties' docs pending (reuse this pipeline).
- **Amendment precedence:** `lease-consolidate` edge fn (property + tenant -> current effective terms w/ citations,
  later amendments supersede). Works portfolio-wide.
- **GL + Invoices:** tables + parsers; KM East/West GL (72k entries) + invoices (4,703) loaded & reconciled.
  **Magnolia + Gateway invoices loaded & reconciled to the penny** (`scripts/load_invoices.ps1`, now multi-property,
  scoped per-property delete, skips blank-amount lines): Magnolia $31,636,921.42 (7,446 dists), Gateway
  $71,282,181.14 (7,829 dists), 350 vendors, 13,961 invoices. Financials page (`/financials`) with GL account
  drill-down → invoices (image links) + vendor spend + dup flags.
- **Dashboard** (`/`): rebuilt to data-backed widgets — **GL-derived NOI** (name-based), OpEx trend, Rent Roll,
  Lease Rollover, Top Vendors, Document Corpus, Tenant Concentration.
- **Loan + DSCR:** MetLife refi loaded (`loans`), debt_yield_covenant added. **Debt coverage widget live on the
  dashboard** — NOI sourced from the GL views; cross-collateral handled via new `loans.collateral_property_ids`
  (migration 20240020): the MetLife loan (on Consolidated entity 012, no GL) draws NOI from KM East+West (010+011).
  Shows Debt Yield (cov ≥14%), LTV (cov ≤50%), DSCR (informational), T12 NOI; breach/near keyed to the loan's
  ACTUAL covenant. KM: T12 NOI $5.26M → DSCR 2.54x, debt yield 19.1% (well inside covenants).
- **Ownership model:** `properties.ownership_type` ('owned'/'third_party_managed'); app filters to OWNED only.

## Data state (owned portfolio)
- **20 owned property records seeded** (name/city/state/asset_type/total_sf/jv_partner). See memory for roster.
- **Financials loaded (GL-derived NOI, validated):** Knightdale E/W ($3.10M/$2.16M T12), **Magnolia Park
  ($8.08M)**, **Gateway Port Chester ($9.32M)** — all ~$16–19/SF NOI, coherent. Debits=credits to $0.00.
- **Rent rolls loaded (MRI_CMROLL, 2026-06, validated to file Totals):** Gateway ($935,054.70/mo = $11.22M/yr,
  428,882 occ SF, 85.18% occ, 25 units, $26.16 PSF); Magnolia ($710,264.07/mo = $8.52M/yr, 409,574 occ SF,
  84.31% occ, $20.81 PSF). Plus KM East/West from earlier. Loader: `scripts/load_rentroll.ps1`.
- Remaining ~14 owned have records but no financials yet.

## NOI conformance (validated 2026-06-28)
GL-derived NOI was reconciled to each property's official MRI **Comparative Income Statement** (Dec-2025 YTD,
from K:\...\Supplemental). **All four owned-with-GL properties now tie to the penny** for calendar 2025:
Magnolia $8,620,459.95 · Gateway $10,026,302.83 · KM East/Midway $3,175,852.95 · KM West/Midtown $2,159,672.93.
Migration 20240021 fixed the name-based classifier so it matches the IS exactly: ground rent, interest
(expense+non-4xxx income), depreciation/amortization (incl. abbreviations "Depr"/"Amort"), and leasing
expense are below NOI; one property-specific exception pinned (Gateway "Other Professional Fees" 601200 is
operating). Revenue already matched exactly everywhere. Reconciliation method: IS code `MR/TC######` maps to
GL `####-##`/`######`; compare IS above/below-NOI placement to GL line_type per account.

## Key decisions
- **NOI source = MRI GL Excel export** (deterministic, penny-accurate). NOT the working-file PDFs — those
  mix monthly/quarterly/YTD/annual statements and auto-extraction was unreliable.
- **NOI classification is NAME-BASED** (`v_gl_pnl_lines`, migration 20240019) because properties use
  different charts of accounts (e.g., Gateway codes property tax 920000 vs Knightdale 5xxx).
- Income Statement = source of truth conceptually; GL = drill-down. GL-derived NOI reconciles to the IS.

## Repeatable rollout pattern (per owned property)
1. User runs an **MRI GL export** (MRI_GENLEDG, since acquisition) → drops the .XLSX in Downloads.
2. Add the file + property_id mapping to `scripts\gl_owned.ps1` and run it → loads `gl_entries` (handles both
   account-code formats). Debits should equal credits.
3. NOI appears automatically (dashboard is GL-derived). Optionally MRI_CMROLL rent-roll export for leasing.

## Service Agreements panel (DEPLOYED + BROWSER-VERIFIED 2026-07-05)
- **/services** (`ServiceAgreementsPage.tsx` + `useServiceAgreements.ts`, sidebar "Services" 🔧): vendor service
  contracts grouped by vendor+category per property; latest contract governs, prior years fold underneath.
  Lifecycle chips (Expired / Expiring ≤90d / No term / Active / Auto-renews / Terminated) + category filter +
  vendor search; each card links its source contract to `/documents?q=<title>` (doc-search signs the PDF view URL)
  and the V:/K: file path shows in the link tooltip.
- **Data:** `service_agreements` table (migration `20240037_service_agreements.sql`, NOT yet applied) — one row
  per source document (unique document_id → upsert-safe). Populated by `scripts/extract_service_agreements.ps1`:
  extract mode = Claude (sonnet, forced-JSON tool) over ~206 candidate docs' title+summary chunks →
  `scripts/service_agreements_extract.jsonl` (resumable); `-Load` mode = upsert JSONL → PostgREST + manual
  overrides (Budd Group @ KM East marked terminated).
- **LIVE 2026-07-05** (dpl_8J8rbgAhxrpRuUHzUy6XtW9vb7mN): migration 20240037 applied; 168 rows loaded
  (15 active / 144 expired history / 7 unknown-term / 2 terminated) from BOTH pipelines — corpus sweep
  (206 candidates → 140 agreements) + native-PDF reads of the 44 LATEST contracts from the authoritative
  `V:\<prop>\OPERATIONS\Service Agreements` folders (user-designated source). source_key = canonical V:\ path
  merges the two. Browser-verified: chips filter, vendor search, prior-contract history expander,
  doc-search handoff → View PDF, copy-file-path fallback for un-ingested GW/MAG files.
- **Follow-ups:** ingest GW (246 files) + MAG (302 files) Service Agreements folders into the corpus so those
  rows get in-app PDF links (KM already ingested); vendor-name variants split groups occasionally
  ("Baker Roofing" vs "Baker Roofing Company") — could normalize later.

## What's next (open items)
1. **Load remaining owned GLs** (Cherry Creek, Meridian, One East Erie, East Gate, Parker Ranch, Waterfront,
   Mililani, Outlets of Maui, Penn Center, Southlands) — same MRI GL export → `gl_owned.ps1`.
2. **Clean up dormant IS data** — the earlier PDF-extracted `operating_line_items` (unreliable, NOT on the
   dashboard) should be deleted so there's one clean financial source.
3. **Rent rolls** for owned properties (MRI_CMROLL export preferred). Gateway + Magnolia + KM done via
   `scripts/load_rentroll.ps1` (self-validates occupied $ to the file's "Totals:" row, aborts on mismatch).
   NOTE: the MJW_RETAILRR report format is messy (3-row records, mixes buildings) — always use the plain
   **MRI_CMROLL "Rent Roll"** export (one building per file).
4. ~~Loans page / DSCR widget~~ — DSCR/coverage widget DONE. Loans loaded: **MetLife** (KM consolidated,
   debt-yield covenant, DSCR ~2.5x) + **New York Life** (Gateway $120M, 4.25%, P&I since 2025-06, DSCR ~1.30x —
   tight, "Near Covenant"). **Magnolia has NO mortgage** — paid off 2026-06-15 and replaced by a **MetLife
   preferred-equity** position ($6,843,702.22, Base Return SOFR+1.70%/5% floor); recorded on the property (equity,
   not debt → no DSCR). Remaining: appraised values for LTV; full waterfall/capital-account modeling for the
   Magnolia pref (deals/waterfall_tiers schema exists); a dedicated full Loans page (dashboard widget covers it for now).
5. Optional: invoice-image ingestion into search; office-asset metrics (base-year/expense-stop); finish the
   V:/K: inventory censuses.

## Data hygiene notes
- A few GL `entry_date` values are source typos (e.g., year 1919/8024/2121) — they don't affect NOI (which
  keys off the MM/YY period token).
- Exposed API keys (Supabase service/PAT, Anthropic, OpenAI) should be rotated when convenient.

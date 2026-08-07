# Disaster-recovery rehearsal — from-zero migration replay (2026-08-07)

KI-6 said the 220+ migrations had never been rehearsed against a clean database, so
disaster-recovery-by-replay was unproven. This rehearsal ran the full replay onto a
brand-new Supabase project (`cre-platform-staging`, ref `neftwjesayzsfggluuts`) and
recorded every place the repo's migration history was NOT sufficient to rebuild prod.

**Verdict: the replay works, with eight patches.** End-state fidelity vs production:
tables 120=120 · views 33=33 (31 `security_invoker` on both) · matviews 2=2 ·
RLS-enabled tables 120=120 · policies 249=249 · functions 370=370 · enums identical.
Staging's `schema_migrations` carries 192 of prod's 199 rows (7 data-only migrations
correctly refuse to run without prod data — see patch 4).

## How it ran

- Order: the 25 pre-ledger foundation files (`20240001–23, 31, 45`, numeric order,
  no ledger rows) via raw SQL, then all 199 ledger rows in `version` order, each
  recorded into staging's `schema_migrations` with prod's exact version+name —
  gated on apply success. Driver: `scripts/` equivalent lives in the session
  scratchpad (`replay.mjs`); stop-on-first-error with a done-file for resume.
- 217 of 224 applied clean; 7 skipped; 8 patches below.

## The patches — what the repo alone could NOT rebuild

Every item below is prod schema that exists OUTSIDE any committed migration
(dashboard/SQL-editor era or untracked hotfixes). A future for-real DR restore from
backup does not need these; a from-zero REBUILD does.

1. **`documents.storage_path`, `documents.file_mtime`** — untracked columns; the
   recovered view `nightly_scan_report_view` (2026-07-10) references them.
2. **Core reference data** — `insurance_requirements_seed` and ~30 later data
   migrations reference property rows the app loaded outside migrations. Patched by
   copying `portfolios` (10) + `properties` (26) from prod with exact UUIDs.
3. **`asset_type` enum value `'mixed_use'`** — untracked `ALTER TYPE` (Penn Center
   Retail / Penn Center East Office). The ONLY enum drift portfolio-wide (full diff).
4. **7 data-only migrations skipped** (`20240155/157/158/159/195/196/197` by name:
   pcf_ground_lease_intangible_in_bridge, pcf_map_gateway_tc_income_recoveries,
   pcf_map_545400, pcf_fix_115100, pcf_pair_financing_cost_amortization,
   abstract_qa_closeouts, target_allowance_gl_note) — their `raise exception`
   tie-guards demand prod GL/abstract rows. Zero DDL in any of them (verified
   per-file), so no schema content was lost. **The guards worked as designed.**
5. **`search_documents_by_title()`** — function created in prod via untracked SQL
   (used by doc-ask + doc-search; `20240040` only ALTERs it inside an
   absence-tolerant loop). Recovered via `pg_get_functiondef` + exact grants.
6. **Storage buckets `documents` + `lease-ingest`** — dashboard-created; only
   `work-orders` has a migration.
7. **`log_mutation()` hotfix** — ⚠️ the committed `20240010` version casts
   `lower(TG_OP)` (`'insert'`) into `audit_action`, which has `'create'` not
   `'insert'`: EVERY audited INSERT fails on a fresh replay. Prod's function was
   silently fixed via untracked `CREATE OR REPLACE` (CASE TG_OP mapping). This one
   is a genuine landmine for any rebuild.
8. **5 untracked columns via full column diff** — `properties.ownership_type`
   (NOT NULL default `'owned'` + CHECK), `properties.status` (NOT NULL default
   `'active'` + CHECK), `properties.management_company`, `properties.jv_partner`,
   `loans.debt_yield_covenant`. `useProperties()` FILTERS on `ownership_type`, so
   `/properties` hard-errors without it. Column diff is now EMPTY both directions.

## Recommended follow-up (owner-gated, not yet done)

Formalize items 1, 3, 5, 7, 8 as ONE no-op-on-prod migration (`add column if not
exists` / `add value if not exists` / `create or replace` with prod's exact bodies)
so the repo finally rebuilds prod without archaeology. It changes nothing in prod
(all objects already exist there) but needs a migration number claimed at apply
time and the owner's go like any `apply_migration`.

## Staging environment (what came out of this)

- Project: `cre-platform-staging` / `neftwjesayzsfggluuts` (us-west-1, $10/mo).
- **Vercel PR previews now build against staging** — `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` are preview-scoped to staging; production env records
  untouched. PR previews can no longer touch the production database.
- Smoke login: `smoke@staging.local` (admin + global entitlement). Password lives
  ONLY in the `STAGING_SMOKE_PASSWORD` GitHub Actions secret; rotate by updating
  `auth.users.encrypted_password` with `crypt(<new>, gen_salt('bf'))` and
  re-setting the secret. ⚠️ Manual `auth.users` inserts must set the token text
  fields (`confirmation_token` etc.) to `''` — NULLs 500 the GoTrue token endpoint.
- CI: the `e2e-smoke` job builds against staging and runs `e2e/smoke.spec.ts`
  (Playwright, 4 tests: auth wall, login, live `/properties` rows through RLS,
  `/financials` shell). The `deploy` job now `needs` it — a broken login blocks
  production deploys.
- Local run: `npx vite build --mode e2e` (uses `.env.e2e.local`, gitignored) then
  `STAGING_SMOKE_EMAIL=... STAGING_SMOKE_PASSWORD=... npm run test:e2e`.
- Staging carries NO GL/lease/document data. Data-dependent features render empty
  states there by design; the smoke suite asserts shells, not numbers.

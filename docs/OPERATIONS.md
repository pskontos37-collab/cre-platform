# Operations — deploy, rollback, backup, migrations, jobs

Verified where stated; anything unverified is marked. Updated 2026-08-05.

## Deploy (frontend)

**The committed `master` ref is the only deploy source.** On every green push to
master, CI (`.github/workflows/ci.yml`) runs gitleaks → typecheck (blocking) →
vitest (blocking) → `vite build` → prod-dep audit (critical-blocking) → then
`vercel deploy --prod` of the checkout. PRs get isolated preview URLs (no
`--prod`).

- ⚠️ `scripts/deploy_vercel.ps1` (working-tree SHA upload) is RETIRED for prod —
  it caused two clobbers, including the 2026-07-11 incident where a stray revert
  shipped a months-old shell.
- ⚠️ A Vercel preview/per-deploy URL is a DIFFERENT ORIGIN — the prod session
  never carries over to it.
- A parallel "Cancelled" CI run on a push is expected (concurrency group).
- Vercel builds with `vite build` only. The CI typecheck gate is what stops type
  errors from shipping — do not bypass it.

## Rollback (frontend)

Two options, fastest first:

1. **Vercel instant rollback**: Vercel dashboard → Project → Deployments → pick
   the previous production deployment → "Promote to Production" / "Instant
   Rollback". No rebuild; the old immutable deployment is re-aliased.
2. **Git revert**: `git revert <bad-sha>` on master, push — CI rebuilds and
   redeploys. Never `git reset`/force-push master.

Historical recovery recipe (total-loss case): production file contents are
retrievable from Vercel's deployment file APIs — the 2026-07-11 recovery pulled
the v6 tree + v8 file contents. Details in project memory
[[project-waterfall-selltoday]].

## Deploy (edge functions)

`scripts/deploy_edge.ps1 -Slug <function-name>` per function.

- ⚠️ BEFORE any redeploy: diff prod vs disk PER FILE — the condition is **0
  prod-only lines**, not a version match. Bundle wrappers, backslash-heavy
  lines and ANSI/UTF-8 reads all fake diffs (recipe in project memory
  [[project-audit-remediation]]).
- All 31 functions run `verify_jwt: true`; secrets come from Supabase function
  env (names in docs/ENVIRONMENT.md).
- CI does NOT check edge functions (it covers `src/` only). Parse them locally
  before pushing changes: `node_modules/.bin/esbuild --loader=ts < <file>`
  (verified 0 failures across all 37 files, 2026-08-05).

## Database migrations

- Ledger of record: `supabase_migrations.schema_migrations` — re-query BEFORE
  and AFTER any apply. `version` is a timestamp; the `20240xxx` number lives in
  `name`. Next free number: check the memory index (was **20240195** as of 8/04).
- Claim a number only at the instant of applying; write the identical .sql to
  `supabase/migrations/` and commit in the same breath. Gate any manual ledger
  INSERT on apply success.
- Applying = production DDL ⇒ owner-gated, per-turn approval.
- Known number dups (20240053/55/72/86/96) are harmless — Supabase keys by full
  name. Never renumber applied migrations.
- ⚠️ `create or replace view` silently strips `security_invoker` — restate it
  inline and verify `pg_class.reloptions` after. The two `v_gl_pnl_*` views are
  the deliberate exception (definer + inline guard; see docs/SECURITY.md).
- Postgres regex: `\b` is BACKSPACE; use `\y`.

### From-zero rebuild (disaster recovery by replay) — REHEARSED 2026-08-07

Order: (1) the 25 foundation files `20240001–23, 20240031, 20240045` in numeric
order — they have no ledger rows; (2) the ledger rows in `version` order (bodies
in `supabase/migrations/` + `recovered_from_prod/` at their timestamped
positions).

**Rehearsed against a fresh project (`cre-platform-staging`) on 2026-08-07: it
works, with eight documented patches** — see `docs/DR_REHEARSAL.md` for the full
drift ledger (untracked columns, one enum value, one hotfixed trigger function,
two dashboard-created storage buckets, one untracked function, and 7 data-only
migrations whose guards correctly refuse an empty database). Restore-from-backup
remains the PRIMARY DR path; replay is now a proven secondary.

### Staging environment

`cre-platform-staging` (ref `neftwjesayzsfggluuts`, us-west-1, $10/mo) carries
prod's full schema and the 26 property reference rows, no other data. Vercel
PR previews build against it (preview-scoped env vars), so previews can no
longer touch the production database. CI's `e2e-smoke` job runs the Playwright
suite (`e2e/`) against a staging build on every push/PR and BLOCKS production
deploys. Details + smoke-credential rotation: `docs/DR_REHEARSAL.md`.

## Backup / restore

**VERIFIED 2026-08-05 in the dashboard** (Database → Backups, org is on the
**Pro plan**):

- **Daily physical backups run and are retained 7 days** (observed: Jul 30 →
  Aug 5, one per day ~08:25–08:30 UTC ≈ midnight us-west-2). Each row has a
  one-click Restore.
- **PITR is NOT enabled** (available as a paid add-on). Acceptable gap for an
  internal tool: worst-case data loss is one day, recoverable from MRI +
  ingest sources. Enable later if tolerance shrinks.
- ⚠️ **Database backups DO NOT include Storage objects** (stated on the
  backups page): the `documents` bucket (16.4k files) is NOT in these backups —
  the database keeps only the metadata rows. Restoring a backup does not bring
  back deleted files.
- Storage exposure is bounded because originals also live on `V:\`/`K:\`
  network shares (ingest source), so Storage loss is recoverable by re-ingest —
  EXCEPT the 252 temp-path documents whose source bytes are gone (known issue).
- Restore procedure: dashboard → Database → Backups → Restore on the chosen
  daily row (project-wide, in-place). "Restore to new project" (beta) exists
  for non-destructive rehearsal.

## Scheduled / background jobs

| Job | Mechanism | Notes |
|---|---|---|
| Drive scan + import | nightly 01:00 (`drive-import`/`drive-inventory` + lockfile) | keep/kill decision open with owner |
| Nightly scan report email | Power Automate GETs `v_scan_report` once/night | view computes the digest on read |
| Recurring critical dates | `generate-recurring-events` edge fn | |
| Pipeline extract cron | `pipeline_extract_cron` migration | AI-dependent — dead while credits exhausted (KI-1) |
| Abstract refresh | `scripts/refresh_stale_abstracts.ps1` (manual/scheduled) | skips locked abstracts |
| Rent-roll term reconcile | `scripts/reconcile_rentroll_terms.ps1` | MANDATORY after every RR load |
| Option-notice reconcile | `scripts/reconcile_option_notices.ps1` | MANDATORY after every RR load |

## Monitoring / error tracking — MISSING (do not assume)

- No Sentry or frontend error reporting exists. Prod errors surface only via
  user reports (KI-5).
- Server-side: Supabase logs (`get_logs` MCP tool / dashboard) cover edge
  functions and Postgres; retention limited (~1 day via API) — check promptly
  when investigating.
- No uptime monitor. No health-check endpoint exists or is needed for the
  static SPA; Supabase platform status covers the backend.

## Environment separation — NONE (single environment)

There is exactly ONE Supabase project and ONE Vercel production app. No staging.
PR previews give isolated FRONTENDS but they point at the PRODUCTION database.
Treat every DB change as production. A staging Supabase project is the single
highest-leverage operational improvement available (cost → owner call).

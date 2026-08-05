# KNOWN_ISSUES

Severity scale: Critical / High / Medium / Low. Updated 2026-08-04.

---

## KI-1 · Critical · All AI features non-functional (Anthropic credits exhausted)

- **Description**: Anthropic account ran out of credits 8/02. Every AI feature is down: doc-brief, lease-abstract, abstract-verify, doc-ask, OCR, uw-extract, coi-extract, ic-memo, ppm-draft, market-reports, site plans.
- **Repro**: invoke any AI edge fn → returns 200 with `done:false` / zero progress in 500–1000 ms (a real segment takes 60–120 s). Masquerades as a resumable job.
- **Business impact**: abstract QA, document Q&A, all extraction pipelines halted.
- **Affected files**: all AI edge functions (`supabase/functions/*`); no code defect.
- **Status**: Blocked — owner action.
- **Resolution**: fund console.anthropic.com. Check balance BEFORE diagnosing "stuck" jobs.

## KI-2 · High · Email sends blocked (no RESEND_API_KEY / verified domain)

- **Description**: announcement-send, service-agreement-send, service-agreement-digest all require `RESEND_API_KEY` + a verified sending domain; neither exists.
- **Impact**: tenant announcements, agreement signature routing, digests cannot send. AR follow-up intentionally uses .eml drafts (not affected).
- **Status**: Blocked — owner action (create Resend account, verify domain, set secret).

## KI-3 · High · TypeScript errors ship silently (17 baseline)

- **Description**: Vercel builds with `vite build` (no tsc); CI typecheck is report-only. 17 pre-existing errors across 9 files.
- **Impact**: type regressions reach production unnoticed.
- **Status**: In progress this branch — burn down to 0, then flip CI typecheck to blocking.

## KI-4 · Medium · No linter/formatter configured

- **Description**: no ESLint/Prettier config anywhere in the repo; `eslint-disable` comments exist for editors that inject their own.
- **Impact**: style drift risk; some bug classes (exhaustive-deps) unchecked.
- **Status**: Documented gap. Deliberately NOT introduced mid-hardening (new toolchain = churn without a correctness win now). Recommend post-release.

## KI-5 · Medium · No error monitoring / observability on the frontend

- **Description**: no Sentry or equivalent; prod errors surface only if a user reports them. Edge fns have Supabase logs (`get_logs`) — adequate server-side.
- **Status**: Missing (do not invent). Owner decision post-release.

## KI-6 · Medium · Migrations never rehearsed against a clean database

- **Description**: 206 migrations applied incrementally to the live project over months; known duplicate numbers (20240053/55/72/86/96 — harmless, Supabase keys by full name). A from-zero replay has never been run, so disaster-recovery-by-replay is unproven.
- **Impact**: restore procedure depends on Supabase backups, not migration replay.
- **Status**: Documented in docs/OPERATIONS.md; rehearsal needs a scratch Supabase project (cost → owner call).

## KI-7 · Medium · Owner-blocked feature inputs (since 7/04)

- Lease-abstract TEMPLATE FORM (his form inputs never sent)
- 2026 budgets → budget-vs-actual
- `/onboarding` rent-roll upload test (he must pick the file)
- 3 abstract locks (Best Buy unlock→relock, Starbucks, Yard House)
- KM expirations source-of-truth call; `7031-00` re-map call; PH Developers' agreement; VTS creds; appraisals/monthly MRI GL+RR/insurance/tax bills
- **Status**: Blocked — enumerated so nothing is silently dropped.

## KI-8 · Medium · Credential rotation pending

- **Description**: sb_secret + jwt_secret rotation was recommended by the security audit and is still pending (owner-gated; rotating mid-session would break active integrations).
- **Status**: Blocked — owner action, coordinate a window.

## KI-9 · Low · 22 of 26 properties are name-only shells

- **Description**: only Gateway/Magnolia/KM East/KM West carry data. UI now collapses pending shells (shipped `6c26d4b`, 8/04) so the portfolio no longer reads as empty.
- **Status**: UI mitigated; populate-or-delete decision remains with owner.

## KI-10 · Low · Vitest environment slow-start

- **Description**: 169 unit tests take ~20 s, almost all jsdom environment setup (106 s cumulative env time). Pure-node lib tests pay the jsdom tax needlessly.
- **Status**: Optimization opportunity only (per-file `// @vitest-environment node`), not a release blocker.

## KI-12 · Medium · Migrations ledger is not complete apply history (RESOLVED where possible, 8/05)

- **Description**: Reconciling all 206 on-disk files against all 195 `schema_migrations` rows found two gaps:
  (a) **14 applied migrations had no source file in the repo** — applied via MCP but never committed
  (including `pnl_views_scope_by_entitlement`, the migration that guards the GL P&L views).
  (b) **25 foundation files (20240001–23, 20240031, 20240045) have no ledger rows** — dashboard-era applies.
- **Resolution**: (a) FIXED — all 14 bodies recovered verbatim from `schema_migrations.statements`
  into `supabase/migrations/recovered_from_prod/` (see its README; never re-apply).
  (b) Documented: a from-zero rebuild must run the 25 foundation files first, then the ledger.
- **Residual risk**: none for prod; replay-based disaster recovery remains unrehearsed (KI-6).

## KI-13 · Low · Advisor backlog (search_path, RLS initplan, policy sprawl, FK indexes)

- **Description**: Supabase advisors list 5 mutable-search_path functions, 18 RLS policies re-evaluating
  `auth.uid()` per row, 275 multiple-permissive-policy combos, 141 unindexed FKs (mostly `comps.*`),
  42 unused indexes, and `purge_policy` without a PK. Zero High/Critical security findings.
- **Impact**: performance headroom + hardening hygiene, not correctness. Detail + exact fixes in docs/SECURITY.md.
- **Status**: Backlog; each fix is a migration (owner-gated).

## KI-11 · Low · `sample-data/` and `run-remaining-migrations.sql` in repo root

- **Description**: `run-remaining-migrations.sql` (24 KB, June-era) predates the per-file migration ledger and could tempt a bulk re-run; sample-data is gitignored but present on disk.
- **Status**: Documented. Do NOT run the bulk SQL file; treat `supabase/migrations/` + `schema_migrations` as the only authorities.

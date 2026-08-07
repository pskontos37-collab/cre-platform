# KNOWN_ISSUES

Severity scale: Critical / High / Medium / Low. Updated 2026-08-07.

Every status below was re-verified against prod on 2026-08-07 — not carried forward from the
previous revision. Three entries had gone stale and made the platform read worse than it is
(KI-1 and KI-3 were both resolved days before this pass); they are corrected in place with the
evidence that settled them.

---

## KI-1 · RESOLVED 2026-08-05 · AI features were down (Anthropic credits exhausted 8/02)

- **What happened**: the Anthropic account ran out of credits on 8/02 and every AI feature
  stopped: doc-brief, lease-abstract, abstract-verify, doc-ask, OCR, uw-extract, coi-extract,
  ic-memo, ppm-draft, market-reports, site plans.
- **Evidence it is fixed**: the most recent successful AI writes are `doc_briefs.updated_at`
  **2026-08-05 15:51:53 UTC** and `lease_abstracts.updated_at` **2026-08-05 15:01:52 UTC** —
  both three days after the outage began. The doc-brief v14 run (Club Pilates 7/7, under-read
  cohort 61/61) completed in that window.
- ⚠️ **Keep the diagnostic**: credit exhaustion MASQUERADES as a resumable job — HTTP 200 with
  `done:false` and zero progress in 500–1000 ms, where a real segment takes 60–120 s. It can
  also surface disguised as an unrelated provider error. **Check the balance before diagnosing
  a "stuck" job.**
- **Status**: Resolved. No code defect ever existed.

## KI-2 · High · Email sends blocked (no RESEND_API_KEY / verified domain)

- **Description**: announcement-send, service-agreement-send, service-agreement-digest all
  require `RESEND_API_KEY` + a verified sending domain; neither exists.
- **Impact**: tenant announcements, agreement signature routing, digests cannot send. AR
  follow-up intentionally uses .eml drafts (not affected).
- **Status**: Blocked — owner action (create Resend account, verify domain, set secret).

## KI-3 · RESOLVED 2026-08-04 · TypeScript errors shipped silently (17 baseline)

- **What happened**: Vercel builds with `vite build` (no tsc) and CI typecheck was report-only,
  so 17 pre-existing errors across 9 files could mask new type regressions.
- **Evidence it is fixed**: the backlog was burned to **0** (commit `0f55821`), CI now runs
  `Type-check (blocking)` — verified in `.github/workflows/ci.yml` on master and green on the
  most recent push (`073efa9`, all jobs incl. deploy). Burning it down also surfaced two latent
  bugs: pptx compression was never applied, and site-plan captions never rendered.
- ⚠️ **The baseline is now 0, so any tsc error you see is yours.** Vercel still does not
  typecheck — CI is the only gate, and it covers `src/` only (edge functions need a separate
  esbuild parse).
- **Status**: Resolved.

## KI-4 · Medium · No linter/formatter configured

- **Description**: no ESLint/Prettier config anywhere in the repo; `eslint-disable` comments
  exist for editors that inject their own.
- **Impact**: style drift; some bug classes (exhaustive-deps) unchecked.
- **Status**: Open and now actionable — it was deferred as "post-release" during hardening, and
  that release has shipped. Expect a large first-run diff; land the config and the mechanical
  fixes as separate commits so review stays readable.

## KI-5 · Medium · No error monitoring / observability on the frontend

- **Description**: no Sentry or equivalent. A render-time throw takes out the subtree with no
  recovery path and no record — the failure mode already seen in practice, where an unhandled
  error rendered nothing below the toolbar because every render branch was false.
- **Mitigations already in place**: `vite:preloadError` self-heals the stale-chunk case after a
  deploy; edge functions have Supabase logs (`get_logs`), which is adequate server-side.
- **Status**: In progress — a React error boundary is being added so a thrown error shows a
  recovery UI instead of a blank region. Durable capture (persisting errors for later reading)
  remains a separate decision, since it needs a table and a write path.

## KI-6 · ~~Medium~~ RESOLVED 2026-08-07 · Migrations never rehearsed against a clean database

- **Resolution**: full from-zero replay executed onto the new `cre-platform-staging`
  project (owner approved $10/mo). 217/224 applied clean; 7 data-only migrations
  correctly guard-refused an empty DB; 8 drift patches documented in
  `docs/DR_REHEARSAL.md`. End-state fidelity verified: tables/views/policies/
  functions/enums all match prod exactly.
- **Follow-up (open, owner-gated)**: formalize the drift (5 untracked columns, 1 enum
  value, 2 functions, 2 storage buckets) as one no-op-on-prod migration so the repo
  alone can rebuild prod — needs a number claimed at apply time + owner's go.

## KI-7 · Medium · Owner-blocked feature inputs (since 7/04)

- Lease-abstract TEMPLATE FORM (his form inputs never sent)
- 2026 budgets → budget-vs-actual
- `/onboarding` rent-roll upload test (he must pick the file)
- 3 abstract locks (Best Buy unlock→relock, Starbucks, Yard House)
- KM expirations source-of-truth call; PH Developers' agreement; VTS creds;
  appraisals / monthly MRI GL+RR / insurance / tax bills
- **Status**: Blocked — enumerated so nothing is silently dropped.
- **Resolved from this list**: the `7031-00` re-map call — it was never actually a blocker
  (that account has no 2024 activity); shipped as migration `20240195`.

## KI-8 · Medium · Credential rotation pending

- **Description**: sb_secret + jwt_secret rotation was recommended by the security audit and is
  still pending (owner-gated; rotating mid-session would break active integrations).
- **Status**: Blocked — owner action, coordinate a window.

## KI-9 · Low · 16 of 21 owned properties are name-only shells

- **Description**: of 21 owned, non-pipeline properties, **4 carry data** — Magnolia Park
  (35 leases / 91,493 GL rows / 6,212 docs), Gateway Port Chester (25 / 73,809 / 5,113),
  KM East (38 / 49,286 / 1,429), KM West (14 / 23,061 / 826). Knightdale Consolidated is a
  roll-up: no leases by design, but 1,713 docs. The remaining **16 have zero leases, zero GL
  rows and zero documents** — nothing has been ingested for them at all.
- **Impact**: this is the single largest gap between the platform and a complete portfolio
  record. It is a data-acquisition task, not an engineering one.
- **Mitigation**: the UI collapses pending shells on `/properties` and excludes them from the
  `/financials` and `/pcf` pickers (both default to Gateway), all driven by
  `v_property_data_status.data_loaded`.
- **Status**: Owner action — supply source data (MRI exports + lease files) or decide to delete.

## KI-10 · Low · Vitest environment slow-start

- **Description**: the suite is **217 tests across 17 files**; most of the wall-clock is jsdom
  environment setup. Pure-node lib tests pay the jsdom tax needlessly.
- **Status**: Optimization only (per-file `// @vitest-environment node`), not a blocker.

## KI-11 · Low · `sample-data/` and `run-remaining-migrations.sql` in repo root

- **Description**: `run-remaining-migrations.sql` (24 KB, June-era) predates the per-file
  migration ledger and could tempt a bulk re-run; sample-data is gitignored but present on disk.
- **Status**: Documented. Do NOT run the bulk SQL file; treat `supabase/migrations/` +
  `schema_migrations` as the only authorities.

## KI-12 · RESOLVED 2026-08-05 · Migrations ledger was not a complete apply history

- **Description**: reconciling on-disk files against `schema_migrations` found two gaps:
  (a) **14 applied migrations had no source file in the repo** — applied via MCP, never
  committed (including `pnl_views_scope_by_entitlement`, which guards the GL P&L views).
  (b) **25 foundation files** (20240001–23, 20240031, 20240045) have no ledger rows.
- **Resolution**: (a) all 14 bodies recovered verbatim from `schema_migrations.statements` into
  `supabase/migrations/recovered_from_prod/` (see its README; **never re-apply**).
  (b) documented: a from-zero rebuild runs the 25 foundation files first, then ledger order.
- **Residual risk**: none for prod; replay-based DR was rehearsed 2026-08-07 (KI-6 resolved, see docs/DR_REHEARSAL.md).

## KI-13 · Low · Advisor backlog (re-measured 2026-08-07)

- **Security advisors — 2 ERROR, all understood**:
  - `security_definer_view` on `v_gl_pnl_monthly` and `v_gl_pnl_category`. **By design**: each
    carries an inline `can_access_property()` guard and the underlying matviews hold zero
    anon/authenticated grants. ⚠️ Anyone editing these views must preserve the WHERE clause.
  - 5 `function_search_path_mutable`: `comps.norm_label`, `comps.classify_label`,
    `comps.lookup_assumptions`, `comps.lookup_tenants`, `public.apply_abstract_overrides`.
  - 3 extensions in `public`: `vector`, `pg_net`, `btree_gist`.
- **Performance advisors**: RLS policies re-evaluating `auth.uid()` per row, multiple-permissive
  -policy combos, unindexed FKs (mostly `comps.*`), unused indexes, `purge_policy` without a PK.
- **Impact**: performance headroom + hardening hygiene, not correctness.
- **Status**: Backlog; each fix is a migration (owner-gated).

## KI-14 · Low · One SECURITY DEFINER function is executable by `anon`

- **Description**: `public.enforce_abstract_lock_action()` is SECURITY DEFINER and `anon` holds
  EXECUTE on it. This contradicts the documented anon posture in CLAUDE.md, which requires every
  new RPC to `revoke execute ... from public, anon`.
- **Measured scope**: it is the **only 1 of 51** public SECURITY DEFINER functions anon can
  execute — the other 50 are correctly blocked. A single missed revoke, not a systemic gap.
- **Practical risk: very low.** The function returns `trigger` and takes no arguments; Postgres
  refuses to call a trigger function directly, so there is no working exploit path. It is a
  posture deviation, not a live hole.
- **Status**: Open — one-line fix (`revoke execute on function
  public.enforce_abstract_lock_action() from public, anon;`), pending an authorized migration.

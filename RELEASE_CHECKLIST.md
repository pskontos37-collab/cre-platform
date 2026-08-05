# RELEASE_CHECKLIST

Statuses: Not started · In progress · Passed · Failed · Blocked · Not applicable
Updated: 2026-08-05 02:15 (release-hardening branch, worktree `cre-platform-rh`)

## Install / build / startup

| Item | Status | Evidence / notes |
|---|---|---|
| Clean dependency install (`npm ci` from committed lockfile) | Passed | 8/04 23:32 — exit 0, 422 packages, 56s (fresh worktree, no prior node_modules) |
| Dev server starts | Passed | 8/04 — `vite --port 5199`, HTTP 200; verified in browser with and without `.env` |
| Production build (`vite build`) succeeds | Passed | 8/04 23:40 — exit 0, 41.6s; served via `vite preview` → HTTP 200, correct title |
| Production startup | Passed | `vite preview` over dist/ → HTTP 200 (8/04); prod itself live at cre-platform-mjw2.vercel.app |
| Full gate (`tsc -b && vite build`) succeeds | Passed | tsc -b --force exit 0 (17→0 errors, commit `0f55821`) + build exit 0 |
| Clear error when required env vars missing | Passed | Live-verified banner: "Supabase not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY…", sign-in disabled |
| `.env.example` complete and secret-free | Passed | Both frontend vars as placeholders; full server-side name catalogue in docs/ENVIRONMENT.md |
| Edge functions parse (esbuild, CI blind spot) | Passed | 8/05 — 0 failures across 37 files (`--loader=ts`) |

## Code quality

| Item | Status | Evidence / notes |
|---|---|---|
| Type checker passes (0 errors) | Passed | Was 17 → 0 (`0f55821`); no unsafe casts introduced — all real fixes; 2 latent bugs found (pptx compression never applied; site-plan captions never rendered) |
| Linter | Not applicable | No ESLint config in repo — documented gap (KI-4), post-release decision |
| Formatter | Not applicable | No Prettier config; consistent hand-formatting |
| Dead code / unused deps review | Passed (spot) | TODO/FIXME/HACK/stub sweep: 0 matches in src/ + functions/; deps all imported (grep) |
| Dependency vulnerability scan | Passed w/ accepted risks | 9 advisories, none reachable in shipped bundle — analysis in docs/SECURITY.md; CI now gates critical prod-dep advisories |
| Secret scan | Passed | Local pattern sweep clean (2 known gitleaks:allow PEM literals); CI gitleaks blocking |

## Tests

| Item | Status | Evidence / notes |
|---|---|---|
| Unit tests pass | Passed | **200/200** (16 files), 8/04 23:52, exit 0 |
| No skipped/focused tests | Passed | grep `.skip(/.only(/.todo(` → 0 matches |
| Financial calcs independently verified | Passed | 31 new tests with hand-derived expectations (closed-form annuities, par-bond IRRs, hand-solved quadratic); existing waterfall suite uses golden JV fixtures |
| Integration tests (DB reads/writes) | Blocked | No test DB — single prod environment (docs/OPERATIONS.md). Compensating: read-only RLS/authz verification vs prod (7/30 full sweep + this pass) |
| E2E critical workflows | Partially passed | Login/startup/missing-env live-verified this pass; broader UI verified signed-in 8/01–8/03; no automated E2E (needs staging first — FEATURE_INVENTORY gap #1) |
| Negative tests (authz, invalid input) | Passed (lib layer) | access.test + leaseMath fail-closed tests + verifyStatus; server-side gates verified by SQL inspection |
| Cross-organization isolation | Not applicable | Single-firm tool. In-scope analogues verified: PM property-scoping (RLS + view guards), tenant-portal gateway |
| Role/permission tests pass | Passed | access.test green; destructive RPC gates (`_purge_guard`, `can_do_action`) verified against live function sources |

## Security

| Item | Status | Evidence / notes |
|---|---|---|
| Server-side auth on all protected surfaces | Passed | RLS everywhere; 31/31 edge fns verify_jwt; advisor sweep this pass |
| Authorization (roles, property scoping) | Passed | P&L view guards + matview grant wall + RPC gates verified read-only 8/04–05 (docs/SECURITY.md) |
| Anon role zero write privileges | Passed | 20240093/95/98 posture; re-affirmed by advisor output (no anon-writable surface flagged) |
| No secrets committed | Passed | See secret scan above |
| Critical/High findings fixed | Passed | **Zero Critical/High found this pass**; prior leak (2 `using(true)` policies) fixed by 20240156 |
| Sessions/tokens | Passed | Supabase Auth defaults; portal via gateway only |
| Rate limiting | Failed (accepted) | Platform defaults only — accepted for internal tool, documented |
| CORS restricted | Passed | `_shared/auth.ts` honors `ALLOWED_ORIGINS` |
| Security headers on frontend | Failed (documented) | vercel.json has no headers; recommended set + CSP caveat in docs/SECURITY.md backlog #7 |

## Database / data integrity

| Item | Status | Evidence / notes |
|---|---|---|
| Migrations clean-apply on empty DB | Blocked | Unrehearsed (KI-6); replay ORDER now documented incl. foundation files + recovered set |
| Ledger reconciled (disk vs `schema_migrations`) | Passed | Full 206-vs-195 name recon 8/05; 14 prod-only bodies RECOVERED into repo (`recovered_from_prod/`); 25 pre-ledger foundation files documented (KI-12) |
| FKs/constraints/indexes reviewed | Passed w/ backlog | Advisors: 141 unindexed FKs, 42 unused indexes, 1 missing PK — enumerated in docs/SECURITY.md backlog (KI-13) |
| Multi-step ops roll back cleanly | Passed (by design) | Multi-step writers are single plpgsql RPCs (`apply_mri_import`, `complete_property_onboarding`, purge suite) — one statement = one transaction; raises abort atomically |
| No production data altered this session | Passed | Read-only SELECTs only (verifiable in query list, WORKLOG) |

## CI / operations

| Item | Status | Evidence / notes |
|---|---|---|
| CI enforces: secrets, tests, build | Passed | Pre-existing (gitleaks + vitest + build block deploy) |
| CI enforces typecheck | Passed | Flipped to blocking (`8ddce3a`) after backlog burned to 0 |
| CI reproducible installs | Passed | `npm ci` + committed lockfile + setup-node cache (`8ddce3a`) |
| CI dependency audit | Passed | Blocking at critical for prod deps; full audit printed (`8ddce3a`); gate exits 0 today |
| Deployment documented | Passed | docs/OPERATIONS.md (verified commands) |
| Rollback documented | Passed | docs/OPERATIONS.md — Vercel instant rollback + git revert + total-loss recipe |
| Backup/restore documented | Passed | VERIFIED 8/05 in dashboard: Pro plan, daily physical backups, 7-day retention. PITR off (accepted). ⚠️ Storage objects NOT in backups — bounded by V:\/K:\ re-ingest (docs/OPERATIONS.md) |
| Monitoring / error tracking | Failed (documented) | None exists — KI-5, owner decision |
| Health checks | Not applicable | Static SPA + managed backend |
| Environment separation | Failed (documented) | Single prod environment; staging project recommended (docs/OPERATIONS.md) |

## Documentation

| Item | Status | Evidence / notes |
|---|---|---|
| README | Passed | Root README.md (verified commands) |
| Env var reference | Passed | docs/ENVIRONMENT.md (from exhaustive grep) |
| Feature-to-test matrix | Passed | docs/FEATURE_INVENTORY.md — 42 routes, honest statuses, 3 named gaps |
| Security notes | Passed | docs/SECURITY.md with per-claim evidence |
| Asset upload guide | Passed | ASSET_UPLOAD_GUIDE.md (grounded in code's accept= filters + doc-inbox caps) |
| Known limitations | Passed | KNOWN_ISSUES.md — 13 items with severity |

## Exit-criteria summary

Met: install ✓ build ✓ startup ✓ typecheck ✓ tests ✓ no skips ✓ no Crit/High security ✓
role/permission ✓ financial-calc independent verification ✓ env docs ✓ CI enforcement ✓
deploy/rollback docs ✓ asset guide ✓ known issues ✓.
Not met (all documented, none code-fixable from here): clean-DB migration rehearsal,
automated E2E (needs staging), backup-tier confirmation, monitoring, AI-feature
verification (credits), owner-blocked inputs (KI-7).

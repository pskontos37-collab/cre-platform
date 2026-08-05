# RELEASE_CHECKLIST

Statuses: Not started · In progress · Passed · Failed · Blocked · Not applicable
Updated: 2026-08-04 (release-hardening branch)

## Install / build / startup

| Item | Status | Evidence / notes |
|---|---|---|
| Clean dependency install (`npm ci` from committed lockfile) | In progress | lockfile committed `2fddd02`; ci-install run pending in worktree |
| Dev server starts | Not started | |
| Production build (`vite build`) succeeds | Not started | CI ran it green on `6c26d4b` push; re-verify locally on this branch |
| Full gate (`tsc -b && vite build`) succeeds | In progress | 17 tsc errors baseline — burn-down underway |
| Clear error when required env vars missing | Not started | verify `src/lib/supabase.ts` behavior without `.env` |
| `.env.example` complete and secret-free | In progress | frontend vars complete; add edge-fn secret NAMES to docs (not values) |

## Code quality

| Item | Status | Evidence / notes |
|---|---|---|
| Type checker passes (0 errors) | In progress | baseline 17 → target 0 |
| Linter | Not applicable | no ESLint config in repo; noted in KNOWN_ISSUES (tooling gap, not a release blocker for internal tool) |
| Formatter | Not applicable | no Prettier config; codebase is hand-formatted consistently |
| Dead code / unused deps review | Not started | |
| Dependency vulnerability scan (`npm audit`) | Not started | |
| Secret scan | In progress | CI gitleaks blocking (verified in ci.yml); local sweep pending |

## Tests

| Item | Status | Evidence / notes |
|---|---|---|
| Unit tests pass | Passed | 169/169, 8/04 23:19, exit 0 |
| No skipped/focused tests | Passed | grep `.skip(/.only(` in src → 0 matches (8/04) |
| Financial calcs independently verified | In progress | existing suites use hand-computed expectations; adding edge cases (proration, leap year, rounding) |
| Integration tests (DB reads/writes) | Blocked | no test DB; prod DB is live — read-only verification only. Documented as manual-verification item |
| E2E critical workflows | Blocked (partial) | UI verified signed-in 8/01+8/03 (renders, 0 console errors); AI flows down (credits); full E2E needs staging env |
| Negative tests (authz, invalid input) | In progress | access.test.ts covers permission rules; RLS verified live 7/30 (129/129 tables) |
| Cross-organization isolation | Not applicable | single-firm internal tool — no multi-tenancy. Tenant-portal isolation IS in scope: custom-auth gateway reviewed 7/x, see docs/SECURITY.md |
| Role/permission tests pass | Passed | `src/lib/__tests__/access.test.ts` (8 tests) green |

## Security

| Item | Status | Evidence / notes |
|---|---|---|
| Server-side auth on all protected surfaces | Passed | RLS on all tables; 31/31 edge fns `verify_jwt:true` (verified 7/x, memory) |
| Anon role has zero write privileges | Passed | migrations 20240093/95/98; posture re-verified 7/29 |
| No secrets committed | In progress | gitleaks green in CI; local re-sweep this session |
| Critical/High findings fixed | In progress | prior real leak (2 `using(true)` policies) fixed by 20240156; advisors re-run pending |
| Sessions/tokens handled correctly | Passed | Supabase Auth defaults; portal uses gateway only |
| Rate limiting where appropriate | Failed | none beyond Supabase platform defaults — documented as accepted risk for internal tool |
| CORS restricted | In progress | `_shared/auth.ts` reads `ALLOWED_ORIGINS` — verify value |
| Security headers on frontend | Not started | check vercel.json |

## Database / data integrity

| Item | Status | Evidence / notes |
|---|---|---|
| Migrations clean-apply on empty DB | Blocked | 206 migrations were applied incrementally to prod; no scratch DB available this session. Documented procedure + risk in docs/OPERATIONS.md |
| Ledger reconciled (disk vs `schema_migrations`) | In progress | re-query before/after any DB work; next free = 20240195 |
| FKs/constraints/indexes reviewed | In progress | advisors run pending (read-only) |
| Multi-step ops roll back cleanly | In progress | loaders use staged inserts; document transaction posture per writer |
| No production data altered this session | Passed | read-only SELECTs only |

## CI / operations

| Item | Status | Evidence / notes |
|---|---|---|
| CI enforces: secrets, tests, build | Passed | ci.yml — gitleaks + vitest + vite build block deploy |
| CI enforces typecheck | In progress | report-only until 0 errors; flip on this branch |
| CI uses reproducible installs (`npm ci`) | In progress | lockfile now committed; ci.yml edit pending |
| Deployment documented | In progress | docs/OPERATIONS.md |
| Rollback documented | In progress | docs/OPERATIONS.md (Vercel redeploy of prior deployment; 7/11 recovery recipe) |
| Backup/restore documented | In progress | Supabase managed backups — verify tier + document; mark gaps honestly |
| Monitoring / error tracking | Failed | none exists (no Sentry etc.) — documented as missing, owner decision |
| Health checks | Not applicable | static SPA + managed backend; no app server to health-check. Supabase status = platform |

## Documentation

| Item | Status | Evidence / notes |
|---|---|---|
| README | In progress | root README.md to be created (CLAUDE.md is agent-facing) |
| Env var reference | In progress | docs/ENVIRONMENT.md |
| Feature-to-test matrix | In progress | docs/FEATURE_INVENTORY.md |
| Asset upload guide | In progress | ASSET_UPLOAD_GUIDE.md |
| Known limitations | In progress | KNOWN_ISSUES.md |

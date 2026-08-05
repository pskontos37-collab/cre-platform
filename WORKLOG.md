# WORKLOG — release-hardening

Newest entries at the top. Times local (America/Chicago).

---

## 2026-08-05 (merge session) — Reconvergence with master, merge + push authorized by owner

Master had moved 3 commits while the branch waited (`bc31b65` independently cleared the SAME
17-error tsc backlog and flipped CI typecheck to blocking; `9189517`/`aaf26f3` closed the last
PCF bridge defects + picker default). Rather than fight 10 overlap conflicts, the branch was
REBUILT from origin/master (`release-hardening-v2`): master's deployed versions win every
overlap file; cherry-picked the five commits that are purely additive (lockfile+ledgers,
tracking files, 31 money tests, security review + 14 recovered migrations, docs); re-applied
the two still-missing pieces on top — ci.yml `npm ci`+cache+critical-prod-audit gate, and the
site-plan caption wiring in PipelinePage (`title?: string` to match master's deck type).

**Correction to the 8/04 entry**: the sibling session verified empirically that pptxgenjs 3.12
drops the compression option whenever `outputType` is explicit (byte-identical packages), so
my `write({compression:true})` relocation was a no-op — master's resolution (remove + document)
is the accepted one. Decks export uncompressed, as they always have.

Verification on the rebuilt branch before push: `tsc -b --force` (first run read), vitest,
`vite build` — results recorded below in this entry's evidence table by the merge commit.

## 2026-08-04 23:40 – 2026-08-05 02:20 — Typecheck burn-down, CI hardening, money-engine tests, security/DB review, docs

**Work performed + results (exact commands in RELEASE_CHECKLIST evidence column)**
1. **tsc 17 → 0** (`0f55821`): all 9 files fixed properly — two latent BUGS found and fixed
   (pptxgenjs `compression` was an ignored instance property → moved into `write()` where it
   actually compresses; meeting-deck site-plan captions were never passed by the caller → wired
   through). No suppressions, no unsafe casts. `tsc -b --force` exit 0; vitest still green.
2. **CI hardened** (`8ddce3a`): typecheck now BLOCKING; `npm ci` + node cache; new blocking gate
   on critical prod-dep advisories (`npm audit --omit=dev --audit-level=critical`, exits 0 today).
3. **31 new unit tests** (`29318e8`) for the three untested money engines (acqUnderwriting,
   tenantUnderwriting, distributionLedger) — every expectation hand-derived (par-bond IRRs,
   closed-form annuity 65,051.435/969,144.56, hand-solved quadratic IRR 0.1104701). Suite 200/200.
4. **Security review** (`0a95eb2`): secret sweep clean; npm audit analyzed (9 advisories, none
   reachable in bundle); Supabase advisors run; EVERY claim verified read-only against live SQL —
   verdict **no Critical/High**. The two advisor ERRORs (definer P&L views) are the deliberate
   matview-guard pattern: inline `can_access_property()` + zero API grants on the matviews.
   Destructive RPCs verified gated (`_purge_guard`, `can_do_action`).
5. **Ledger reconciliation** (`0a95eb2`): 206 disk files vs 195 DB rows → **14 applied migrations
   had no source in the repo**; all 14 bodies recovered VERBATIM from
   `schema_migrations.statements` (base64 round-trip) into `supabase/migrations/recovered_from_prod/`
   + README. 25 foundation files documented as pre-ledger. KI-12/13 added.
6. **Edge-fn parse gate**: esbuild `--loader=ts` over all 37 files — 0 failures.
7. **Phase 4 verified live**: `npm ci` exit 0 (422 pkgs); dev server with/without `.env` (banner
   verified in browser); `vite build` exit 0; `vite preview` HTTP 200.
8. **Docs**: README.md, docs/OPERATIONS.md (deploy/rollback/backup/jobs/single-env warning),
   docs/ENVIRONMENT.md (exhaustive env catalogue), docs/FEATURE_INVENTORY.md (42 routes,
   honest statuses, 3 named gaps), docs/SECURITY.md (per-claim evidence).

**Problems encountered**
- vitest float assertion on refi math (IEEE754 …99994) → assertion precision corrected, not code.
- Windows /tmp vs node path resolution; last-line-no-newline dropped the 14th recovered file —
  both caught by count checks and fixed.

**Decisions made**
- react-router v6→v7 and vite 8/vitest 4 major bumps deliberately DEFERRED (advisories not
  exploitable as used / dev-only; mid-hardening major bumps = churn risk). Documented.
- Recovered migrations live in a subfolder so nothing can ever re-apply them.
- No new linter/formatter/monitoring invented mid-pass — documented as gaps instead.

**Next action**: final full-gate re-run on the finished tree, commit tracking files, final report.

## 2026-08-04 23:05–23:40 — Session start: inspect, isolate, checkpoint

**Work performed**
- Inspected git state of shared checkout `cre-platform`: master @ `5957bed`, in sync with origin; 4 dirty paths + untracked `package-lock.json`.
- Ran baseline verification (commands + results below).
- **Detected concurrent session activity**: between 23:04 and 23:20, a sibling session in the same checkout built (`dist/` 23:18), committed `6c26d4b` "Collapse the 22 pending-onboarding properties and default the Financials picker" (exactly the working-tree WIP), and pushed it (origin/master == local master == `6c26d4b`; CI auto-deploys pushes to master).
- Mitigation: restored the shared checkout to `master`; created branch `release-hardening` and an **isolated worktree** `../cre-platform-rh` so no concurrent session can interleave with this work.
- Preserved remaining uncommitted state on the branch: `package-lock.json` (untracked since 7/30) + two OCR/reindex progress ledgers → commit `2fddd02`.
- Swept for TODO/FIXME/HACK/skipped tests/ts-ignores: **0 matches** in `src/` and `supabase/functions/` (only deliberate `react-hooks/exhaustive-deps` eslint-disables, 14 sites).
- Mapped env vars: frontend uses only `VITE_SUPABASE_URL`+`VITE_SUPABASE_ANON_KEY`; edge fns use ~40 server-side vars (catalogued for docs/ENVIRONMENT.md).
- Mapped 42 routes from `src/App.tsx` for the feature inventory.
- Created PROJECT_STATUS.md, RELEASE_CHECKLIST.md, WORKLOG.md, KNOWN_ISSUES.md, ASSET_UPLOAD_GUIDE.md.

**Commands executed (exact) and results**
| Command | Result |
|---|---|
| `npx vitest run` (Node 22.23.1) | exit 0 — **13 files, 169 tests, 169 passed**, 0 skipped, 20.1s |
| `npx tsc -b` (fresh, tsbuildinfo removed) | exit 1 — **17 errors** in 9 files: PipelineMeetingDeck(5), InvestmentSummaryPpt(3), AgreementAbstractReport(2), ManagementPage(2), vite.config(1), waterfallExcel(1), serviceAgreement/renderPdf(1), AbstractReport(1), usePcf(1) |
| `git rev-list --left-right --count origin/master...HEAD` | `0 0` (in sync, twice: before and after sibling push) |
| grep skipped/focused tests | 0 matches |

**Files changed**
- New branch `release-hardening` + worktree `cre-platform-rh`
- Commit `2fddd02`: package-lock.json, scripts/ocr_text_done_s0.txt, scripts/reindex_text_done_s0.txt
- New: PROJECT_STATUS.md, RELEASE_CHECKLIST.md, WORKLOG.md, KNOWN_ISSUES.md, ASSET_UPLOAD_GUIDE.md

**Problems encountered**
- Concurrent-session commit under my feet mid-inspection (see above) — resolved via worktree isolation; no work lost.

**Decisions made**
- All session work stays on `release-hardening`, **never pushed** (push ⇒ CI ⇒ prod deploy, which needs the owner's go).
- Linter/formatter: none configured in repo; treating as documented tooling gap rather than introducing new toolchain mid-hardening (minimal disruption).

**Next action**: tsc error burn-down (17 → 0).

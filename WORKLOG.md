# WORKLOG — release-hardening

Newest entries at the top. Times local (America/Chicago).

---

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

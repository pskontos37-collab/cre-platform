# PROJECT_STATUS

> Persistent session state for the release-candidate hardening effort.
> Updated: 2026-08-04 23:35 (release-hardening session). Supersedes `docs/PROJECT-STATUS.md` (2026-07 era).

## Current architecture

Single-page React app talking directly to Supabase (Postgres + Auth + Storage + RLS)
via the anon key; privileged work runs in 31 Deno edge functions (`supabase/functions/`)
executing as `service_role` behind JWT verification. AI features call Anthropic
(fallback OpenAI for some QA paths), embeddings via Voyage, email via Resend.
No app server of our own; Vercel serves the static bundle.

- Frontend: React 18 + TypeScript + Vite + Tailwind v3, React Router v6 (42 routes)
- Auth: Supabase Auth (staff); tenant portal (`/portal`) uses a CUSTOM auth scheme through the edge-function gateway only
- DB: ~129 tables / ~41 views, RLS on everything; `is_admin_or_am()` + `can_access_property(uuid)` helpers
- Roles: admin, asset_manager, property_manager (+ entitlements table for scoping)
- Storage: single `documents` bucket (signed URLs; service-role signing in edge fns)
- Reports: @react-pdf/renderer, exceljs, docx, pptxgenjs (client-side generation)

## Technology stack

| Layer | Choice |
|---|---|
| Frontend | React 18.3, TypeScript 5.5, Vite 5.4, Tailwind 3.4 |
| Backend | Supabase (project ref `vsqcykdpilfaockyfhuk`), Deno edge functions |
| AI | Anthropic Claude (primary), OpenAI (QA fallback), Voyage (embeddings/rerank) |
| Email | Resend (BLOCKED: no API key / verified domain) |
| Tests | Vitest 2.1 + jsdom + Testing Library |
| Hosting | Vercel (app `cre-platform-mjw2.vercel.app`) + Supabase |
| CI | GitHub Actions (`.github/workflows/ci.yml`): gitleaks (blocking), vitest (blocking), typecheck (report-only), vite build, auto-deploy committed master to Vercel prod |

## Current branch

- **Work happens in `release-hardening`**, in a dedicated worktree at
  `C:\Users\pskontos\Desktop\Software\cre-platform-rh` (isolated because the main
  checkout `cre-platform` is shared by concurrent sessions — one committed+pushed
  under this session at 23:20 on 8/04).
- Base: `master` @ `6c26d4b` ("Collapse the 22 pending-onboarding properties…"), in sync with `origin/master`.
- **Nothing from this session is pushed.** Pushing master auto-deploys to production via CI, and deploys require the owner's go.

## Startup / test / build / database commands

```bash
# install (Node 22 at ~\node\node-v22.23.1-win-x64 on this machine)
npm ci            # lockfile committed on release-hardening (2fddd02)

# develop
npm run dev       # http://localhost:5173  (needs .env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)

# verify
npm run test:run  # vitest single run — 169 tests, all green as of 8/04
npm run typecheck # tsc -b — baseline was 17 errors; burn-down in progress this branch
npm run build     # tsc -b && vite build (full gate)
npm run build:ci  # vite build only (what Vercel/CI run — DOES NOT TYPECHECK)
```

Database: migrations in `supabase/migrations/` (206 files), applied via Supabase MCP
`apply_migration` (needs owner's go per-turn) or dashboard SQL editor. Ledger of
record = `supabase_migrations.schema_migrations` (query it; do not trust file names
or commit messages). Next free number per memory: **20240195**.
Edge functions deploy via `scripts/deploy_edge.ps1 -Slug <fn>`.

## Major completed features (verified working before this session)

Dashboard w/ role presets · Properties hub · Financials (GL/NOI) · PCF (`/pcf`, FY2025/26 tie-outs) ·
Waterfall sell-today engine (`/waterfall`) · Investor reporting + returns · Monthly reports ·
Rent rolls (MRI, reconciled) · Lease abstracts + Review Center QA (`/review`, standing data-quality checks) ·
Doc corpus 16.4k docs + doc-ask RAG · Clauses/exclusives/critical dates · Work orders + tenant portal ·
Service agreements (builder/tracker) · COI tracker · Announcements (send BLOCKED on Resend) ·
AR follow-up · Transactions · Forms · Emergency manuals · Inspections · Acq pipeline + comps (113k assumptions) ·
Underwriting extract · PPM generator · Site plans · Admin panel (users/templates/settings) · Audit trust layer (Phases 0–3b)

## Current incomplete features / blockers

See `KNOWN_ISSUES.md` for the full ledger. Headlines:

1. **ALL AI features down — Anthropic credits exhausted 8/02** (owner action: fund account).
2. Email sends blocked — no `RESEND_API_KEY` / verified domain (announcements, service-agreement send, digests).
3. `/onboarding` rent-roll upload untested — owner must pick the file.
4. 17 tsc errors baseline (report-only in CI) — being fixed on this branch.
5. Lease-abstract TEMPLATE FORM + 2026 budgets — owner inputs missing since 7/04.
6. 22 of 26 properties are name-only shells (UI now collapses them — shipped 8/04 by sibling session).
7. Credential rotation pending (sb_secret, jwt_secret) — owner action.
8. 3 abstract locks (Best Buy, Starbucks, Yard House), KM expirations source-of-truth, `7031-00` mapping — owner calls.

## Most recent verified state (2026-08-04 23:20–23:30)

- `vitest run`: **169/169 pass** (13 files) — exit 0
- `tsc -b`: **17 errors** across 9 files (baseline; none in files touched by the 8/04 commit)
- Working tree deltas beyond master preserved on this branch as `2fddd02` (lockfile + OCR/reindex ledgers)
- Production: `https://cre-platform-mjw2.vercel.app` — live; last deploy = CI from `6c26d4b` push (sibling session, ~23:20 8/04)

# CRE Asset Management Platform

Internal asset-management platform for M&J Wilkow's commercial real estate
portfolio (~80% retail / 20% office). Single-firm, staff-only; a separate
tenant portal (`/portal`) uses a custom auth scheme through an edge-function
gateway. Production: Vercel (SPA) + Supabase (Postgres/Auth/Storage/RLS +
31 Deno edge functions).

> Agent/contributor conventions live in [CLAUDE.md](CLAUDE.md).
> Session state for the release-hardening effort: [PROJECT_STATUS.md](PROJECT_STATUS.md),
> [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), [KNOWN_ISSUES.md](KNOWN_ISSUES.md),
> [WORKLOG.md](WORKLOG.md), [ASSET_UPLOAD_GUIDE.md](ASSET_UPLOAD_GUIDE.md).

## Quickstart (verified 2026-08-04)

```bash
npm ci                 # reproducible install from the committed lockfile
cp .env.example .env   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev            # http://localhost:5173
```

Without a filled `.env` the app still boots and shows a clear banner on the
login page ("Supabase not configured…") with sign-in disabled.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run test:run` | Vitest suite (200 tests) — blocking in CI |
| `npm run typecheck` | `tsc -b` — **blocking in CI** since 2026-08-04 |
| `npm run build` | Full gate: `tsc -b && vite build` |
| `npm run build:ci` | `vite build` only (what Vercel runs) |

## Repository layout

| Path | Contents |
|---|---|
| `src/pages/` | 42 routed pages (React Router v6) |
| `src/lib/` | Pure business logic — waterfall/IRR engines, financials, underwriting; fully unit-tested |
| `src/lib/__tests__/` | 16 Vitest suites, 200 tests |
| `src/reports/` | Client-side PDF (@react-pdf), Excel (exceljs), PPTX (pptxgenjs) generators |
| `supabase/migrations/` | 206 numbered migrations + `recovered_from_prod/` (see its README) |
| `supabase/functions/` | 31 Deno edge functions (all `verify_jwt: true`) |
| `scripts/` | PowerShell operational tooling (loaders, reconciliation, deploys) |
| `docs/` | [OPERATIONS](docs/OPERATIONS.md) · [SECURITY](docs/SECURITY.md) · [ENVIRONMENT](docs/ENVIRONMENT.md) · [FEATURE_INVENTORY](docs/FEATURE_INVENTORY.md) + feature specs |

## Deployment (summary — full detail in docs/OPERATIONS.md)

Push to `master` → GitHub Actions: gitleaks (blocking) → typecheck + tests +
build (blocking) → prod-dep audit (blocking at critical) → `vercel deploy --prod`
of the **committed ref**. Never deploy the working tree. Edge functions deploy
individually via `scripts/deploy_edge.ps1 -Slug <fn>`. Database changes go
through Supabase migrations — the ledger
(`supabase_migrations.schema_migrations`) is the only authority.

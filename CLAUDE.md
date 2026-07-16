# CRE Asset Management Platform

Internal tool for managing a commercial real estate portfolio (~80% retail, 20% office).
Single-firm, desktop-only. No LP/investor logins — internal staff only.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Tailwind CSS v3 |
| Build tool | Vite |
| Backend / DB | Supabase (managed Postgres + Auth + Storage + RLS) |
| AI (Phase 4) | Anthropic Claude API |
| Testing | Vitest |
| Hosting | Vercel (frontend) + Supabase (backend) |

## How to run

**Prerequisites:** Node.js LTS (nodejs.org) and a Supabase project (supabase.com).

```bash
# 1. Install dependencies (one-time)
npm install

# 2. Copy env file and fill in your Supabase URL + anon key
cp .env.example .env

# 3. Start development server
npm run dev
# Opens at http://localhost:5173

# 4. Run tests
npm test          # watch mode
npm run test:run  # single run (CI)
```

## Supabase setup

Run migrations in `supabase/migrations/` in numeric order.
Use the Supabase dashboard → SQL editor, or the Supabase CLI (`supabase db push`).

| File | What it creates |
|---|---|
| 20240001_extensions.sql | uuid-ossp, pgvector extensions |
| 20240002_enums.sql | All Postgres enum types |
| 20240003_portfolio_properties.sql | portfolios, properties, units |
| 20240004_tenants_leases.sql | tenants, leases, options, co-tenancy |
| 20240005_financials.sql | financial_periods, operating_line_items, loans |
| 20240006_capital_waterfall.sql | deals, waterfall_tiers, capital_accounts, distributions |
| 20240007_documents.sql | documents, document_chunks (vector), inspections |
| 20240008_users_access.sql | users, entitlements, auth trigger |
| 20240009_rls.sql | Row Level Security policies on every table |
| 20240010_audit_log.sql | audit_log with auto-triggers |
| 20240011_indexes.sql | Performance indexes |

Later migrations (20240012+) are feature migrations — see each feature's notes in the
project memory.

### Migration numbering protocol (multiple sessions work this repo in parallel)

- Supabase records migrations by FULL NAME, not number — duplicate numbers on disk
  are ugly but harmless. Known number dups: 20240053, 20240055, 20240072, 20240086,
  20240096. Do not renumber applied migrations.
- Before claiming a number, check BOTH the `supabase/migrations/` directory on disk
  (a parallel session may have claimed a file without applying it yet) AND the
  database (`supabase_migrations.schema_migrations` or `list_migrations`), AND the
  "next free" pointer in the project memory index.
- After applying via MCP `apply_migration`, always write the identical .sql file to
  `supabase/migrations/` and commit it — the repo must reflect the prod schema.
  (Three applied migrations sat untracked for days; recoverable only because
  nothing deleted them.)

## Architecture decisions

### Why Supabase
Managed Postgres with built-in auth, RLS, and file storage — all in one place.
RLS policies (in 20240009_rls.sql) enforce access at the database level,
so even a bug in application code cannot expose another user's data.

### Roles
- `admin` — full access, user management, audit log
- `asset_manager` — full portfolio visibility, all financial and capital data
- `property_manager` — scoped to assigned properties; can upload documents

### Entitlements
The `entitlements` table grants per-user, per-resource access. `scope` values:
- `global` — sees everything (used for admin / asset manager)
- `portfolio` — sees all properties in a named portfolio
- `property` — sees one specific property
- `fund` — sees all properties in a fund

Two RLS helper functions enforce this: `is_admin_or_am()` and `can_access_property(uuid)`.
They live inside the database and cannot be spoofed by the application.

### Anon-role posture (migration 20240098)
The anon key ships in the browser bundle, so the `anon` role holds ZERO write
privileges on public tables (revoked wholesale, including default privileges for
future tables) and no EXECUTE on SECURITY DEFINER RPCs (migrations 20240093/95 —
note a plain `revoke from anon` is not enough; the default PUBLIC grant must be
revoked too). All writes come from `authenticated` staff (gated by RLS) or edge
functions running as `service_role`. The tenant portal uses the anon key only to
invoke the edge-function gateway, never PostgREST. Keep it this way: new RPCs get
`revoke execute ... from public, anon; grant execute ... to authenticated, service_role;`.

### Waterfall engine
`src/lib/waterfall.ts` — pure TypeScript, zero database calls, fully testable.
Tests: `src/lib/__tests__/waterfall.test.ts`

Three engines live here:
- `computeWaterfall(input)` — the simple single-lump sequential distributor described below.
- `computeIrrWaterfall(input)` / `runIrrWaterfall(...)` — a **true IRR-hurdle solver** over *dated* cash flows.
  It finds the exact distribution that carries the LP to each tier's `hurdle_irr` before the promote steps up,
  using the fact that XNPV is linear in an added cash flow at a fixed rate (`cashToHitIrr` is closed-form, no
  nested root-finding). Supports equity-multiple caps (`hurdle_em`, lesser-of semantics), hurdle-freeze dates,
  and senior unit classes (`SeniorClassPosition`, e.g. Gateway's Class D). Also exports `xnpv` / `xirr`
  (Actual/365). Tests: `src/lib/__tests__/irrWaterfall.test.ts`.
- `computeSellToday(input)` — the "sold today" orchestrator used by `/waterfall`: turns a hypothetical sale
  (value, closing %, net current assets, payoff) into net proceeds and runs them through BOTH waterfall layers
  on each partner's actual dated flow history (`capital_flows` table), including Knightdale's $73M sale-price
  override and cash-on-hand split. Layer 2 values each unit class (B-unit hypothetical liquidation value).

Payment order per distribution event:
1. Preferred equity: pay return (cash or PIK accrual) + redeem principal when current
2. Return of LP capital (pro-rata by initial contribution)
3. LP preferred return (accrues on unreturned capital at pref_rate)
4. GP catch-up (100% to GP until GP reaches its promote %)
5. Promote split (remaining cash splits LP/GP per the tier percentages)

All parameters are deal-specific — nothing is hard-coded.
Stored in `waterfall_tiers` table; sell-today defaults in `deals.selltoday` jsonb.
Net current assets default is computed from the latest GL year via the `property_nca(pid)` RPC
(migration 20240074) with a manual override in the UI.

### Financial calculations
`src/lib/financials.ts` — NOI, DSCR, WALT, occupancy, trailing-12.
Tests: `src/lib/__tests__/financials.test.ts`

- **NOI** = Σ income lines − Σ operating expense lines. Capex excluded.
- **DSCR** = trailing_12_NOI ÷ annual_debt_service per loan
- **WALT** = Σ(leasedSF × remainingTermYears) ÷ totalLeasedSF
- All monetary amounts stored as `numeric` (dollars, not cents)
- Percentages stored as decimals: 0.08 = 8%

### Co-tenancy flagging
When a co-tenancy clause is triggered:
1. A `co_tenancy_flags` row is created with `status = 'pending_review'`
2. The flag includes: plain-language trigger reason, remedy description, source document IDs
3. Dashboard surfaces it as an alert with a confirm/dismiss action
4. Human confirmation writes `status = 'confirmed'` and logs to `audit_log`

### Excel import pipeline (Phase 3)
Operating statements arrive as MTD actual/budget/variance + YTD actual/budget/variance.
Import jobs tracked in `import_jobs` with `column_mapping` jsonb (user maps columns to model fields).

### Document AI / RAG (Phase 4)
`document_chunks` stores text with `vector(1536)` embeddings via pgvector.

## Conventions

- All IDs: UUID v4
- Monetary amounts: `numeric` in dollars (e.g. `1500000.00`)
- Dates: `date` type (no time) unless timestamp matters
- Percentages: decimals (`0.08` = 8%, not `8`)
- `updated_at`: updated by application code (not a DB trigger)
- Retail-specific fields (`has_co_tenancy_clause`, `has_exclusives`, `percentage_rent_rate`, etc.)
  are stored on all leases but only shown in the UI when `lease.lease_type = 'retail'`
- Office-specific fields (`base_year`, `expense_stop_amount`) same pattern
- Keep PowerShell scripts ASCII (no smart quotes / em dashes) — PS 5.1 reads them as ANSI
- Straight quotes only in TS/TSX code (smart-quote delimiters break esbuild)

## Deploys

- Frontend: `scripts/deploy_vercel.ps1` (SHA upload of the working tree; Vercel builds with
  `vite build` per vercel.json — tsc is NOT run, so type errors do not block deploys)
- Edge functions: `scripts/deploy_edge.ps1 -Slug <fn>`
- ⚠️ The working tree IS the deploy source. Commit regularly — on 2026-07-11 a stray
  `git checkout`-style revert of tracked files shipped a months-old app shell to production
  (recovered from Vercel deployment file APIs: v6 tree + v8 file contents).

## Key accounts you will need

| Service | URL | Purpose |
|---|---|---|
| Supabase | supabase.com | Database, auth, file storage |
| Anthropic | console.anthropic.com | AI API key (Phase 4) |
| Vercel | vercel.com | Frontend hosting |

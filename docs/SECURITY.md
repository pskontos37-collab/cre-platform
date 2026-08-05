# Security review — release-hardening pass (2026-08-04/05)

Method: local secret sweep over tracked files, `npm audit` (full + prod-only),
Supabase security + performance advisors, and read-only SQL verification of every
advisor claim against live grants and function sources. **No production data or
schema was changed.**

## Verdict

**No Critical or High findings.** The two advisor ERRORs are verified by-design
(details below). Accepted risks and backlog items are enumerated with rationale.

## Verified-sound (with evidence)

| Surface | Verdict | Evidence (2026-08-04/05, read-only) |
|---|---|---|
| GL P&L views `v_gl_pnl_monthly` / `v_gl_pnl_category` | **By-design**, not a leak | Advisor flags SECURITY DEFINER (ERROR 0010). Definitions carry an inline `where can_access_property(property_id)` predicate — `auth.uid()` resolves to the real caller inside a definer view, so rows are scoped per caller. Definer mode is REQUIRED: they read matviews (no RLS possible). Origin migration `pnl_views_scope_by_entitlement` (recovered, see `supabase/migrations/recovered_from_prod/`) documents this exactly. ⚠️ Fragile pattern: anyone editing these views MUST keep the WHERE clause — `create or replace view` without it reopens an all-portfolio read. |
| Matviews `mv_gl_pnl_monthly` / `mv_gl_pnl_category` | Sound | **Zero** anon/authenticated grants — unreachable via PostgREST; only the guarded views read them. |
| Destructive RPCs (`property_purge_*`) | Sound | Every execute path begins `perform _purge_guard()`; `_purge_guard` checks admin and raises. |
| `apply_mri_import`, `complete_property_onboarding` | Sound | Gate on `can_do_action(...)` (raises `not permitted` otherwise). |
| `close_pipeline_deal` | Sound | Internal `is_admin`-class guard + raise. |
| `enforce_abstract_lock_action` anon-EXECUTE (advisor WARN) | Noise | Returns `trigger` — PostgREST cannot invoke trigger-returning functions via `/rpc/`. |
| Access helpers callable by `authenticated` (`is_admin`, `can_access_property`, `assignable_users`, …) | By design | They exist to be called by signed-in clients; each reads only the caller's own entitlement state. |
| Secrets in repo | Clean | Pattern sweep over all tracked files: only the two known PEM-header string literals in `drive-import`/`drive-inventory` (strip markers, `gitleaks:allow`, not key material). CI runs gitleaks blocking on every push. |
| Frontend env | Clean | Only `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` reach the bundle (anon key is public by design; anon role has zero write privileges per 20240093/95/98). |
| Open-redirect exposure (react-router advisories) | Not exploitable as used | No `navigate()`/`<Link>` target ever comes from a query param or external input (grep-verified); no `redirect=` param handling; no SSR (deserializeErrors path absent). |

## Dependency audit (npm, 2026-08-04)

9 advisories total (7 moderate / 1 high / 1 critical) — **none reachable in the
shipped bundle**:

- `vitest` (critical) + `vite`/`esbuild` (high/moderate): dev-server/test-UI attack
  surface only; devDependencies, never deployed. Fix = vite 8 / vitest 4 major bumps —
  recommended as separate post-release work, not mid-hardening churn.
- `react-router[-dom]` (moderate, open redirect/XSS): ships to prod but requires
  attacker-controlled navigation targets, which this app never constructs (verified
  above). Real fix is the v7 major migration — post-release.
- `exceljs → uuid` (moderate): npm's "fix" is a downgrade to exceljs 3.4 (wrong
  direction); the uuid buffer-bounds issue needs an attacker-supplied `buf` argument
  that never occurs here.

CI now blocks on **critical advisories in production deps** (`npm audit --omit=dev
--audit-level=critical`) and prints the full audit for visibility.

## Backlog (documented, not release-blocking)

1. **Advisor WARNs — function search_path mutable** (5 fns: `comps.norm_label`,
   `comps.classify_label`, `comps.lookup_assumptions`, `comps.lookup_tenants`,
   `public.apply_abstract_overrides`): add `set search_path = <schema>, pg_temp`.
   One migration, owner-gated.
2. **RLS initplan re-evaluation** (18 policies, e.g. `documents_insert`,
   `users_select_own`): wrap `auth.uid()`/`current_setting()` in `(select …)` so it
   evaluates once per query, not per row. Matters at document_chunks scale.
3. **Multiple permissive policies** (275 table/role/action combos): consolidate
   during a dedicated policy-cleanup pass.
4. **141 unindexed FKs** (mostly `comps.*`) + **42 unused indexes** + `purge_policy`
   missing a PK: housekeeping migration.
5. **Extensions in public schema** (`vector`, `pg_net`, `btree_gist`): legacy
   placement; moving them is disruptive and low-yield — accepted.
6. **Rate limiting**: nothing beyond Supabase platform defaults (auth endpoints are
   platform-limited). Accepted for a single-firm internal tool; revisit if the
   tenant portal ever grows.
7. **HTTP security headers**: Vercel serves no custom headers (`vercel.json` has
   rewrites only). Recommended addition (X-Content-Type-Options, X-Frame-Options,
   Referrer-Policy, Permissions-Policy); a CSP needs a dedicated test pass (blob:
   workers for PDF/Excel generation) — do not ship one blind.
8. **Credential rotation** (sb_secret, jwt_secret) — owner-gated, pending since the
   audit (KNOWN_ISSUES KI-8).

## Standing rules this pass reaffirmed

- `anon` SELECT grants on ~107 tables are the NORM here (RLS is the gate), not a finding.
- Never judge a definer view by its `reloptions` alone — read the definition; the
  guard may be (and here, is) inline.
- The migrations ledger (`supabase_migrations.schema_migrations`) is the only apply
  authority, but it is NOT complete history: 25 foundation files predate it — see
  `supabase/migrations/recovered_from_prod/README.md`.

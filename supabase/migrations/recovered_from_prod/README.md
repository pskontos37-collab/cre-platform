# Recovered migrations — DO NOT RE-APPLY

These 14 migrations were **applied to production via MCP `apply_migration` but their
.sql files were never committed** — the exact drift CLAUDE.md warns about. They were
recovered verbatim on 2026-08-05 from `supabase_migrations.schema_migrations.statements`
(base64-round-tripped for byte fidelity) during the release-hardening ledger
reconciliation, which compared all 206 on-disk files against all 195 ledger rows.

- Filenames are `<ledger version timestamp>_<ledger name>.sql` — they sort in true
  apply order and match the ledger keys exactly.
- They live in this subfolder, NOT in `supabase/migrations/` proper, so nothing
  (CLI `db push`, a human running files in order) ever re-applies them. Every one
  is already live in prod; several are `create or replace` on objects later state
  depends on, and `rea_members` contains a one-time data UPDATE.
- Two are historical intermediates superseded minutes later by their _v2 in the
  same folder (`living_abstracts_stale_view`, `nightly_scan_report_view`,
  `docask_scoped_vector_volatile_fix`/`_branch` → `_iterative`); they are kept
  because the ledger holds them and the repo should mirror the ledger.

Also learned in the same reconciliation (recorded here so it isn't rediscovered):
the 25 foundation files `20240001`–`20240023`, `20240031`, `20240045` predate the
ledger entirely (dashboard SQL-editor era, June 2026) and have **no ledger rows** —
their objects are live but a ledger-driven replay would skip them. A from-zero
rebuild must run those files first, in numeric order, before trusting the ledger.

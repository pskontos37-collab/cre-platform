-- _wave2_targets was an ad-hoc scratch table (abstractor wave-2 batch targeting;
-- the batch script reads scripts/_wave2_targets.json, not this table) created
-- without RLS. Because anon still inherited default SELECT, anyone holding the
-- public anon key could read it via PostgREST (advisor 0013, 2026-07-21).
drop table if exists public._wave2_targets;

-- Close the root cause: 20240098 revoked anon's default WRITE privileges only,
-- so new tables still granted anon SELECT (plus REFERENCES/TRIGGER). Revoke the
-- rest — future tables grant anon nothing at all. Nothing reads PostgREST as
-- anon: staff are authenticated, and the tenant portal only invokes the
-- edge-function gateway.
alter default privileges in schema public
  revoke select, references, trigger on tables from anon;

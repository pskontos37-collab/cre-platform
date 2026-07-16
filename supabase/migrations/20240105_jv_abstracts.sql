-- 20240105_jv_abstracts.sql
-- JV phase of the abstractor-v2 program: verified abstracts of the JV/entity
-- operating agreements behind each deal layer (waterfall tiers, promote,
-- capital calls, transfer/exit rights, major decisions). agreement-abstract/
-- agreement-verify gain kind='jv' keyed to deals rows; the rollout script
-- passes the entity-matched document ids explicitly and they persist in
-- abstract_source_doc_ids so verification re-reads the same set.

alter table public.deals
  add column if not exists abstract jsonb,
  add column if not exists abstract_model text,
  add column if not exists abstract_generated_at timestamptz,
  add column if not exists abstract_source_doc_ids uuid[],
  add column if not exists qa jsonb,
  add column if not exists qa_status text,
  add column if not exists qa_model text,
  add column if not exists qa_at timestamptz;

-- APPLIED 2026-07-29 as 20240160_comps_document_version_perf.
--
-- Fixes a performance regression introduced in 20240153.
-- comps.v_document_version answered "which documents carry clean assumption rows" with an
-- EXISTS the planner does NOT short-circuit: Index Only Scan on assumption (rows=48 loops=2059),
-- i.e. 98,009 rows fetched to answer an existence question, at a FIXED cost paid even by a
-- narrow single-market query. Panel first paint 326ms -> 2,844ms; tenant drill -> 2,535ms.
--
-- Fix: force the probe to stop at the first row with LATERAL ... LIMIT 1.
-- Proven equivalent on live data BEFORE applying (full outer join on document_id, version_rank):
--   cur_docs 1985 | prop_docs 1985 | rows_that_differ 0 | cur_rank1 659 | prop_rank1 659
-- Confirmed AFTER applying by output signature, not by inspection:
--   docs 1985 = 1985, rank1 659 = 659,
--   md5(string_agg(source_document_id:version_rank)) 1997ae73c965d2771529b9994a80b6ff, IDENTICAL.
-- Post-apply plan: Limit (actual rows=1 loops=2059) instead of rows=48 loops=2059, so 2,059
-- rows probed instead of 98,009; Heap Fetches 0; view executes in 9.1 ms.
--
-- Views only. Alters no table, touches no data.
--
-- The WITH clause is deliberate: CREATE OR REPLACE VIEW resets any reloption it does not
-- restate, which is how 20240153 stripped security_invoker off four views and opened a real
-- RLS hole (postgres has rolbypassrls here). Restated inline AND re-asserted below.
-- pg_class.reloptions verified as {security_invoker=true} after apply, not assumed.
create or replace view comps.v_document_version
with (security_invoker = true) as
select
  sd.id                                 as source_document_id,
  sd.source_property_id,
  sd.model_date,
  extract(year from sd.model_date)::int  as vintage_year,
  row_number() over (partition by sd.source_property_id
                     order by sd.model_date desc nulls last, sd.file_name desc) as version_rank,
  count(*)     over (partition by sd.source_property_id)                        as versions_loaded
from comps.source_document sd
where sd.id in (
  -- LATERAL + LIMIT 1: one row per clean set, not all ~48 of its assumption rows.
  -- Semantics unchanged -- still "non-quarantined AND has at least one row" -- which is what
  -- stops a tab-less or empty newest model from stealing version_rank 1 and making a property
  -- vanish from the default latest-only answer.
  select s.source_document_id
  from comps.assumption_set s
  cross join lateral (
    select 1 from comps.assumption a where a.assumption_set_id = s.id limit 1
  ) hit
  where s.is_quarantined = false
);
alter view comps.v_document_version set (security_invoker = true);

-- 20240129_document_accountability_v2.sql
-- Phase 2 Document Control: extend the accountability rollup with register
-- COVERAGE columns (how much of the 20240116 register is actually populated),
-- so /doc-control can show "X of Y hashed / paged / statused" per property.
-- Additive only: existing columns unchanged (create or replace view allows
-- appending columns at the end); grants carry over.

create or replace view public.document_accountability
with (security_invoker = true) as
select
  property_id,
  count(*)                                                                          as total,
  count(*) filter (where is_indexed)                                                as indexed,
  count(*) filter (where processing_status = 'exception')                           as exceptions,
  count(*) filter (where processing_status = 'reconciliation_required')             as reconciliation_required,
  count(*) filter (where superseded_by is not null
                      or processing_status = 'superseded')                          as superseded,
  count(*) filter (where duplicate_group_id is not null)                            as duplicates,
  count(*) filter (where ocr_quality in ('poor','unreadable'))                      as low_ocr,
  count(*) filter (where processing_status = 'irrelevant')                          as irrelevant,
  count(*) filter (where processing_status is null and not is_indexed)              as unaccounted,
  -- v2: register coverage
  count(*) filter (where content_sha256 is not null)                                as hashed,
  count(*) filter (where page_count is not null)                                    as paged,
  count(*) filter (where processing_status is not null)                             as statused
from public.documents
group by property_id;

comment on view public.document_accountability is
  'Per-property document accountability rollup + register coverage (v2: hashed/paged/statused). security_invoker: respects documents RLS. Register, migrations 20240116/20240129.';

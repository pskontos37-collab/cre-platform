-- 20240125_resolution_kinds.sql
-- Review Center slice 2 folds the clause-specialist findings and cross-check
-- disagreements into the unified review queue. Their resolutions carry their
-- own provenance kind so the audit trail records WHICH detection layer a human
-- ruled on; the original CHECK (mig 20240105) only allowed the first two.
alter table public.abstract_item_resolutions
  drop constraint if exists abstract_item_resolutions_kind_check;
alter table public.abstract_item_resolutions
  add constraint abstract_item_resolutions_kind_check
  check (kind in ('open_item', 'qa_check', 'clause_finding', 'cross_check'));

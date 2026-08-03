-- 20240184 — allow kind='data_quality' on abstract_item_resolutions.
--
-- Review Center now merges a FOURTH detection layer: the standing deterministic
-- checks from v_property_data_quality (20240181). Resolving one writes an
-- abstract_item_resolutions row like any other layer, but the kind CHECK only
-- permitted open_item | qa_check | clause_finding | cross_check — so Accept/Waive
-- on a standing-check item would have failed with a constraint violation at the
-- moment of the click, not at load. Caught by reading the constraint before
-- shipping the UI rather than after.
--
-- ADD-ONLY: every existing row already holds one of the four permitted values, so
-- no row can violate the widened constraint. Widening a CHECK is also why this is
-- safe to run against live data without a backfill.
--
-- Why a distinct kind rather than reusing the unused 'qa_check': kind records WHICH
-- detection layer a human settled, and that is the dimension the audit trail is
-- read along. Collapsing standing checks into another layer's label would make
-- "who found this" unanswerable later.
alter table abstract_item_resolutions
  drop constraint if exists abstract_item_resolutions_kind_check;

alter table abstract_item_resolutions
  add constraint abstract_item_resolutions_kind_check
  check (kind = any (array['open_item', 'qa_check', 'clause_finding', 'cross_check', 'data_quality']));

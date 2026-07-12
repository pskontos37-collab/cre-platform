-- 20240050_site_plan_doctype.sql
-- Make site plans a first-class document kind. Until now every ingested site
-- plan landed as doc_type='other' and was only findable by semantic search.
-- The new enum value lets the Documents grouping, the property page, and the
-- interactive site-plan map key off the type directly.
--
-- NOTE: a new enum value cannot be USED in the same transaction that adds it,
-- so the retag UPDATE + the site_plan_regions table live in 20240051.

alter type doc_type add value if not exists 'site_plan';

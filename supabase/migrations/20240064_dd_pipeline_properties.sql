-- 20240064_dd_pipeline_properties.sql
-- Due-diligence (pipeline) shell properties: run the full document/abstract
-- machinery on ACQUISITION TARGETS without polluting AUM. useProperties filters
-- is_pipeline=false app-wide (dashboards, pickers, metrics stay pure AUM); the
-- /diligence workspace queries is_pipeline=true itself. Promoting a closed deal
-- = set is_pipeline=false — the DD abstracts/documents carry over as day-1 AUM
-- data with zero rework. Links to pipeline_deals (migration 20240063) can be
-- added later via a dd_property_id column once that feature lands.
alter table public.properties add column if not exists is_pipeline boolean not null default false;

-- 20240068_pipeline_tracking_stage.sql
-- Adds a 'tracking' (Watchlist) stage to pipeline_deals. The firm's Acq. Pipeline
-- book keeps a large "Property Tracking" list of assets it is NOT actively
-- pursuing — kept for future reference. These load as stage='tracking' and are
-- shown as a separate Watchlist, excluded from the active funnel and metrics.

alter table public.pipeline_deals drop constraint if exists pipeline_deals_stage_check;
alter table public.pipeline_deals add constraint pipeline_deals_stage_check
  check (stage in (
    'tracking','sourced','screening','underwriting','loi','under_contract',
    'dd','ic_approval','closing','closed','passed','dead','lost'));

notify pgrst, 'reload schema';

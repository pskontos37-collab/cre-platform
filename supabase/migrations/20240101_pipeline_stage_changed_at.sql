-- Track when each pipeline deal entered its CURRENT stage, so the acquisition
-- alerts can flag deals aging IN-STAGE rather than merely un-edited (updated_at
-- bumps on any edit — docs, comments, underwriting, weekly sync — so it is a poor
-- staleness signal). stage_changed_at is stamped on every stage change: in-app
-- (updateDeal when the stage is set) and by the weekly loader on a cross-bucket
-- move. Backfilled to updated_at (best available proxy) for existing rows.

alter table public.pipeline_deals
  add column if not exists stage_changed_at timestamptz;

update public.pipeline_deals
  set stage_changed_at = coalesce(updated_at, created_at, now())
  where stage_changed_at is null;

alter table public.pipeline_deals
  alter column stage_changed_at set default now();
alter table public.pipeline_deals
  alter column stage_changed_at set not null;

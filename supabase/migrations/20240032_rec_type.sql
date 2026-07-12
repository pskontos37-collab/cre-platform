-- Distinguish CAM vs INS vs RET reconciliations in cam_reconciliations.
-- Existing rows (Gateway 2025 CAM) default to 'cam'.
alter table cam_reconciliations
  add column if not exists rec_type text not null default 'cam'
  check (rec_type in ('cam', 'ins', 'ret'));

create index if not exists idx_cam_recs_type on cam_reconciliations (property_id, period_year, rec_type);

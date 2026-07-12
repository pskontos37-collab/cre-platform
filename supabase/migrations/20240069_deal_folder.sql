-- 20240069_deal_folder.sql
-- Links a pipeline deal to its acquisitions network folder
-- (K:\ASSTMGMT\ACQUISITIONS\<State>\<Deal>\). folder_path is the resolved UNC/
-- drive path (shown copyable — opens for on-network users, like /services file
-- paths); folder_files is a snapshot of the folder's top-level contents so the
-- file list renders in-app without the web server reading the share.
-- Populated by scripts/link_deal_folders.ps1 (re-run after each monthly load).

alter table public.pipeline_deals
  add column if not exists folder_path  text,
  add column if not exists folder_files jsonb;

notify pgrst, 'reload schema';

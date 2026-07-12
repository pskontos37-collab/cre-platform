-- 20240073_deal_dd_link.sql
-- Bridges a pipeline deal to its due-diligence workspace: dd_property_id points
-- at the /diligence shell property (is_pipeline=true). One click on the deal
-- creates the shell (or reopens it) and can feed mirrored data-room PDFs through
-- doc-inbox so lease abstraction runs on them. On close, /diligence "promote"
-- flips the shell to AUM — abstracts + docs carry over as day-1 data.
-- (numbered 20240073; 20240070-72 taken by parallel sessions.)

alter table public.pipeline_deals
  add column if not exists dd_property_id uuid references public.properties(id) on delete set null;

notify pgrst, 'reload schema';

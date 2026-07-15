-- Per-deal underwriting model: the editable assumptions behind the in-app
-- returns engine (src/lib/acqUnderwriting.ts). The COMPUTED outputs continue to
-- live in the existing scalar columns (proj_irr, equity_multiple, avg_coc,
-- exit_cap, hold_years, stabilized_yield, equity_required, total_capitalization)
-- so the board, meeting deck, IC memo and analytics pick them up unchanged; this
-- column just persists the inputs so the model reopens where the analyst left it.
alter table public.pipeline_deals add column if not exists underwriting_model jsonb;

comment on column public.pipeline_deals.underwriting_model is
  'Editable acquisition-underwriting assumptions (AcqAssumptions); computed returns are written to the scalar metric columns on save.';

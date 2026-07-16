-- 20240097_ppm_builder.sql
-- PPM (Private Placement Memorandum) generator: one row per PPM draft.
--
-- The entire deal "data sheet" (every number/name that appears in the document)
-- and the per-section narrative drafts live in jsonb -- the document template
-- evolves in code (src/lib/ppm/template.ts) without schema churn.
--
-- Optionally linked to a pipeline deal (prefills the data sheet). Deal/capital
-- data is sensitive: RLS mirrors pipeline_* (admin / asset_manager only).

create table if not exists ppm_drafts (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references pipeline_deals(id) on delete set null,
  name        text not null,
  status      text not null default 'draft' check (status in ('draft', 'review', 'final')),
  -- Structured deal facts: identity, physical, deal terms, JV, equity stack,
  -- financing, forecast, tenancy roster, market stats, subscription mechanics.
  data_sheet  jsonb not null default '{}'::jsonb,
  -- Map of section key -> { text, mode: 'ai'|'edited', generated_at, approved }
  sections    jsonb not null default '{}'::jsonb,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_ppm_drafts_deal on ppm_drafts(deal_id);

alter table ppm_drafts enable row level security;

drop policy if exists ppm_drafts_select on ppm_drafts;
create policy ppm_drafts_select on ppm_drafts
  for select using (is_admin_or_am());

drop policy if exists ppm_drafts_insert on ppm_drafts;
create policy ppm_drafts_insert on ppm_drafts
  for insert with check (is_admin_or_am());

drop policy if exists ppm_drafts_update on ppm_drafts;
create policy ppm_drafts_update on ppm_drafts
  for update using (is_admin_or_am());

drop policy if exists ppm_drafts_delete on ppm_drafts;
create policy ppm_drafts_delete on ppm_drafts
  for delete using (is_admin_or_am());

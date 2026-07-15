-- 20240091_doc_briefs.sql
-- Per-document structured extraction layer for the lease abstractor rebuild
-- (docs/abstraction-standard.md). One brief per document: the doc-brief edge
-- function reads 100% of the document's text (giant instruments walked in
-- segments, merged at the end) and stores a structured brief — classification,
-- parties, execution status, dates, rent tables, options, clause inventory
-- with verbatim operative language. lease-abstract then SYNTHESIZES from
-- briefs instead of truncated raw text, which removes the "NOT FULLY
-- REVIEWED" failure class: no instrument is ever partially read again.
--
-- Keyed by document_id (unique). text_chars records the corpus text length at
-- extraction time; a re-run compares it and re-briefs only when text changed
-- (OCR/reindex). segments holds per-segment partial extractions while a
-- multi-segment brief is in flight (resumable across invocations, since one
-- edge call must stay inside the 150s wall).

create table if not exists public.doc_briefs (
  id             uuid primary key default uuid_generate_v4(),
  document_id    uuid not null references public.documents(id) on delete cascade,
  property_id    uuid references public.properties(id) on delete cascade,
  -- taxonomy per abstraction-standard §4
  doc_class      text,   -- operative_instrument | ancillary_executed | notice_correspondence | financial_operational | property_level | draft_unexecuted | other
  chain_role     text,   -- base_lease | amendment | cda | assignment | guaranty | option_exercise_notice | termination | snda | estoppel | mol | license | rea | pma | recon | sales_report | correspondence | other
  brief          jsonb,  -- merged structured extraction (null while segments in flight)
  segments       jsonb,  -- array of per-segment partial extractions (multi-segment docs)
  segments_done  int not null default 0,
  segments_total int,
  text_chars     int,
  status         text not null default 'pending',  -- pending | in_progress | complete | error
  model          text,
  error          text,
  extracted_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (document_id)
);

create index if not exists doc_briefs_property on public.doc_briefs(property_id);
create index if not exists doc_briefs_class on public.doc_briefs(doc_class);
create index if not exists doc_briefs_status on public.doc_briefs(status);

alter table public.doc_briefs enable row level security;

-- Reads mirror documents_select scope; writes are service-role only (edge fn
-- bypasses RLS) — deliberately no insert/update policy.
drop policy if exists "doc_briefs_select" on public.doc_briefs;
create policy "doc_briefs_select" on public.doc_briefs
  for select using (property_id is null or public.can_access_property(property_id));

grant select on public.doc_briefs to authenticated;

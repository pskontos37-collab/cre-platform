-- 20240116_document_register.sql
-- PHASE 1 (audit trust layer) — the authoritative DOCUMENT REGISTER.
--
-- The audit's first measurable promise is "100% document accountability": every
-- file is KNOWN and is either processed, a duplicate, superseded, irrelevant with
-- a reason, unreadable, or awaiting review — never silently missing. It also asks
-- for an agreement-FAMILY graph (base -> amendments/assignments/notices/estoppels)
-- so a lease's current term can later be derived from a visible chronology rather
-- than synthesized from an arbitrary prompt stack (that derivation is P1d).
--
-- This migration is fully ADDITIVE: it only ADDS nullable columns to `documents`
-- and creates two new read-mostly objects. No existing column, row, index, RLS
-- policy, or query changes, so nothing that reads/writes `documents` today breaks.
-- Backfill (hashing, classifying execution status, drawing family edges) is
-- separate incremental work — this establishes the schema the register hangs on.
--
-- `documents` already carries: version, superseded_by, storage_path, file_mtime,
-- file_size_bytes. We do NOT duplicate those.

-- ── 1. Register columns on documents (all nullable; existing rows read as
--       "not yet classified", which the accountability view surfaces) ──────────
alter table public.documents
  -- content hash: exact-duplicate detection AND stale-work invalidation (a
  -- re-OCR'd or replaced file of the same byte-length no longer looks unchanged).
  add column if not exists content_sha256     text,
  add column if not exists duplicate_group_id uuid,       -- same-hash files share this id
  -- agreement family: base instrument + its amendments/assignments/notices/etc.
  add column if not exists agreement_family_id uuid,
  add column if not exists doc_subtype        text,       -- finer than doc_type (e.g. 'fourth_amendment', 'estoppel')
  -- execution state (audit: "execution state by party, incl. partially executed")
  add column if not exists execution_status   text
    check (execution_status in ('unknown','draft','unsigned','partially_executed','executed')),
  -- the audit insists these are SEPARATE concepts, not one "date"
  add column if not exists effective_date     date,       -- when the instrument takes effect
  add column if not exists recorded_date      date,       -- when recorded (deeds/REAs)
  add column if not exists stated_date        date,       -- the date written on the face of the doc
  -- processing lifecycle + the reason for any exception (audit: "processing
  -- status and reason for every exception")
  add column if not exists processing_status  text
    check (processing_status in ('pending','ingested','classified','extracted','reconciliation_required','exception','superseded','irrelevant')),
  add column if not exists processing_note    text,
  -- OCR quality so unreadable/handwritten pages are disclosed, not silently trusted
  add column if not exists ocr_quality        text
    check (ocr_quality in ('native','good','poor','unreadable')),
  add column if not exists page_count         integer,
  add column if not exists unreadable_pages   integer;

comment on column public.documents.content_sha256 is
  'SHA-256 of the file bytes. Duplicate detection (same hash => same duplicate_group_id) and stale-work invalidation. Register, migration 20240116.';
comment on column public.documents.agreement_family_id is
  'Groups a base instrument with its amendments/assignments/notices/estoppels/etc. The effective-term ledger (P1d) derives the current term by walking one family chronologically. Register, migration 20240116.';
comment on column public.documents.execution_status is
  'unknown | draft | unsigned | partially_executed | executed. A tenant-signed / landlord-blank amendment is partially_executed, never executed. Register, migration 20240116.';
comment on column public.documents.processing_status is
  'pending | ingested | classified | extracted | reconciliation_required | exception | superseded | irrelevant. Drives 100% document accountability. Register, migration 20240116.';

create index if not exists documents_content_sha256_idx  on public.documents (content_sha256);
create index if not exists documents_dup_group_idx        on public.documents (duplicate_group_id);
create index if not exists documents_agreement_family_idx on public.documents (agreement_family_id);

-- ── 2. Agreement-family graph: typed edges between documents ──────────────────
-- A directed edge: from_document <relationship> to_document, e.g. a Fourth
-- Amendment `amends` the base lease; a 2025 notice `exercises` an option in it;
-- a later amendment `supersedes` an earlier one. `documents.superseded_by`
-- remains the simple single-pointer case; this table carries the full graph.
create table if not exists public.document_relationships (
  id               uuid primary key default gen_random_uuid(),   -- core PG (no extensions-schema search_path dependency)
  from_document_id uuid not null references public.documents(id) on delete cascade,
  to_document_id   uuid not null references public.documents(id) on delete cascade,
  relationship     text not null check (relationship in
    ('amends','assigns','assumes','confirms','exercises','terminates',
     'supersedes','exhibit_to','guaranties','estops','releases','notice_for')),
  note             text,
  created_by       uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (from_document_id, to_document_id, relationship),
  check (from_document_id <> to_document_id)
);
create index if not exists document_relationships_from_idx on public.document_relationships (from_document_id);
create index if not exists document_relationships_to_idx   on public.document_relationships (to_document_id);

comment on table public.document_relationships is
  'Agreement-family graph: typed directed edges between documents (amends/assigns/exercises/supersedes/etc.). Register, migration 20240116.';

alter table public.document_relationships enable row level security;
-- Curation surface, same posture as the abstracts / property_exclusives registries.
create policy "docrel_select" on public.document_relationships for select using (public.is_admin_or_am());
create policy "docrel_insert" on public.document_relationships for insert with check (public.is_admin_or_am());
create policy "docrel_update" on public.document_relationships for update using (public.is_admin_or_am());
create policy "docrel_delete" on public.document_relationships for delete using (public.is_admin_or_am());
grant select, insert, update, delete on public.document_relationships to authenticated;

-- ── 3. Document accountability surface (per property) ─────────────────────────
-- security_invoker so the caller's own documents RLS applies (each user sees only
-- their properties' counts). This is the "is every file accounted for?" view.
create or replace view public.document_accountability
with (security_invoker = true) as
select
  property_id,
  count(*)                                                                          as total,
  count(*) filter (where is_indexed)                                                as indexed,
  count(*) filter (where processing_status = 'exception')                           as exceptions,
  count(*) filter (where processing_status = 'reconciliation_required')             as reconciliation_required,
  count(*) filter (where superseded_by is not null
                      or processing_status = 'superseded')                          as superseded,
  count(*) filter (where duplicate_group_id is not null)                            as duplicates,
  count(*) filter (where ocr_quality in ('poor','unreadable'))                      as low_ocr,
  count(*) filter (where processing_status = 'irrelevant')                          as irrelevant,
  -- not yet accounted for: no processing status recorded and not indexed
  count(*) filter (where processing_status is null and not is_indexed)              as unaccounted
from public.documents
group by property_id;

comment on view public.document_accountability is
  'Per-property document accountability rollup (total/indexed/exceptions/superseded/duplicates/low_ocr/unaccounted). security_invoker: respects documents RLS. Register, migration 20240116.';

grant select on public.document_accountability to authenticated;

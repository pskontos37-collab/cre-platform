-- 20240053_chunk_kind.sql
-- Distinguishes the two kinds of rows in document_chunks:
--   'summary' — the legacy doc-level AI abstraction blob (searchableText): a
--                2-4 sentence paraphrase + extracted fields. Every existing row
--                is one of these (≈1.15 chunks/doc, median 749 chars).
--   'text'    — verbatim extracted document text, windowed into overlapping
--                passages (pdf-extract ?reindexText=1). Carries the actual lease
--                language — rent tables, section numbers, exact clauses — so the
--                semantic + FTS legs have real content to match, not paraphrase.
--
-- Existing rows correctly default to 'summary'. Adding a NOT NULL column with a
-- constant default is a metadata-only change in PG11+ (no table rewrite).
-- Rollback of a reindex run is just: delete from document_chunks where kind='text'.

alter table public.document_chunks
  add column if not exists kind text not null default 'summary';

create index if not exists document_chunks_kind_idx on public.document_chunks (kind);

comment on column public.document_chunks.kind is
  'summary = legacy doc-level AI abstraction blob; text = verbatim extracted document text (RAG recall layer)';

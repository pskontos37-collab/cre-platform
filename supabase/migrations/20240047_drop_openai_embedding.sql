-- Voyage cutover cleanup. All query paths (doc-ask v14, doc-search v10) and ingestion
-- (pdf-extract v16, ingest_local_docs.ps1) now use embedding_voyage / match_chunks_voyage.
-- The OpenAI 1536-dim column and its RPCs are unreferenced — drop them.
-- (A future re-embed can always rebuild; set_voyage_embeddings is kept for that.)

drop function if exists public.match_document_chunks(vector, int);
drop function if exists public.match_document_chunks_scoped(vector, int, uuid[]);

-- Dropping the column also drops idx_document_chunks_embedding_hnsw.
alter table public.document_chunks drop column if exists embedding;

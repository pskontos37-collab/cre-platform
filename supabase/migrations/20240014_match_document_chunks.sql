-- Recall layer: cosine-similarity search helper over document_chunks.
-- Additive (CREATE OR REPLACE FUNCTION) — no existing object is dropped or altered.
create or replace function match_document_chunks(
  query_embedding vector(1536),
  match_count     int default 8
)
returns table (id uuid, document_id uuid, content text, similarity float)
language sql stable
as $$
  select dc.id, dc.document_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.embedding is not null
  order by dc.embedding <=> query_embedding
  limit match_count
$$;

-- Optional at scale (exact search is fine for small corpora): an ANN index.
-- create index if not exists idx_document_chunks_embedding
--   on document_chunks using hnsw (embedding vector_cosine_ops);

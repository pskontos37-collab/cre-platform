-- Voyage AI embeddings — step 2 of 2 (index + scoped RPC). Run AFTER reembed_voyage.ps1
-- has populated document_chunks.embedding_voyage (building the HNSW index once, on filled
-- data, is faster than maintaining it through the backfill).

create index if not exists idx_document_chunks_voyage_hnsw
  on public.document_chunks using hnsw (embedding_voyage vector_cosine_ops);

-- Voyage-vector twin of match_document_chunks_scoped: unscoped → plain HNSW (fast);
-- scoped → pgvector 0.8 iterative index scan over the denormalised property_id filter
-- (complete in-scope results). volatile so SET LOCAL is allowed.
create or replace function public.match_chunks_voyage(
  query_embedding vector(1024),
  match_count     int default 40,
  p_property_ids  uuid[] default null
)
returns table (document_id uuid, chunk_index int, content text, similarity float)
language plpgsql volatile
set search_path = public
as $$
begin
  if p_property_ids is null then
    return query
      select c.document_id, c.chunk_index, c.content,
             1 - (c.embedding_voyage <=> query_embedding) as similarity
      from public.document_chunks c
      where c.embedding_voyage is not null
      order by c.embedding_voyage <=> query_embedding
      limit match_count;
  else
    set local hnsw.iterative_scan = 'relaxed_order';
    set local hnsw.ef_search = 200;
    return query
      select c.document_id, c.chunk_index, c.content,
             1 - (c.embedding_voyage <=> query_embedding) as similarity
      from public.document_chunks c
      where c.embedding_voyage is not null
        and c.property_id = any(p_property_ids)
      order by c.embedding_voyage <=> query_embedding
      limit match_count;
  end if;
end;
$$;

revoke execute on function public.match_chunks_voyage(vector, int, uuid[]) from anon;


create or replace function public.match_document_chunks_scoped(
  query_embedding vector(1536),
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
             1 - (c.embedding <=> query_embedding) as similarity
      from public.document_chunks c
      where c.embedding is not null
      order by c.embedding <=> query_embedding
      limit match_count;
  else
    set local hnsw.iterative_scan = 'relaxed_order';
    set local hnsw.ef_search = 200;
    return query
      select c.document_id, c.chunk_index, c.content,
             1 - (c.embedding <=> query_embedding) as similarity
      from public.document_chunks c
      where c.embedding is not null
        and c.property_id = any(p_property_ids)
      order by c.embedding <=> query_embedding
      limit match_count;
  end if;
end;
$$;

revoke execute on function public.match_document_chunks_scoped(vector, int, uuid[]) from anon;

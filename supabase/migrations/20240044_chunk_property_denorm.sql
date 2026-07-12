-- Speed up property-scoped hybrid retrieval.
--
-- match_document_chunks_scoped filtered in-scope chunks with an EXISTS subquery
-- against documents, which stopped pgvector's HNSW iterative scan from filtering
-- efficiently (~4.5s per query). Denormalise property_id onto document_chunks so
-- the scope filter is a plain indexed column predicate the index scan applies as
-- it walks — standard pattern for filtered ANN search. Brings queries to <200ms.

alter table public.document_chunks add column if not exists property_id uuid;

update public.document_chunks c
set property_id = d.property_id
from public.documents d
where d.id = c.document_id
  and c.property_id is distinct from d.property_id;

create index if not exists idx_document_chunks_property on public.document_chunks(property_id);

-- Keep it in sync: chunks are (re)inserted by the loaders; stamp property_id from
-- the parent document on insert or when the document link changes.
create or replace function public.set_chunk_property_id()
returns trigger language plpgsql
set search_path = public
as $$
begin
  select property_id into new.property_id from public.documents where id = new.document_id;
  return new;
end;
$$;

drop trigger if exists trg_chunk_property_id on public.document_chunks;
create trigger trg_chunk_property_id
  before insert or update of document_id on public.document_chunks
  for each row execute function public.set_chunk_property_id();

-- Rewrite both scoped RPCs to filter on the denormalised column.
-- Branch on scope. Unscoped: plain HNSW index scan (fast, ~70ms). Scoped: pgvector
-- 0.8 iterative index scan (relaxed_order) with the denormalised property_id filter,
-- which keeps walking the HNSW graph until match_count IN-SCOPE rows are collected —
-- complete results (~1s over a 3.7k-chunk property), unlike HNSW+post-filter which
-- silently returns short when a bigger property's chunks crowd the initial window.
-- volatile (not stable) so SET LOCAL is permitted.
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

create or replace function public.search_document_chunks_fts(
  p_query        text,
  match_count    int default 40,
  p_property_ids uuid[] default null
)
returns table (document_id uuid, chunk_index int, content text, rank float)
language sql stable
set search_path = public
as $$
  select c.document_id, c.chunk_index, c.content,
         ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', p_query))::float as rank
  from public.document_chunks c
  where p_query <> ''
    and c.content_tsv @@ websearch_to_tsquery('english', p_query)
    and (p_property_ids is null or c.property_id = any(p_property_ids))
  order by rank desc
  limit match_count
$$;

revoke execute on function public.match_document_chunks_scoped(vector, int, uuid[]) from anon;
revoke execute on function public.search_document_chunks_fts(text, int, uuid[])    from anon;

-- doc-ask / doc-search retrieval quality overhaul.
--
-- Problem: the vector leg fetched the GLOBAL top-K chunks across the whole corpus
-- and only THEN filtered to the requested property. At bigger properties (Magnolia
-- 4,617 chunks, Gateway 2,697) the global nearest-neighbours for any "promote /
-- waterfall / CAM" query are dominated by those properties, so a scoped question
-- ("Knightdale JV promote structure") never saw its own JV Operating-Agreement
-- chunks — even though they exist and are richly written.
--
-- Fix: retrieval is now (a) PROPERTY-SCOPED in SQL — the filter is applied before
-- the ranking/limit, and (b) HYBRID — a lexical (full-text / BM25-style) leg runs
-- alongside the semantic leg so exact terms (defined terms, $ figures, section
-- numbers) are recalled too. The edge function fuses the two with Reciprocal Rank
-- Fusion. Additive only — the original match_document_chunks() is left intact for
-- doc-search's existing global path.

-- 1) Lexical index over chunk text (generated tsvector + GIN).
alter table public.document_chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index if not exists idx_document_chunks_tsv
  on public.document_chunks using gin (content_tsv);

-- 2) Property-scoped semantic search. plpgsql so we can turn on pgvector 0.8
--    iterative index scans: the HNSW index keeps being used while the property
--    filter is applied, scanning further into the index until enough in-scope
--    rows are collected (relaxed_order). p_property_ids = null → whole corpus.
create or replace function public.match_document_chunks_scoped(
  query_embedding vector(1536),
  match_count     int default 40,
  p_property_ids  uuid[] default null
)
returns table (document_id uuid, chunk_index int, content text, similarity float)
language plpgsql volatile   -- volatile (not stable) so SET LOCAL is permitted
set search_path = public
as $$
begin
  set local hnsw.iterative_scan = 'relaxed_order';
  set local hnsw.ef_search = 100;
  return query
    select c.document_id, c.chunk_index, c.content,
           1 - (c.embedding <=> query_embedding) as similarity
    from public.document_chunks c
    where c.embedding is not null
      and (
        p_property_ids is null
        or exists (
          select 1 from public.documents d
          where d.id = c.document_id and d.property_id = any(p_property_ids)
        )
      )
    order by c.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- 3) Property-scoped lexical search over chunk text. The caller passes a query
--    string using websearch syntax (terms joined with "or" for OR semantics);
--    ts_rank_cd ranks by term coverage/proximity.
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
    and (
      p_property_ids is null
      or exists (
        select 1 from public.documents d
        where d.id = c.document_id and d.property_id = any(p_property_ids)
      )
    )
  order by rank desc
  limit match_count
$$;

-- Match the security posture of migration 20240040: keep anon out; the edge
-- functions call these with the service role, which retains execute.
revoke execute on function public.match_document_chunks_scoped(vector, int, uuid[]) from anon;
revoke execute on function public.search_document_chunks_fts(text, int, uuid[])    from anon;

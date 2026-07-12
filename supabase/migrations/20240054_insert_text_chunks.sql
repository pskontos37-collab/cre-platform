-- 20240054_insert_text_chunks.sql
-- Reindex text-chunk inserts were failing with "canceling statement due to
-- statement timeout". document_chunks carries an HNSW index on embedding_voyage;
-- as it grew past ~50k rows, even a 12-row client insert exceeded the 8s default
-- statement_timeout (HNSW + tsvector maintenance per row). This RPC inserts a
-- document's text chunks in ONE statement with a locally-raised timeout, so
-- pdf-extract?reindexText=1 can finish the large scanned-heavy docs that were
-- failing. SECURITY DEFINER so SET LOCAL applies regardless of caller role.

create or replace function public.insert_text_chunks(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  set local statement_timeout = '120s';
  insert into public.document_chunks
    (document_id, property_id, chunk_index, content, embedding_voyage, page_number, kind)
  select (r->>'document_id')::uuid,
         nullif(r->>'property_id', '')::uuid,
         (r->>'chunk_index')::int,
         r->>'content',
         (r->>'embedding_voyage')::vector(1024),
         (r->>'page_number')::int,
         coalesce(r->>'kind', 'text')
  from jsonb_array_elements(p_rows) as r;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.insert_text_chunks(jsonb) from public, anon;
grant execute on function public.insert_text_chunks(jsonb) to authenticated, service_role;

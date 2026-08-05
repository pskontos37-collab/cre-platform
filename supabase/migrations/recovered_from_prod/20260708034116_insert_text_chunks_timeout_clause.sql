create or replace function public.insert_text_chunks(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
set statement_timeout = '150s'
as $$
declare n int;
begin
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

create or replace function public.set_voyage_embeddings(p_ids uuid[], p_vecs text[])
returns int
language sql volatile
set search_path = public
as $$
  with v as (
    select unnest(p_ids) as id, unnest(p_vecs) as vec
  )
  update public.document_chunks c
    set embedding_voyage = v.vec::vector(1024)
    from v
    where c.id = v.id;
  select coalesce(array_length(p_ids, 1), 0);
$$;

revoke execute on function public.set_voyage_embeddings(uuid[], text[]) from anon;

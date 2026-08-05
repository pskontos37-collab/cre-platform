
alter table public.document_chunks
  add column if not exists embedding_voyage vector(1024);

create or replace function public.set_voyage_embeddings(p_ids uuid[], p_vecs text[])
returns int
language plpgsql volatile
set search_path = public
as $$
declare i int; n int := 0;
begin
  if p_ids is null then return 0; end if;
  for i in 1 .. array_length(p_ids, 1) loop
    update public.document_chunks
      set embedding_voyage = p_vecs[i]::vector(1024)
      where id = p_ids[i];
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.set_voyage_embeddings(uuid[], text[]) from anon;

-- Voyage AI embeddings — step 1 of 2 (add column + bulk writer; index comes after backfill).
--
-- Switching the recall layer from OpenAI text-embedding-3-small (1536-dim) to
-- voyage-3-large (1024-dim), which benchmarks ahead of OpenAI's larger model on
-- legal/financial retrieval. Dual-column during cutover so we can roll back: the
-- old `embedding vector(1536)` stays until the Voyage column is verified.

alter table public.document_chunks
  add column if not exists embedding_voyage vector(1024);

-- Bulk writer for the re-embed loader: one round-trip updates a batch of chunks.
-- p_vecs[i] is a '[..]' vector literal aligned to p_ids[i].
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

-- 20240165  Repair 17 duplicate groups that 20240164 split in half
--
-- ⚠️ DEFECT INTRODUCED BY 20240164, caught by predicting the result before applying and
-- then not accepting the mismatch: the canonical election was predicted to elect 669
-- rows and elected 686. The 17-row gap is the bug.
--
-- CAUSE. 20240164's backfill assigned a group to rows where duplicate_group_id was null:
--     with missing as (select content_sha256, gen_random_uuid() as gid ... where
--                      duplicate_group_id is null ... group by content_sha256)
-- For a hash whose OTHER rows were already grouped by the earlier pass, that minted a
-- SECOND uuid for the same hash instead of reusing the existing one. 17 hashes ended up
-- spanning 34 groups over 53 rows. Because canonical is elected per (group, property),
-- each half then elected its own canonical - so the same byte-identical PDF is counted
-- twice, which is exactly the inflation the flag exists to remove.
--
-- A "backfill the nulls" update must adopt the key its siblings already carry. Grouping
-- only the null rows cannot see them.
--
-- FIX. Collapse every hash onto ONE group id (the minimum, so the pre-existing id from
-- the earlier pass wins and stays stable), then re-run the identical election. The
-- election is idempotent - it only writes where the value would change - so re-running
-- it is safe and settles any row whose text layer changed since 20240164 (the OCR pass
-- running concurrently adds kind='text' chunks, which is a tiebreak input).
--
-- PREDICTED AFTER THIS: 640 groups (one per hash), 669 canonical, 749 non-canonical,
-- 1,418 rows marked, and zero hashes spanning more than one group.

-- 1. One group per hash. min() is deterministic and prefers the older id.
with canon_group as (
  select content_sha256, min(duplicate_group_id::text)::uuid as gid
  from documents
  where content_sha256 is not null and duplicate_group_id is not null
  group by content_sha256
  having count(distinct duplicate_group_id) > 1
)
update documents d
set duplicate_group_id = c.gid
from canon_group c
where d.content_sha256 = c.content_sha256
  and d.duplicate_group_id <> c.gid;

-- 2. Re-elect, identical ordering to 20240164.
with ranked as (
  select d.id,
         row_number() over (
           partition by d.duplicate_group_id, d.property_id
           order by
             (exists (select 1 from lease_abstracts la
                      where la.source_doc_ids is not null and d.id = any(la.source_doc_ids))) desc,
             (exists (select 1 from document_chunks c
                      where c.document_id = d.id and c.kind = 'text'
                        and length(coalesce(c.content,'')) > 200)) desc,
             (d.page_count is not null) desc,
             d.created_at asc nulls last,
             d.id asc
         ) as rn
  from documents d
  where d.duplicate_group_id is not null
)
update documents d
set is_canonical = (r.rn = 1)
from ranked r
where r.id = d.id
  and d.is_canonical is distinct from (r.rn = 1);

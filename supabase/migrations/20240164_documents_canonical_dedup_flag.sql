-- 20240164  Make the duplicate corpus countable WITHOUT deleting anything
--
-- The corpus is ~4.5% byte-identical duplicates: 640 content_sha256 groups covering
-- 1,418 rows, i.e. 778 redundant rows. That inflates document counts and per-tenant
-- coverage everywhere they are reported.
--
-- ⚠️ DELETION IS THE WRONG TOOL HERE, and this migration deliberately deletes nothing:
--   * 28 of the 640 groups span MORE THAN ONE PROPERTY. The same recorded PDF filed
--     under two properties is CORRECT, not redundant - collapsing those would silently
--     remove a property's copy of its own document.
--   * 68 duplicate rows are cited in lease_abstracts.source_doc_ids. Deleting a cited
--     row breaks the citation and the source deep-link that opens the PDF at its page.
--   * 881 duplicate rows carry text chunks, and which twin holds the text is exactly
--     why abstracts looked textless - the text lived in the twin the abstract was not
--     citing. Removing the wrong twin would re-create that failure.
-- So instead of deleting, this marks ONE canonical row per (group, property) and lets
-- every count filter on is_canonical. Nothing becomes unreachable.
--
-- WHAT WAS ALREADY HERE. documents.duplicate_group_id exists and a prior pass populated
-- 1,230 rows across 555 groups. Verified sound before extending it rather than inventing
-- a second scheme: 0 groups mix different hashes, 0 hashes are split across groups, and
-- 0 grouped rows have since stopped being duplicates. It is one uuid per content_sha256.
-- What it lacks is the 188 rows hashed after that pass (hashing only reached 99.92%
-- recently), and any notion of WHICH row in a group is the one to count.
--
-- CANONICAL CHOICE, in priority order, computed per (duplicate_group_id, property_id):
--   1. cited by a lease abstract      - so citations resolve to the canonical row
--   2. has a kind='text' chunk        - prefer the twin that actually holds the text
--   3. has a page_count               - prefer the more completely processed row
--   4. earliest created_at, then id   - deterministic tiebreak, so re-running is stable
-- Ties are impossible because id is unique and last in the ordering.

-- 1. Backfill duplicate_group_id for hashes that gained a duplicate after the last pass.
--    One uuid per hash, matching the existing scheme exactly.
with missing as (
  select content_sha256, gen_random_uuid() as gid
  from documents
  where content_sha256 is not null
    and duplicate_group_id is null
    and content_sha256 in (
      select content_sha256 from documents
      where content_sha256 is not null group by 1 having count(*) > 1
    )
  group by content_sha256
)
update documents d
set duplicate_group_id = m.gid
from missing m
where d.content_sha256 = m.content_sha256
  and d.duplicate_group_id is null;

-- 2. The canonical marker. Nullable on purpose: NULL means "not part of any duplicate
--    group", which is the overwhelming majority of the corpus and must not be confused
--    with "duplicate, not canonical" (false).
alter table documents
  add column if not exists is_canonical boolean;

comment on column documents.is_canonical is
  'Within a duplicate_group_id, exactly one row per property is true. NULL = not a '
  'duplicate at all. Count distinct documents with (duplicate_group_id is null or '
  'is_canonical). Set by 20240164; nothing is deleted - cited and text-bearing twins '
  'are retained and remain resolvable.';

-- 3. Elect the canonical row per (group, property).
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

-- 4. Index the read pattern every count will now use.
create index if not exists documents_canonical_idx
  on documents (duplicate_group_id, is_canonical)
  where duplicate_group_id is not null;

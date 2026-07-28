-- reseed_exclusives_registry.sql
--
-- Repairs the 500-char truncation introduced by seed_exclusives_registry.sql line 11
--   left(coalesce(overrides->>'exclusives.exact_language', abstract->..., ''), 500)
-- which cut 48 of 71 registry rows mid-clause. The truncation systematically removed
-- CARVE-OUTS, because carve-outs are drafted at the END of an exclusive ("The
-- aforementioned restriction shall not apply to: ..."). Five Guys at KM East lost the
-- outparcel carve-out this way, which is what let doc-ask report a hamburger use as
-- barred on an outparcel where it is not.
--
-- The abstracts themselves were correct all along -- this only re-copies them in full.
-- Precedence (human override > abstract) is preserved exactly as the original seeder had it.
--
-- Idempotent: re-running is a no-op once descriptions match.

begin;

-- ---------------------------------------------------------------------------
-- 1. Preview (run alone first; expect ~57 rows)
-- ---------------------------------------------------------------------------
-- with eff as (
--   select la.property_id, la.tenant_name,
--          coalesce(la.overrides->>'exclusives.exact_language', la.abstract->'exclusives'->>'exact_language','') as lang
--   from lease_abstracts la
--   where coalesce((la.overrides->>'exclusives.exists')::boolean,(la.abstract->'exclusives'->>'exists')::boolean,false)=true)
-- select pe.owner_tenant, length(pe.description) as old_len, length(e.lang) as new_len
-- from property_exclusives pe join eff e
--   on e.property_id=pe.property_id and e.tenant_name=pe.owner_tenant
-- where pe.notes like 'Auto-seeded%' and e.lang <> pe.description and e.lang <> ''
-- order by (length(e.lang) - length(pe.description)) desc;

-- ---------------------------------------------------------------------------
-- 2. Refresh auto-seeded rows from the current effective abstract, untruncated.
--
--    HOLD LIST -- excluded deliberately:
--      Starbuck's (KM West). Its abstract has been REGENERATED since the seed and the
--      new text is SHORTER (500 -> 404). It drops the "Notwithstanding the foregoing
--      sentence, other tenants may sell non-gourmet, non-brand identified..." carve-out
--      that the current truncated row still carries. Re-seeding would LOSE information,
--      which is the very failure this script exists to undo. Leave it and re-abstract
--      the Starbucks lease instead.
-- ---------------------------------------------------------------------------
with eff as (
  select la.property_id, la.tenant_name,
         coalesce(la.overrides->>'exclusives.exact_language',
                  la.abstract->'exclusives'->>'exact_language', '') as lang,
         coalesce(la.overrides->>'exclusives.section',
                  la.abstract->'exclusives'->>'section') as section
  from lease_abstracts la
  where coalesce((la.overrides->>'exclusives.exists')::boolean,
                 (la.abstract->'exclusives'->>'exists')::boolean, false) = true
)
update public.property_exclusives pe
set description     = e.lang,
    source_citation = coalesce(e.section, pe.source_citation),
    notes           = 'Auto-seeded from lease_abstracts (effective exclusives.exists=true). '
                      || 'Curate as needed. Re-seeded untruncated 2026-07-27.',
    updated_at      = now()
from eff e
where e.property_id = pe.property_id
  and e.tenant_name = pe.owner_tenant
  and pe.notes like 'Auto-seeded%'
  and e.lang <> ''
  and e.lang <> pe.description
  and pe.owner_tenant <> 'Starbuck''s';          -- see HOLD LIST above

-- ---------------------------------------------------------------------------
-- 3. Two effective abstracts had no registry row at all (added after the original
--    seed). Insert them so the registry is complete.
--      Wild Wings Cafe        @ Magnolia Park
--      Burlington Coat Factory @ KM West
--    NOTE the deliberate asymmetry with step 2: this inserts ONLY where no row
--    exists, so it can never overwrite a curated entry.
-- ---------------------------------------------------------------------------
insert into public.property_exclusives
  (property_id, owner_tenant, description, category, keywords, source_citation, active, notes)
select la.property_id,
       la.tenant_name,
       coalesce(la.overrides->>'exclusives.exact_language',
                la.abstract->'exclusives'->>'exact_language', ''),
       'auto-seeded',
       array[lower(la.tenant_name)],
       coalesce(la.overrides->>'exclusives.section',
                la.abstract->'exclusives'->>'section'),
       true,
       'Auto-seeded from lease_abstracts (effective exclusives.exists=true). '
       || 'Curate as needed. Added by re-seed 2026-07-27.'
from public.lease_abstracts la
where coalesce((la.overrides->>'exclusives.exists')::boolean,
               (la.abstract->'exclusives'->>'exists')::boolean, false) = true
  and coalesce(la.overrides->>'exclusives.exact_language',
               la.abstract->'exclusives'->>'exact_language', '') <> ''
  and not exists (
    select 1 from public.property_exclusives pe
    where pe.property_id = la.property_id and pe.owner_tenant = la.tenant_name);

-- ---------------------------------------------------------------------------
-- 4. Verify before committing. Expect: truncated_at_500 -> 0 (bar the held row),
--    and mentions_a_carveout to roughly double off its baseline of 23.
-- ---------------------------------------------------------------------------
select count(*)                                                       as total_rows,
       count(*) filter (where length(description) = 500)              as still_exactly_500,
       count(*) filter (where description ~* 'notwithstanding|shall not apply|does not apply|provided, however')
                                                                      as mentions_a_carveout,
       count(*) filter (where description ilike '%outparcel%')        as mentions_outparcel
from public.property_exclusives;

commit;

-- NOT ADDRESSED HERE (reported, deliberately untouched):
--   Nordstrom Rack @ Magnolia -- an auto-seeded row whose matching abstract no longer
--   reports exclusives.exists=true. Could be a regenerated abstract that lost the
--   clause, or a genuine change. Needs a look at the lease, not a bulk edit.
--   Whole Foods @ Gateway -- IS re-seeded above, but the new text changes the restricted
--   area ("Adjacent Shopping Space" -> "Small Shop Retail Space") and adds a 4-user /
--   8,100 sf aggregate cap while apparently dropping old subsection (B) (salons).
--   More informative than what it replaces, but worth confirming against the lease.

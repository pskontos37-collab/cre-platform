-- 20240196_abstract_qa_closeouts
-- Closes the three data-side Abstract-QA loose ends (queue item 7), all owner-adjudicated:
--  1) BEV MAX (Gateway): term.expiration 2032-04-30 -> 2032-04-28 per owner call 2026-07-29
--     (Amendment to Lease 2021-10-28 §3: 10 yrs 6 mos from Effective Date = 4/28/2032; MRI
--     concurs; the abstract's own expiration_basis derives 4/28). Swept critical_dates[0]
--     and the final base_rent_schedule row per the Rack Room narrative-fields lesson.
--  2) Warby Parker (Gateway): square_footage 2,000 -> 1,951 per owner rule 2026-07-31
--     (rent-roll RSF governs). Latest Gateway snapshot suite 007 = 1,951 sf; units.007
--     rentable_sf = 1,951; floor plans state 1,951; 135,000 / 1,951 = 69.20 ties the stored
--     psf. leases.leased_sf aligned to the same figure. §2.04 remeasurement-certificate
--     CONFIRM stays open in open_items.
--  3) Cheddar's (Magnolia): wire both Darden renewal-exercise letters (2026-03-24 second
--     exercise; 2021-03-02 first exercise) into source_doc_ids — they were ingested
--     2026-06-30 but never attached, which is why QA called the 2031-09-30 expiration
--     needs_source ("letter not in corpus" was really "letter not in source_doc_ids").
-- Corrections ride the overrides layer (survives regeneration); raw abstract JSON untouched.
do $$
declare
  v_bev uuid; v_warby uuid; v_ched uuid; v_l2026 uuid; v_l2021 uuid; v_lease uuid;
  n int; v_exp text; v_cd0 text; v_sched16 text; v_sf text; v_leased numeric; v_cnt int;
begin
  select la.id into strict v_bev from lease_abstracts la join properties p on p.id = la.property_id
    where p.name ilike '%gateway%' and la.tenant_name ilike '%bev max%';
  select la.id into strict v_warby from lease_abstracts la join properties p on p.id = la.property_id
    where p.name ilike '%gateway%' and la.tenant_name ilike '%warby%';
  select la.id into strict v_ched from lease_abstracts la join properties p on p.id = la.property_id
    where p.name ilike '%magnolia%' and la.tenant_name ilike '%cheddar%';
  select d.id into strict v_l2026 from documents d where d.id::text like 'a596a5cd%';
  select d.id into strict v_l2021 from documents d where d.id::text like 'eaecf086%';

  -- ── guards: predicted pre-state, fail loudly on any drift ──
  select abstract->'term'->>'expiration',
         abstract->'critical_dates'->0->>'date',
         abstract->'base_rent_schedule'->16->>'end'
    into v_exp, v_cd0, v_sched16 from lease_abstracts where id = v_bev;
  if v_exp is distinct from '2032-04-30' or v_cd0 is distinct from '2032-04-30'
     or v_sched16 is distinct from '2032-04-30' then
    raise exception 'BEV MAX pre-state mismatch: exp=% cd0=% sched16=%', v_exp, v_cd0, v_sched16;
  end if;
  if (select overrides from lease_abstracts where id = v_bev) is not null then
    raise exception 'BEV MAX overrides unexpectedly non-null';
  end if;

  select abstract->>'square_footage' into v_sf from lease_abstracts where id = v_warby;
  if v_sf is distinct from '2000' then raise exception 'Warby abstract sf pre-state %', v_sf; end if;
  if coalesce((select overrides ? 'square_footage' from lease_abstracts where id = v_warby), false) then
    raise exception 'Warby square_footage already overridden';
  end if;
  select l.id, l.leased_sf into strict v_lease, v_leased
    from leases l join tenants t on t.id = l.tenant_id join properties p on p.id = l.property_id
    where p.name ilike '%gateway%' and t.name ilike '%warby%';
  if v_leased is distinct from 2000 then raise exception 'Warby leases.leased_sf pre-state %', v_leased; end if;

  select cardinality(source_doc_ids) into v_cnt from lease_abstracts where id = v_ched;
  if v_cnt is distinct from 11 then raise exception 'Cheddars source_doc_ids count % (expected 11)', v_cnt; end if;
  if exists (select 1 from lease_abstracts where id = v_ched
             and (v_l2026 = any(source_doc_ids) or v_l2021 = any(source_doc_ids))) then
    raise exception 'Cheddars letters already wired';
  end if;

  -- ── 1) BEV MAX ──
  update lease_abstracts set
    overrides = coalesce(overrides, '{}'::jsonb) || jsonb_build_object(
      'term.expiration', '2032-04-28',
      'critical_dates.0.date', '2032-04-28',
      'base_rent_schedule.16.end', '2032-04-28'),
    review_note = coalesce(review_note || chr(10), '') ||
      '2026-08-05: term.expiration 2032-04-30 -> 2032-04-28 per owner call 2026-07-29 (Amd 2021-10-28 §3 formula = 4/28/2032; MRI concurs; expiration_basis itself derives 4/28). critical_dates[0] + final rent row swept to match (mig 20240196).'
  where id = v_bev;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'BEV MAX update touched % rows', n; end if;

  -- ── 2) Warby Parker ──
  update lease_abstracts set
    overrides = coalesce(overrides, '{}'::jsonb) || jsonb_build_object('square_footage', 1951),
    review_note = coalesce(review_note || chr(10), '') ||
      '2026-08-05: square_footage 2,000 -> 1,951 per rent-roll-governs rule (owner 2026-07-31): latest snapshot suite 007 = 1,951; units.007 = 1,951; 135,000/1,951 = 69.20 ties stored psf. Lease §1.01(10) 2,000 sf was subject to §2.04 remeasurement; certificate CONFIRM stays open (mig 20240196).'
  where id = v_warby;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Warby update touched % rows', n; end if;

  update leases set leased_sf = 1951 where id = v_lease;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Warby lease update touched % rows', n; end if;

  -- ── 3) Cheddar's ──
  update lease_abstracts set source_doc_ids = source_doc_ids || array[v_l2026, v_l2021]
  where id = v_ched;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Cheddars update touched % rows', n; end if;

  -- ── post-assertions ──
  if (select abstract->'term'->>'expiration' from lease_abstracts where id = v_bev) <> '2032-04-30' then
    raise exception 'BEV MAX raw abstract mutated — must stay 2032-04-30 under the override layer';
  end if;
  if (select overrides->>'term.expiration' from lease_abstracts where id = v_bev) <> '2032-04-28' then
    raise exception 'BEV MAX override not readable back';
  end if;
  if (select overrides->>'square_footage' from lease_abstracts where id = v_warby) <> '1951' then
    raise exception 'Warby override not readable back';
  end if;
  if (select leased_sf from leases where id = v_lease) <> 1951 then
    raise exception 'Warby leases.leased_sf not 1951 after update';
  end if;
  if (select cardinality(source_doc_ids) from lease_abstracts where id = v_ched) <> 13 then
    raise exception 'Cheddars source_doc_ids not 13 after update';
  end if;
end $$;

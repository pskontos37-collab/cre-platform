-- 20240199_comps_quarantine_content_check
-- Works the comps quarantine queue with the CONTENT check the 7/27 analysis
-- prescribed for header-untestable tabs, done in-DB: a tab's tenant-roster
-- fingerprint (distinct scope_key where scope_kind='tenant', >=3 labels) is
-- compared against CONFIRMED tabs of its own property vs every other property.
-- Calibration on knowns: confirmed sets avg 0.79 own / 0.13 foreign overlap;
-- known-contaminated avg 0.06 own / 0.76 foreign, 25 of 35 carrying the
-- signature (foreign >= 0.6 AND own < 0.3).
--
-- Dispositions (NOTHING leaves quarantine — v_assumption must not move a row):
--  A) 15 unverified sets carry the contamination signature -> 'contaminated'
--     (14x Kansas\Park Place Village tabs carrying California\The Courtyard at
--     Palm Springs' roster at 1.00 — copy-forward under a placeholder header;
--     1x Chicago\One South Wacker <- 120 South LaSalle at 1.00, independently
--     re-finding the contamination the 7/27 WEAK-token check caught).
--  B) 21 unverified sets tested indeterminate (roster matches no confirmed set
--     either side) -> 'untestable'.
--  C) 79 unverified sets have <3 tenant-scoped labels (space-category/global
--     tabs — the fingerprint is inapplicable) -> 'untestable'.
--  D) the 227 pre-existing contaminated sets get review stamps: the structural
--     header evidence stands, and recovery is moot since the all-versions load
--     already rescued affected properties via version-rank fallback.
-- reviewed_by stays NULL everywhere (no human reviewed these; the method is in
-- review_note). reviewed_at marks the disposition timestamp.
do $$
declare
  n_unv int; n_cont int; n_untest int; n_rev int; n int;
  v_assum_before bigint; v_assum_after bigint; q_before bigint; q_after bigint;
begin
  select count(*) into v_assum_before from comps.v_assumption;
  select count(*) into q_before from comps.v_quarantine_review;
  select count(*) filter (where validation = 'unverified'),
         count(*) filter (where validation = 'contaminated'),
         count(*) filter (where validation = 'untestable'),
         count(*) filter (where reviewed_at is not null)
    into n_unv, n_cont, n_untest, n_rev
  from comps.assumption_set;
  if n_unv <> 115 or n_cont <> 227 or n_untest <> 0 or n_rev <> 0 then
    raise exception 'pre-state mismatch: unverified=% contaminated=% untestable=% reviewed=%', n_unv, n_cont, n_untest, n_rev;
  end if;

  create temp table _fp on commit drop as
  with set_labels as (
    select s.id as set_id, d.source_property_id as prop_id, s.validation,
           array_agg(distinct a.scope_key) as labels, count(distinct a.scope_key) as n_labels
    from comps.assumption_set s
    join comps.source_document d on d.id = s.source_document_id
    join comps.assumption a on a.assumption_set_id = s.id
    where a.scope_kind = 'tenant' and a.scope_key is not null
    group by s.id, d.source_property_id, s.validation
    having count(distinct a.scope_key) >= 3
  )
  select u.set_id, u.n_labels,
    coalesce(max((select count(*) from unnest(u.labels) l where l = any(c.labels))::numeric / u.n_labels)
      filter (where c.prop_id = u.prop_id), 0) as own_ov,
    coalesce(max((select count(*) from unnest(u.labels) l where l = any(c.labels))::numeric / u.n_labels)
      filter (where c.prop_id <> u.prop_id), 0) as foreign_ov,
    (array_agg(c.prop_id order by (select count(*) from unnest(u.labels) l where l = any(c.labels))::numeric / u.n_labels desc)
      filter (where c.prop_id <> u.prop_id))[1] as foreign_prop
  from set_labels u
  left join set_labels c on c.set_id <> u.set_id and c.validation = 'confirmed'
  where u.validation = 'unverified'
  group by u.set_id, u.prop_id, u.n_labels;

  -- A) contamination signature
  update comps.assumption_set s set
    validation = 'contaminated',
    conflicting_source_property_id = f.foreign_prop,
    conflicting_name = (select folder_name from comps.source_property where id = f.foreign_prop),
    review_note = 'content check (mig 20240199): tenant-roster fingerprint matches '
      || (select market || '\' || folder_name from comps.source_property where id = f.foreign_prop)
      || ' at ' || round(f.foreign_ov, 2) || ' while own-property confirmed tabs match at '
      || round(f.own_ov, 2) || ' — copy-forward under an untestable header. Stays quarantined.',
    reviewed_at = now()
  from _fp f
  where f.set_id = s.id and f.foreign_ov >= 0.6 and f.own_ov < 0.3;
  get diagnostics n = row_count;
  if n <> 15 then raise exception 'bucket A expected 15 rows, touched %', n; end if;

  -- B) tested, indeterminate
  update comps.assumption_set s set
    validation = 'untestable',
    review_note = 'content check (mig 20240199): roster of ' || f.n_labels
      || ' tenant labels matches no confirmed set (own ' || round(f.own_ov, 2)
      || ', best foreign ' || round(f.foreign_ov, 2)
      || ') — cannot adjudicate in-DB; deciding needs the deal folder''s own rent roll/OM. Stays quarantined.',
    reviewed_at = now()
  from _fp f
  where f.set_id = s.id and s.validation = 'unverified';
  get diagnostics n = row_count;
  if n <> 21 then raise exception 'bucket B expected 21 rows, touched %', n; end if;

  -- C) fingerprint inapplicable
  update comps.assumption_set s set
    validation = 'untestable',
    review_note = 'content check (mig 20240199): fewer than 3 tenant-scoped labels — the roster fingerprint is inapplicable (space-category/global-only tab) and the header was already untestable. Stays quarantined.',
    reviewed_at = now()
  where s.validation = 'unverified';
  get diagnostics n = row_count;
  if n <> 79 then raise exception 'bucket C expected 79 rows, touched %', n; end if;

  -- D) review-stamp the structurally confirmed contaminated sets (pre-existing 227 only)
  update comps.assumption_set s set
    review_note = coalesce(review_note || ' | ', '')
      || 'review stamp (mig 20240199): structural header evidence stands (tab header names a different corpus property'
      || case when conflicting_name is not null then ': ' || conflicting_name else '' end
      || '); quarantine correct. Recovery unnecessary — the all-versions load already rescued affected properties via version-rank fallback.',
    reviewed_at = now()
  where s.validation = 'contaminated' and s.reviewed_at is null;
  get diagnostics n = row_count;
  if n <> 227 then raise exception 'bucket D expected 227 rows, touched %', n; end if;

  -- post-assertions
  select count(*) filter (where validation = 'unverified'),
         count(*) filter (where validation = 'contaminated'),
         count(*) filter (where validation = 'untestable'),
         count(*) filter (where reviewed_at is not null)
    into n_unv, n_cont, n_untest, n_rev
  from comps.assumption_set;
  if n_unv <> 0 or n_cont <> 242 or n_untest <> 100 or n_rev <> 342 then
    raise exception 'post-state mismatch: unverified=% contaminated=% untestable=% reviewed=%', n_unv, n_cont, n_untest, n_rev;
  end if;
  select count(*) into v_assum_after from comps.v_assumption;
  if v_assum_after <> v_assum_before then
    raise exception 'v_assumption moved: % -> % — dispositions must not change quarantine membership', v_assum_before, v_assum_after;
  end if;
  select count(*) into q_after from comps.v_quarantine_review;
  if q_after <> q_before then
    raise exception 'quarantine view moved: % -> %', q_before, q_after;
  end if;
end $$;

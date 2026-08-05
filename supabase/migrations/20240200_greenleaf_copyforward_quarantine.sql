-- 20240200_greenleaf_copyforward_quarantine
-- Adjudicates the three cross-property roster pairs the 20240199 content check
-- surfaced among CONFIRMED sets, with folder-level evidence:
--
-- 1) Greenleaf at Cheltenham (PA) -> CONTAMINATED. Its only model tab
--    (CF Model_Greenleat at Cheltenham_7-20-20.xlsx) carries tenant columns
--    nordstrom rack / rei / sprouts / west marine — the Markets at Town Center
--    (Jacksonville, FL) anchor lineup, whose model predates it by 5 months.
--    The deal folder's own Underwriting Notes (K:\...\Greenleaf at Cheltenham\
--    Underwriting Notes_Greenleaf_7-20-2020.docx) list the REAL tenancy: shadow
--    anchors Home Depot / Target / ShopRite / Burlington, plus Marshalls and
--    LA Fitness — zero mention of the tab's four retailers. Classic
--    copy-forward with only the header updated, which is why the 7/27 header
--    check confirmed it. Removes 87 rows from v_assumption (98,009 -> 97,922;
--    Pennsylvania 8,436 -> 8,349) — those values are Jacksonville's.
-- 2) Lakeview Place (TN) <-> Millenium One, Two & Three (PA): FALSE POSITIVE.
--    The shared "roster" is building i/ii/iii — generic multi-building labels
--    misclassified as tenants, not retailer identity. Both stay confirmed.
-- 3) Northside Center (NC) 10-28-2019 draft vs The Courtyard at Palm Springs
--    (CA): generic office-building letters (incl. the distinctive 'f2') match
--    4/6; the model was superseded next day by relabeled versions. Suspicion
--    recorded; left confirmed — generic labels are not identity evidence and
--    the set is version rank > 1 (not driving 'latest' answers).
do $$
declare
  v_gset uuid; v_mtc_prop uuid; v_mtc_set uuid; v_lake uuid; v_mill uuid; v_north uuid;
  n int; v_before bigint; v_after bigint; v_pa_before bigint; v_pa_after bigint; v_rows int;
begin
  select count(*) into v_before from comps.v_assumption;
  select count(*) into v_pa_before from comps.v_assumption where market = 'Pennsylvania';
  if v_before <> 98009 or v_pa_before <> 8436 then
    raise exception 'pre-state mismatch: v_assumption=% pa=%', v_before, v_pa_before;
  end if;

  select s.id into strict v_gset from comps.assumption_set s
    join comps.source_document sd on sd.id = s.source_document_id
    join comps.source_property sp on sp.id = sd.source_property_id
    where sp.folder_name = 'Greenleaf at Cheltenham' and s.validation = 'confirmed';
  select count(*) into v_rows from comps.assumption where assumption_set_id = v_gset;
  if v_rows <> 87 then raise exception 'Greenleaf set expected 87 rows, has %', v_rows; end if;

  select id into strict v_mtc_prop from comps.source_property where folder_name = 'Markets at Town Center';
  select s.id into strict v_mtc_set from comps.assumption_set s
    join comps.source_document sd on sd.id = s.source_document_id
    where sd.source_property_id = v_mtc_prop and s.validation = 'confirmed';
  select s.id into strict v_lake from comps.assumption_set s
    join comps.source_document sd on sd.id = s.source_document_id
    where sd.file_name = 'CF Model_Lakeview Place_01-17-2021.xlsx';
  select s.id into strict v_mill from comps.assumption_set s
    join comps.source_document sd on sd.id = s.source_document_id
    where sd.file_name = 'CF Model_Millennium I-III_08-21-2018.xlsx';
  select s.id into strict v_north from comps.assumption_set s
    join comps.source_document sd on sd.id = s.source_document_id
    where sd.file_name = 'CF Model_Northside Center_10-28-2019.xlsx';

  -- 1) Greenleaf -> contaminated
  update comps.assumption_set set
    validation = 'contaminated',
    conflicting_source_property_id = v_mtc_prop,
    conflicting_name = 'Markets at Town Center',
    review_note = coalesce(review_note || ' | ', '') ||
      'folder adjudication (mig 20240200): tab tenant columns (nordstrom rack/rei/sprouts/west marine) = Markets at Town Center (FL) anchor lineup, model dated 5 months later; the deal folder''s own Underwriting Notes list Home Depot/Target/ShopRite/Burlington/Marshalls/LA Fitness and none of the tab''s four. Copy-forward with updated header — quarantined.',
    reviewed_at = now()
  where id = v_gset;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Greenleaf update touched % rows', n; end if;

  -- 2-3) adjudication notes, no validation change
  update comps.assumption_set set review_note = coalesce(review_note || ' | ', '') ||
    'adjudication (mig 20240200): this set is the GENUINE ORIGIN of the nordstrom rack/rei/sprouts/west marine roster found copied into Greenleaf at Cheltenham''s 7-20-20 model. Stays confirmed.'
  where id = v_mtc_set;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'MTC note touched % rows', n; end if;

  update comps.assumption_set set review_note = coalesce(review_note || ' | ', '') ||
    'adjudication (mig 20240200): 8/05 roster-fingerprint flag vs Millenium I-III is a FALSE POSITIVE — shared labels are generic building i/ii/iii (multi-building columns misclassified as tenants), not retailer identity. Stays confirmed.'
  where id = v_lake;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Lakeview note touched % rows', n; end if;

  update comps.assumption_set set review_note = coalesce(review_note || ' | ', '') ||
    'adjudication (mig 20240200): 8/05 roster-fingerprint flag vs Lakeview Place is a FALSE POSITIVE — shared labels are generic building i/ii/iii, not retailer identity. Stays confirmed.'
  where id = v_mill;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Millenium note touched % rows', n; end if;

  update comps.assumption_set set review_note = coalesce(review_note || ' | ', '') ||
    'watch note (mig 20240200): 4/6 generic office-building labels (incl. ''f2'') match The Courtyard at Palm Springs'' 9-13-2019 model from 4 weeks earlier; superseded next day by relabeled versions (rank > 1, not driving latest-vintage answers). Left confirmed — generic labels are not identity evidence; revisit only if this version''s values are ever quoted.'
  where id = v_north;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Northside note touched % rows', n; end if;

  -- post-assertions
  select count(*) into v_after from comps.v_assumption;
  select count(*) into v_pa_after from comps.v_assumption where market = 'Pennsylvania';
  if v_after <> 97922 then raise exception 'v_assumption expected 97922, got %', v_after; end if;
  if v_pa_after <> 8349 then raise exception 'PA rows expected 8349, got %', v_pa_after; end if;
  if exists (select 1 from comps.v_assumption where property = 'Greenleaf at Cheltenham') then
    raise exception 'Greenleaf rows still visible in v_assumption';
  end if;
end $$;

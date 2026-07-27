-- 20240137_comps_schema.sql
-- In-house leasing-comps / market-assumptions database, built from the acquisition corpus
-- at K:\ASSTMGMT\ACQUISITIONS (340,161 files / 673 GB / 2,532 property folders, 1981-2026).
--
-- ============================================================================
-- INTERNAL USE ONLY. Material in this schema derives from Offering Memoranda and
-- diligence files received under confidentiality agreements. It is for internal
-- evaluation only and MUST NOT be joined into LP-facing outputs -- specifically
-- NOT into IcMemoReport / InvestmentSummaryPpt / InvestmentSummary PDF, which are
-- distributed outside the firm. Retention: every row traces to
-- comps.source_document.counterparty so a single source can be purged on demand
-- (see 20240122_property_purge_export for the established purge pattern).
-- ============================================================================
--
-- WHY THE SCHEMA LOOKS LIKE THIS -- each choice below is forced by a measured
-- property of the real extract (1,013 folders / 1,230 workbooks / 32,153 cells,
-- read-only dry run 2026-07-27; artifacts in Desktop\Software\acq_inventory\):
--
--   1. QUARANTINE IS STRUCTURAL, NOT ADVISORY. 13.3% of 'Argus Assumptions' tabs
--      (107 of 804) are headed with a DIFFERENT property name -- copy-forward contamination,
--      96% of it confirmed by the header naming a property that exists as its own
--      folder elsewhere in the corpus (a Chicago CBD office model carrying Ohio
--      grocery-anchored retail assumptions). assumption_set.is_quarantined is a
--      GENERATED column and the clean view filters on it, so contaminated rows
--      cannot leak into an average by anyone forgetting a WHERE clause.
--
--   2. SCOPE IS A DIMENSION, NOT AN ENUM. 53% of workbooks (330 of 628) key their
--      market leasing assumptions to a NAMED TENANT or suite, not to a space
--      category; 47% use space categories. Both are first-class.
--
--   3. VALUES ARE TYPED BY SHAPE x UNIT, because one source field mixes both.
--      Leasing commissions arrive as '6% / 3%' (percent of rent, n=2,335) AND
--      '$9.38 / $9.38' (dollars PSF, n=603) -- averaging them would be silent
--      nonsense. Rent bumps carry five different semantics: '3% Annually' (61%),
--      '$0.50 psf' (12%), 'None' (9%), '10% in Y6' (9%), raw '0.03' (8%).
--      Hence value_kind (shape) x unit (measure) x recurrence, orthogonal.
--
--   4. raw_value IS NEVER DISCARDED. 421 distinct raw formats across 9 metrics.
--      The normalizer will improve; the source string is the audit trail.
--
--   5. AS-OF DATE IS MANDATORY. Corpus vintage spans 1981-2026. A comp without a
--      date is worse than no comp. date_source records how we know it, because the
--      filename convention (CF Model_<Property>_<M-D-YYYY>.xlsx) is more reliable
--      than file mtime.
--
--   6. ALL MODEL VERSIONS ARE LOADABLE. The dry run took the newest model per
--      folder and thereby lost the longitudinal series (usable vintages collapsed
--      to 2017-2026 though models exist back to 2009). source_document is unique on
--      (source_property_id, file_name), NOT one-per-property, so loading all 4,593
--      versions later is additive and needs no migration.
--
--   7. TRUST TIERS NEVER BLEND. Some tabs are headed "Brokers Argus Assumption" --
--      the broker number, not ours. The CF Model template even carries a separate
--      "Brokers Underwriting" column. trust_tier keeps them separable.
--
-- No existing table is altered. This migration is purely additive.

create schema if not exists comps;
comment on schema comps is
  'Internal-only leasing comps and market leasing assumptions mined from the acquisition corpus. Not for LP-facing outputs. See migration 20240137 header.';

grant usage on schema comps to authenticated, service_role;
revoke all on schema comps from anon;

-- ============================================================================
-- TWO OPERATIONAL STEPS THIS MIGRATION CANNOT DO FOR ITSELF:
--
--   (a) PostgREST does not expose a new schema by default. Until 'comps' is added
--       to Dashboard > Project Settings > API > Exposed schemas, neither the
--       loaders (which write over PostgREST with the service key) nor the frontend
--       can reach these tables. Everything below will exist in Postgres and be
--       invisible to the app.
--   (b) supabase-js must then address it explicitly: supabase.schema('comps')...
--       A plain .from('assumption') will look in public and fail.
--
-- The schema boundary is deliberate -- it namespaces internal-only material, makes
-- "is this LP-safe?" answerable by schema name, and lets the whole body of
-- confidential derivations be dropped in one statement if a CA ever requires it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- extract_run: provenance for each loader execution
-- ---------------------------------------------------------------------------
create table comps.extract_run (
  id               uuid primary key default gen_random_uuid(),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  script_name      text not null,
  script_version   text,
  root_path        text,
  scope_note       text,
  folders_scanned  int,
  workbooks_opened int,
  cells_written    int,
  notes            text
);
comment on table comps.extract_run is 'One row per loader run. Lets any comp be traced to the run that produced it and re-run reproducibly.';


-- ---------------------------------------------------------------------------
-- source_property: a property folder in the acquisition corpus
-- ---------------------------------------------------------------------------
create table comps.source_property (
  id                uuid primary key default gen_random_uuid(),
  market            text not null,                        -- the state/market folder, e.g. 'Chicago', 'North Carolina'
  folder_name       text not null,                        -- the property folder, verbatim
  folder_path       text,
  normalized_name   text,                                 -- tokenized form used for matching
  asset_class       text check (asset_class in ('retail','office','industrial','mixed','multifamily','other','unknown')) default 'unknown',
  city              text,
  state_code        text,
  -- link points. All nullable: most of the 2,532 folders are deals we passed on.
  pipeline_deal_id  uuid references public.pipeline_deals(id) on delete set null,
  property_id       uuid references public.properties(id)     on delete set null,  -- set only for assets we own; enables assumed-vs-realized
  first_seen_year   int,
  last_seen_year    int,
  created_at        timestamptz not null default now(),
  unique (market, folder_name)
);
comment on column comps.source_property.property_id is
  'Non-null only where this corpus folder is an asset we own. This is the join that makes assumed-vs-realized analysis possible (underwritten TI/downtime/renewal vs what the owned portfolio actually achieved).';

create index source_property_market_idx      on comps.source_property (market);
create index source_property_norm_idx        on comps.source_property (normalized_name);
create index source_property_deal_idx        on comps.source_property (pipeline_deal_id) where pipeline_deal_id is not null;
create index source_property_property_idx    on comps.source_property (property_id)      where property_id is not null;


-- ---------------------------------------------------------------------------
-- source_document: a file the comps were read out of
-- ---------------------------------------------------------------------------
create table comps.source_document (
  id                  uuid primary key default gen_random_uuid(),
  source_property_id  uuid not null references comps.source_property(id) on delete cascade,
  file_name           text not null,
  file_path           text,
  file_mb             numeric(10,2),
  doc_kind            text not null check (doc_kind in ('cf_model','argus_print','argus_binary','om','teaser','rent_roll','lease','t12','comp_set','memo','other')),
  -- the as-of stamp. model_date is what the comp is dated AS OF, not when we read it.
  model_date          date,
  date_source         text check (date_source in ('filename','file_mtime','stated_in_document','unknown')) default 'unknown',
  versions_in_folder  int,                                -- how many sibling versions existed when loaded
  sheet_count         int,
  -- retention / confidentiality: who gave us this, so it can be purged by source
  counterparty        text,
  nda_reference       text,
  -- deep-link into the corpus when the file has been mirrored in
  document_id         uuid references public.documents(id) on delete set null,
  extract_run_id      uuid references comps.extract_run(id) on delete set null,
  extracted_at        timestamptz not null default now(),
  unique (source_property_id, file_name)
);
comment on table comps.source_document is
  'One row per file read. Unique on (property, file_name) NOT one-per-property, so every CF Model version can be loaded to recover the longitudinal series.';
comment on column comps.source_document.counterparty is
  'Broker/seller who supplied the material. Populates the purge-by-source path required by CA retention clauses.';

create index source_document_property_idx on comps.source_document (source_property_id);
create index source_document_kind_date_idx on comps.source_document (doc_kind, model_date desc);
create index source_document_doc_idx      on comps.source_document (document_id) where document_id is not null;
create index source_document_counterparty_idx on comps.source_document (counterparty) where counterparty is not null;


-- ---------------------------------------------------------------------------
-- assumption_set: one 'Argus Assumptions' tab (or equivalent block)
-- ---------------------------------------------------------------------------
create table comps.assumption_set (
  id                     uuid primary key default gen_random_uuid(),
  source_document_id     uuid not null references comps.source_document(id) on delete cascade,
  tab_name               text,
  tab_header             text,                            -- raw header text found on the tab
  trust_tier             text not null default 'unknown'
                           check (trust_tier in ('internal','broker','seller','unknown')),
  scope_axis             text not null default 'unknown'
                           check (scope_axis in ('space_category','tenant_or_suite','property','mixed','unknown')),
  -- the contamination gate
  validation             text not null default 'unverified'
                           check (validation in ('confirmed','confirmed_secondary','contaminated','unverified','untestable')),
  validation_evidence    text,                            -- matched tokens, or the sheet that confirmed it
  conflicting_name       text,                            -- the OTHER property the tab names, when contaminated
  conflicting_source_property_id uuid references comps.source_property(id) on delete set null,
  parse_status           text check (parse_status in ('ok','partial','block_empty','no_block','error')),
  labels_found           int,
  category_count         int,
  reviewed_by            uuid references auth.users(id) on delete set null,
  reviewed_at            timestamptz,
  review_note            text,
  created_at             timestamptz not null default now(),
  is_quarantined boolean generated always as
    (validation in ('contaminated','unverified','untestable')) stored,
  unique (source_document_id, tab_name)
);
comment on column comps.assumption_set.is_quarantined is
  'Generated, not set by hand. Contaminated/unverified sets are excluded from comps.v_assumption so a forgotten WHERE clause cannot pull another property''s assumptions into an average. 13.3% of real tabs land here.';
comment on column comps.assumption_set.conflicting_source_property_id is
  'When the tab names another property that exists in the corpus, point at it. 96% of measured contamination resolves this way, which is what makes the finding structural rather than heuristic.';

create index assumption_set_doc_idx   on comps.assumption_set (source_document_id);
create index assumption_set_clean_idx on comps.assumption_set (id) where is_quarantined = false;
create index assumption_set_review_idx on comps.assumption_set (validation) where is_quarantined = true;


-- ---------------------------------------------------------------------------
-- metric: seeded dimension so the UI and normalizer are data-driven
-- ---------------------------------------------------------------------------
create table comps.metric (
  key            text primary key,
  label          text not null,
  grain          text not null check (grain in ('scoped','property')),
  expect_kind    text,
  expect_unit    text,
  sort_order     int not null default 0,
  notes          text
);

insert into comps.metric (key, label, grain, expect_kind, expect_unit, sort_order, notes) values
  ('market_rent',          'Market rent',            'scoped','scalar_or_range','usd_psf',    10, 'Ranges occur ("$4.50 - $6.50"); 143 raw formats observed.'),
  ('renewal_probability',  'Renewal probability',    'scoped','scalar',        'pct',        20, 'Stored 0-100. Corpus median 75%. Values of 100% are outliers worth flagging.'),
  ('downtime_months',      'Downtime',               'scoped','scalar',        'months',     30, 'Corpus median 9 months.'),
  ('term_length',          'Term length',            'scoped','scalar',        'months',     40, 'Source mixes "10 Years" and "65 Months"; normalize to months. Corpus median 84.'),
  ('reimbursement_method', 'Reimbursement method',   'scoped','vocab',         null,         50, '98 raw forms but a real controlled vocabulary. See comps.reimbursement_vocab.'),
  ('tenant_improvements',  'Tenant improvements',    'scoped','new_renew_pair','usd_psf',    60, 'Corpus median $40 new / $5 renew.'),
  ('leasing_commissions',  'Leasing commissions',    'scoped','new_renew_pair','mixed',      70, 'UNIT VARIES BY ROW: pct_of_rent (n=2,335) vs usd_psf (n=603). Never average across units.'),
  ('rent_abatements',      'Free rent',              'scoped','new_renew_pair','months',     80, 'Corpus median 5 mo new / 3 mo renew; 1,794 cells explicitly None.'),
  ('rental_rate_increase', 'Rent bumps',             'scoped','mixed',         'mixed',      90, 'Five semantics: pct annual 61%, usd_psf 12%, none 9%, pct at year 9%, raw decimal 8%.'),
  ('inflation_general',    'Inflation - general',    'property','scalar',      'pct',       200, null),
  ('inflation_market',     'Inflation - market rent','property','scalar',      'pct',       210, null),
  ('inflation_expense',    'Inflation - expense',    'property','scalar',      'pct',       220, null),
  ('general_vacancy',      'General vacancy',        'property','scalar',      'pct',       230, null),
  ('static_vacancy',       'Static vacancy',         'property','scalar',      'pct',       240, null),
  ('management_fee',       'Management fee',         'property','scalar',      'pct',       250, 'Percent of EGR.'),
  ('capital_reserves',     'Capital reserves',       'property','scalar',      'usd_psf',   260, 'Raw forms include "$0.25/sf/yr." and "$0.10 psf/Annually".');


-- ---------------------------------------------------------------------------
-- reimbursement_vocab: curated raw -> canonical map (seeded from the real extract)
-- ---------------------------------------------------------------------------
create table comps.reimbursement_vocab (
  raw_key    text primary key,                            -- lower(trim(raw_value))
  canonical  text not null check (canonical in
                ('nnn','nnn_plus_admin','net','base_year','base_year_gross','fsg','modified_gross','none','varies','unknown')),
  is_net     boolean,                                     -- null = indeterminate
  notes      text,
  created_at timestamptz not null default now()
);
comment on table comps.reimbursement_vocab is
  'Curated mapping for the 98 raw reimbursement spellings found in the corpus. is_net drives the rule that gross and net rents are never averaged together.';

insert into comps.reimbursement_vocab (raw_key, canonical, is_net, notes) values
  ('nnn',            'nnn',             true,  'n=1,611 - the modal structure'),
  ('net',            'net',             true,  'n=190'),
  ('nnn + 15%',      'nnn_plus_admin',  true,  'n=48 - NNN with a 15% CAM admin load'),
  ('nnn+15%',        'nnn_plus_admin',  true,  'n=39 - same as above, different spelling'),
  ('base yr.',       'base_year',       false, 'n=199'),
  ('base year',      'base_year',       false, 'n=196'),
  ('new by',         'base_year',       false, 'n=27 - base year reset at each new lease'),
  ('by stop',        'base_year',       false, 'n=21'),
  ('by gross',       'base_year_gross', false, 'n=73'),
  ('fsg',            'fsg',             false, 'n=56 - full service gross'),
  ('none',           'none',            null,  'n=157 - no recovery stated'),
  ('varies',         'varies',          null,  'n=24 - per-tenant; do not aggregate');


-- ---------------------------------------------------------------------------
-- assumption: the fact table. One row per extracted cell.
-- ---------------------------------------------------------------------------
create table comps.assumption (
  id                 uuid primary key default gen_random_uuid(),
  assumption_set_id  uuid not null references comps.assumption_set(id) on delete cascade,
  metric             text not null references comps.metric(key),

  -- WHAT the assumption applies to
  scope_label        text,                                -- 'Retail', 'Office', 'Giant Eagle', 'Suite 140'
  scope_kind         text not null default 'unknown'
                       check (scope_kind in ('space_category','tenant','suite','property','unknown')),
  tenant_id          uuid references public.tenants(id) on delete set null,   -- resolved via tenants.file_aliases
  column_position    int,                                 -- source column order, for round-tripping

  -- provenance: the source string is never discarded
  raw_value          text not null,

  -- typed representation: shape x unit x recurrence, orthogonal
  value_kind         text not null default 'unparsed'
                       check (value_kind in ('scalar','new_renew_pair','range','at_year','vocab','none','unparsed')),
  unit               text check (unit in ('pct','pct_of_rent','usd_psf','months','years','ratio')),
  recurrence         text check (recurrence in ('annual','one_time','per_term')),
  num_value          numeric(14,4),                       -- scalar / at_year magnitude
  num_new            numeric(14,4),                       -- new-lease side of a pair
  num_renew          numeric(14,4),                       -- renewal side of a pair
  num_min            numeric(14,4),                       -- range low
  num_max            numeric(14,4),                       -- range high
  at_year            int,                                 -- '10% in Y6' -> 6
  vocab_value        text,                                -- canonical reimbursement etc.

  normalizer_version text,
  created_at         timestamptz not null default now(),

  -- fail loudly on a bad load rather than storing a half-parsed row
  constraint assumption_shape_ck check (
       (value_kind = 'scalar'         and num_value is not null
                                      and num_new is null and num_renew is null
                                      and num_min is null and num_max is null)
    or (value_kind = 'new_renew_pair' and num_new is not null
                                      and num_value is null
                                      and num_min is null and num_max is null)
    or (value_kind = 'range'          and num_min is not null and num_max is not null
                                      and num_max >= num_min
                                      and num_value is null)
    or (value_kind = 'at_year'        and num_value is not null and at_year is not null)
    or (value_kind = 'vocab'          and vocab_value is not null)
    or (value_kind = 'none')
    or (value_kind = 'unparsed')
  ),
  constraint assumption_pct_range_ck check (
    unit <> 'pct' or num_value is null or (num_value >= 0 and num_value <= 100)
  ),
  -- Percentages are stored 0-100. The source stores renewal probability as 0.75, so a
  -- loader that forgets to scale would write 0.75 -- which passes the 0-100 check above
  -- and silently drags the median from 75 to under 1. No real renewal probability sits
  -- below 1%, so reject it at the door.
  constraint assumption_pct_scale_ck check (
    metric <> 'renewal_probability' or num_value is null
    or num_value = 0 or num_value >= 1
  )
);
comment on table comps.assumption is
  'One extracted cell. raw_value is mandatory and permanent; the typed columns are the normalizer''s interpretation and may be recomputed as it improves.';
comment on column comps.assumption.unit is
  'Per-ROW, not per-metric. Leasing commissions genuinely arrive as both pct_of_rent and usd_psf in the same corpus; aggregation MUST group by unit.';

create index assumption_set_idx        on comps.assumption (assumption_set_id);
create index assumption_metric_idx     on comps.assumption (metric, scope_kind);
create index assumption_lookup_idx     on comps.assumption (metric, unit, value_kind);
create index assumption_tenant_idx     on comps.assumption (tenant_id) where tenant_id is not null;
create index assumption_scope_label_idx on comps.assumption (lower(scope_label));


-- ---------------------------------------------------------------------------
-- Views. security_invoker so base-table RLS applies to the caller.
-- ---------------------------------------------------------------------------

-- clean, flat rows for the lookup panel. Quarantined sets are structurally absent.
create view comps.v_assumption with (security_invoker = true) as
select
  a.id                    as assumption_id,
  sp.market,
  sp.folder_name          as property,
  sp.asset_class,
  sp.property_id,
  sp.pipeline_deal_id,
  sd.model_date,
  sd.date_source,
  sd.doc_kind,
  sd.file_name,
  sd.document_id,
  aset.trust_tier,
  aset.validation,
  aset.scope_axis,
  a.metric,
  m.label                 as metric_label,
  a.scope_kind,
  a.scope_label,
  a.tenant_id,
  a.raw_value,
  a.value_kind,
  a.unit,
  a.recurrence,
  a.num_value,
  a.num_new,
  a.num_renew,
  a.num_min,
  a.num_max,
  a.at_year,
  a.vocab_value
from comps.assumption a
join comps.assumption_set aset on aset.id = a.assumption_set_id
join comps.source_document sd  on sd.id  = aset.source_document_id
join comps.source_property sp  on sp.id  = sd.source_property_id
join comps.metric m            on m.key  = a.metric
where aset.is_quarantined = false;

comment on view comps.v_assumption is
  'The only view application code should read for comp values. Excludes quarantined sets. Always carries model_date and trust_tier so a caller cannot present an undated or broker-sourced number as an in-house assumption.';


-- distribution rollup. Grouped by unit deliberately, so pct and $/SF never mix.
create view comps.v_assumption_rollup with (security_invoker = true) as
select
  market,
  asset_class,
  metric,
  scope_kind,
  unit,
  trust_tier,
  count(*)                                                                        as n,
  count(distinct property)                                                        as n_properties,
  min(model_date)                                                                 as earliest,
  max(model_date)                                                                 as latest,
  percentile_cont(0.25) within group (order by coalesce(num_value, num_new, (num_min + num_max)/2)) as p25,
  percentile_cont(0.50) within group (order by coalesce(num_value, num_new, (num_min + num_max)/2)) as median,
  percentile_cont(0.75) within group (order by coalesce(num_value, num_new, (num_min + num_max)/2)) as p75,
  min(coalesce(num_value, num_new, num_min))                                      as min_value,
  max(coalesce(num_value, num_new, num_max))                                      as max_value
from comps.v_assumption
where value_kind in ('scalar','new_renew_pair','range')
group by market, asset_class, metric, scope_kind, unit, trust_tier;

comment on view comps.v_assumption_rollup is
  'Distributions for the underwriting lookup. Grouped by unit AND asset_class on purpose: an ungrouped market-rent median blends office and retail and is not a defensible number.';


-- the human adjudication queue for contaminated / unverifiable tabs
create view comps.v_quarantine_review with (security_invoker = true) as
select
  aset.id                as assumption_set_id,
  sp.market,
  sp.folder_name         as property,
  sd.file_name,
  sd.model_date,
  aset.tab_header,
  aset.validation,
  aset.conflicting_name,
  cf.market              as conflicting_market,
  cf.folder_name         as conflicting_property,
  aset.labels_found,
  aset.category_count,
  aset.reviewed_by,
  aset.reviewed_at,
  aset.review_note
from comps.assumption_set aset
join comps.source_document sd on sd.id = aset.source_document_id
join comps.source_property sp on sp.id = sd.source_property_id
left join comps.source_property cf on cf.id = aset.conflicting_source_property_id
where aset.is_quarantined = true;

comment on view comps.v_quarantine_review is
  'Work queue for the ~13% of tabs whose property identity is wrong or unproven. Reviewing one means setting assumption_set.validation plus reviewed_by/reviewed_at.';


-- ---------------------------------------------------------------------------
-- RLS. Read for admin/AM (same gate as /pipeline). Writes admin-only on facts;
-- admin/AM may curate the two lookup tables.
-- ---------------------------------------------------------------------------
alter table comps.extract_run          enable row level security;
alter table comps.source_property      enable row level security;
alter table comps.source_document      enable row level security;
alter table comps.assumption_set       enable row level security;
alter table comps.assumption           enable row level security;
alter table comps.metric               enable row level security;
alter table comps.reimbursement_vocab  enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['extract_run','source_property','source_document',
                               'assumption_set','assumption','metric','reimbursement_vocab'])
  loop
    execute format('create policy %I on comps.%I for select to authenticated using (public.is_admin_or_am())', t||'_select', t);
  end loop;

  -- fact tables: admin-only writes (loaders use the service key and bypass RLS)
  for t in select unnest(array['extract_run','source_property','source_document',
                               'assumption_set','assumption'])
  loop
    execute format('create policy %I on comps.%I for insert to authenticated with check (public.is_admin())', t||'_insert', t);
    execute format('create policy %I on comps.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t||'_update', t);
    execute format('create policy %I on comps.%I for delete to authenticated using (public.is_admin())', t||'_delete', t);
  end loop;

  -- curated lookups: admin/AM may maintain the vocabulary and metric labels
  for t in select unnest(array['metric','reimbursement_vocab'])
  loop
    execute format('create policy %I on comps.%I for insert to authenticated with check (public.is_admin_or_am())', t||'_insert', t);
    execute format('create policy %I on comps.%I for update to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am())', t||'_update', t);
    execute format('create policy %I on comps.%I for delete to authenticated using (public.is_admin_or_am())', t||'_delete', t);
  end loop;
end $$;

-- reviewing a quarantined set is an asset-manager action, not admin-only
create policy assumption_set_review_update on comps.assumption_set
  for update to authenticated
  using (public.is_admin_or_am()) with check (public.is_admin_or_am());

grant select on all tables in schema comps to authenticated;
grant insert, update, delete on comps.metric, comps.reimbursement_vocab, comps.assumption_set to authenticated;
grant insert, update, delete on comps.extract_run, comps.source_property, comps.source_document, comps.assumption to authenticated;

-- The loaders run on the service key. A NEW schema is not covered by the service_role
-- grants that exist on public, so without these the loader gets a bare permission
-- denied on its first insert.
grant all on all tables in schema comps to service_role;
grant all on all sequences in schema comps to service_role;
alter default privileges in schema comps grant all on tables to service_role;
alter default privileges in schema comps grant all on sequences to service_role;

-- anon has no business here (consistent with 20240098 / 20240120 lockdown posture)
revoke all on all tables in schema comps from anon;
alter default privileges in schema comps revoke all on tables from anon;

-- 20240139_comps_scope_resolution.sql
-- Resolve what each assumption column actually REFERS TO, so the corpus can be grouped
-- by tenant. Follow-on to 20240137. Purely additive; no data is deleted.
--
-- Two problems the loaded data exposed, both measured on the real 36,367 rows:
--
--   1. scope_kind='tenant' IS OVER-ASSIGNED. 1,583 distinct labels are marked 'tenant',
--      but the high-frequency ones are not tenants at all: 'Storage' (82 sets), 'Anchors'
--      (46), 'Restaurants' (21), 'Jr. Anchors' (14), plus floor descriptors ('Lower Level',
--      'Full Floor', 'Floors 2 - 4', 'High Rise (29-39)'), size buckets ('<10K SF'),
--      lease-term labels ('5 Year Lease'), and parse noise ('Total Assessed Value (29%)',
--      '10440000'). Grouping by tenant is meaningless until these are separated, so
--      comps.scope_label_map becomes the curation surface -- the same pattern as
--      comps.reimbursement_vocab: a TABLE, not a regex buried in a script.
--
--   2. TRUST TIER IS PER-COLUMN, NOT PER-TAB -- and 20240137 got this wrong. The CF Model
--      template puts a "Brokers Underwriting" column NEXT TO M&J's own columns on the same
--      tab, so ~53 cells across ~14 sets are currently stamped trust_tier='internal' when
--      they are the broker's numbers. That is exactly the blend the schema was built to
--      prevent. comps.assumption gains its own nullable trust_tier which OVERRIDES the
--      set's, and comps.v_assumption now reports the coalesced effective tier.
--
-- Only 28 of the 1,583 labels match public.tenants -- expected, because that table is the
-- OWNED-portfolio master (110 rows) while this corpus is nationwide acquisition targets.
-- Those 28 are the valuable ones: they are the join that lets an assumption be compared
-- with what the tenant actually pays us.

-- ---------------------------------------------------------------------------
-- 1. richer scope kinds
-- ---------------------------------------------------------------------------
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'comps.assumption'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%scope_kind%';
  if cname is not null then
    execute format('alter table comps.assumption drop constraint %I', cname);
  end if;
end $$;

alter table comps.assumption
  add constraint assumption_scope_kind_check check (scope_kind in (
    'tenant',          -- a named retailer/occupier
    'space_category',  -- anchor / jr anchor / small shop / restaurant / storage / pad ...
    'suite',           -- an identified suite or unit
    'floor_area',      -- 'Lower Level', 'Floors 2-4', 'High Rise (29-39)', '<10K SF'
    'lease_term',      -- '5 Year Lease', 'MLA', 'New Lease' -- a term, not a space
    'scenario',        -- "Brokers Underwriting" and friends: a trust tier, not a space
    'property',        -- the property-level globals
    'unknown'
  ));

-- ---------------------------------------------------------------------------
-- 2. per-column trust tier (overrides the set's)
-- ---------------------------------------------------------------------------
alter table comps.assumption
  add column if not exists trust_tier text
    check (trust_tier in ('internal','broker','seller','unknown'));

comment on column comps.assumption.trust_tier is
  'Per-COLUMN trust tier, overriding assumption_set.trust_tier when set. Required because the CF Model template places a "Brokers Underwriting" column on the same tab as M&J''s own columns -- tier varies within a single tab. NULL means "inherit the set".';

create index if not exists assumption_trust_tier_idx on comps.assumption (trust_tier) where trust_tier is not null;

-- ---------------------------------------------------------------------------
-- 3. the curation surface
-- ---------------------------------------------------------------------------
create table if not exists comps.scope_label_map (
  label_key        text primary key,          -- lower(), non-alphanumerics collapsed to one space, trimmed
  display_name     text not null,             -- the tidiest spelling seen
  scope_kind       text not null check (scope_kind in
                     ('tenant','space_category','suite','floor_area','lease_term','scenario','property','unknown')),
  trust_tier       text check (trust_tier in ('internal','broker','seller','unknown')),
  public_tenant_id uuid references public.tenants(id) on delete set null,
  match_method     text check (match_method in ('exact_tenant','alias_tenant','curated','regex','unmatched')),
  is_curated       boolean not null default false,   -- true = a human decided; never overwrite these
  n_sets           int,
  n_cells          int,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table comps.scope_label_map is
  'One row per distinct assumption column label in the corpus, and what it resolves to. Regenerable by the resolver, EXCEPT rows with is_curated=true which a human owns. Same curation-in-a-table pattern as comps.reimbursement_vocab.';

create index if not exists scope_label_map_kind_idx   on comps.scope_label_map (scope_kind);
create index if not exists scope_label_map_tenant_idx on comps.scope_label_map (public_tenant_id) where public_tenant_id is not null;

alter table comps.scope_label_map enable row level security;
create policy scope_label_map_select on comps.scope_label_map for select to authenticated using (public.is_admin_or_am());
create policy scope_label_map_insert on comps.scope_label_map for insert to authenticated with check (public.is_admin_or_am());
create policy scope_label_map_update on comps.scope_label_map for update to authenticated using (public.is_admin_or_am()) with check (public.is_admin_or_am());
create policy scope_label_map_delete on comps.scope_label_map for delete to authenticated using (public.is_admin_or_am());
grant select, insert, update, delete on comps.scope_label_map to authenticated;
grant all on comps.scope_label_map to service_role;
revoke all on comps.scope_label_map from anon;

-- ---------------------------------------------------------------------------
-- 4. views: effective trust tier + resolved tenant
--    Existing columns keep their name, type and position so CREATE OR REPLACE is legal;
--    everything new is appended.
-- ---------------------------------------------------------------------------
create or replace view comps.v_assumption with (security_invoker = true) as
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
  coalesce(a.trust_tier, aset.trust_tier) as trust_tier,   -- effective: column overrides tab
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
  a.vocab_value,
  -- appended by 20240139
  aset.trust_tier         as set_trust_tier,
  t.name                  as tenant_name,
  slm.display_name        as scope_display_name,
  slm.match_method        as scope_match_method
from comps.assumption a
join comps.assumption_set aset on aset.id = a.assumption_set_id
join comps.source_document sd  on sd.id  = aset.source_document_id
join comps.source_property sp  on sp.id  = sd.source_property_id
join comps.metric m            on m.key  = a.metric
left join public.tenants t     on t.id   = a.tenant_id
left join comps.scope_label_map slm
       on slm.label_key = trim(lower(regexp_replace(coalesce(a.scope_label,''), '[^a-zA-Z0-9]+', ' ', 'g')))
where aset.is_quarantined = false;

comment on view comps.v_assumption is
  'The only view application code should read for comp values. Excludes quarantined sets. trust_tier is the EFFECTIVE tier (column overrides tab), so a broker column on an otherwise in-house tab reports as broker.';

-- tenant-grain convenience view: real named tenants only, resolved and dated
create or replace view comps.v_tenant_assumption with (security_invoker = true) as
select
  coalesce(v.tenant_name, v.scope_display_name, v.scope_label) as tenant,
  v.tenant_id,
  v.market,
  v.property,
  v.model_date,
  v.trust_tier,
  v.metric,
  v.unit,
  v.value_kind,
  v.num_value,
  v.num_new,
  v.num_renew,
  v.num_min,
  v.num_max,
  v.vocab_value,
  v.raw_value,
  v.document_id
from comps.v_assumption v
where v.scope_kind = 'tenant';

comment on view comps.v_tenant_assumption is
  'Tenant-grain slice for the "what do we assume for this retailer" question. Only scope_kind=tenant, so space categories, floor descriptors and broker columns are structurally excluded.';

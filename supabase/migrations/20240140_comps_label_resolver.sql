-- 20240140_comps_label_resolver.sql
-- The label resolver itself: two immutable functions plus the idempotent pass that fills
-- comps.scope_label_map and stamps comps.assumption. Safe to re-run -- create-or-replace
-- functions, an upsert that never overwrites a human-curated row, and an UPDATE whose
-- WHERE clause skips rows already correct. Re-run it after any new extract.
--
-- Three normalization defects this fixes, each found by inspecting the real 36,367 rows
-- rather than by reasoning about them:
--
--   1. '<' AND '>' WERE BEING STRIPPED, so "<10K SF" and ">10K SF" -- opposite meanings --
--      collapsed onto the identical key "10k sf". norm_label now maps them to lt/gt first.
--   2. ACCENTS BROKE MATCHING: "Cafe" and "Café" produced different keys, so 18 sets of
--      Café landed in 'tenant'. norm_label folds Latin-1 accents.
--   3. THE SPACE-NOUN TEST ONLY EVER MATCHED SINGLE-TOKEN LABELS. The repetition quantifier
--      was applied to the separator, '(tok)( |$)+$', instead of to the whole token group,
--      '((tok)( |$))+$'. "Inline Shops" (46 sets), "Medical office" and "Data Center" were
--      all scored as tenants. Similarly 'floors? ' required a TRAILING space, so
--      "Partial Floor" was a tenant; it is now a word-boundary match.
--
-- The space-category test deliberately requires EVERY token of the phrase to be a space
-- noun or a qualifier. That is what separates "Office MLA" and "Medical office" (categories)
-- from "Office Depot" and "Bank of America" (tenants) without a hand-maintained brand list.

create or replace function comps.norm_label(s text) returns text
language sql immutable as $$
  select trim(lower(regexp_replace(
    translate(replace(replace(coalesce(s,''),'<',' lt '),'>',' gt '),
              'áàâäãéèêëíìîïóòôöõúùûüçñÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑ',
              'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'),
    '[^a-zA-Z0-9]+',' ','g')));
$$;
comment on function comps.norm_label is
  'Normalized key for an assumption column label. Folds accents (Cafe/Cafe) and preserves < and > as lt/gt -- stripping them collapsed "<10K SF" and ">10K SF", opposite meanings, onto one key.';

create or replace function comps.classify_label(s text) returns text
language sql immutable as $$
  with n as (select comps.norm_label(s) k)
  select case
    when (select k from n) = 'property' then 'property'
    when (select k from n) ~ 'broker' then 'scenario'
    when (select k from n) ~ '^col[0-9]+$' or (select k from n) ~ '^[0-9]+$'
      or (select k from n) ~ 'total assessed|assessed value|subtotal|weighted|blended average'
      or length((select k from n)) > 55 then 'unknown'
    when (select k from n) ~ '^[0-9]+ ?(yr|year)( lease)?$|^(mla|market lease)$|^new lease$|^renewal$' then 'lease_term'
    when (select k from n) ~ '\mfloors?\M|lower level|high rise|mid rise|low rise|penthouse|concourse|basement|mezzanine|^ll |rooftop'
      or (select k from n) ~ '^(lt|gt) [0-9,]+ ?k? ?sf|(lt|gt) [0-9,]+ ?k? ?sf$' then 'floor_area'
    when (select k from n) ~ '^(suite|ste|unit) ' then 'suite'
    when (select k from n) ~ ('^((' ||
        '(inline|shops?|anchors?|jr|junior|majors?|small|large|mini|restaurants?|caf|cafe|food|court|deli|' ||
        'grocer|grocery|outparcels?|pads?|endcap|end|cap|bank|convenience|store|storage|office|retail|' ||
        'industrial|warehouse|flex|medical|med|lab|data|center|centre|roof|license|atm|kiosk|theater|theatre|' ||
        'cinema|fitness|gym|salon|qsr|quick|service|drive|thru|vacant|spec|speculative|second|generation|' ||
        'mall|common|area|parking|antenna|billboard|signage|construction|space|freestanding|corners?|strip|' ||
        'storefront|patio|seasonal|temporary|temp|kiosks)' ||
        '|(new|renewal|[0-9]+|k|sf|psf|yr|year|lt|gt|i|ii|iii|iv|v|mla|partial|only|and|the|per)' ||
      ')( |$))+$') then 'space_category'
    else 'tenant'
  end;
$$;
comment on function comps.classify_label is
  'Deterministic scope_kind for a column label. Order matters: scenario, junk, lease-term and floor/size descriptors are all decided BEFORE the space-noun vocabulary, which itself requires the whole phrase to be space nouns plus qualifiers.';

-- ---------------------------------------------------------------------------
-- resolver pass (idempotent)
-- ---------------------------------------------------------------------------
with lbl as (
  select comps.norm_label(scope_label) k,
         (array_agg(scope_label order by length(scope_label), scope_label))[1] disp,
         count(distinct assumption_set_id) n_sets, count(*) n_cells
  from comps.assumption
  where scope_label is not null and scope_label <> ''
  group by 1
),
cls as (select k, disp, n_sets, n_cells, comps.classify_label(disp) sk from lbl),
tn as (
  select id, comps.norm_label(name) k from public.tenants where name is not null
  union select id, comps.norm_label(trade_name) from public.tenants where trade_name is not null
  union select t.id, comps.norm_label(a) from public.tenants t, unnest(t.file_aliases) a
),
-- an AMBIGUOUS match links to nothing. Same discipline as the deal-folder linker: two
-- candidates means we do not know, and guessing is how the Village at Allen mis-link happened.
tmatch as (
  select c.k, (array_agg(distinct tn.id))[1] tid, count(distinct tn.id) nmatch
  from cls c join tn on tn.k = c.k and tn.k <> ''
  where c.sk = 'tenant'
  group by c.k
)
insert into comps.scope_label_map
  (label_key, display_name, scope_kind, trust_tier, public_tenant_id, match_method, n_sets, n_cells, updated_at)
select c.k, c.disp, c.sk,
       case when c.sk = 'scenario' then 'broker' else null end,
       case when tm.nmatch = 1 then tm.tid else null end,
       case when tm.nmatch = 1 then 'exact_tenant'
            when c.sk = 'tenant' then 'unmatched' else 'regex' end,
       c.n_sets, c.n_cells, now()
from cls c left join tmatch tm on tm.k = c.k
on conflict (label_key) do update set
  display_name     = excluded.display_name,
  scope_kind       = case when comps.scope_label_map.is_curated then comps.scope_label_map.scope_kind       else excluded.scope_kind end,
  trust_tier       = case when comps.scope_label_map.is_curated then comps.scope_label_map.trust_tier       else excluded.trust_tier end,
  public_tenant_id = case when comps.scope_label_map.is_curated then comps.scope_label_map.public_tenant_id else excluded.public_tenant_id end,
  match_method     = excluded.match_method,
  n_sets           = excluded.n_sets,
  n_cells          = excluded.n_cells,
  updated_at       = now();

update comps.assumption a
set scope_kind = m.scope_kind,
    tenant_id  = m.public_tenant_id,
    trust_tier = m.trust_tier
from comps.scope_label_map m
where m.label_key = comps.norm_label(a.scope_label)
  and (a.scope_kind is distinct from m.scope_kind
    or a.tenant_id  is distinct from m.public_tenant_id
    or a.trust_tier is distinct from m.trust_tier);

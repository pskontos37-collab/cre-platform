-- 20240147_comps_classifier_leaks.sql
-- The lookup panel's tenant list still showed non-tenants (Office (10yr), <10k Space,
-- Inline (5-10k SF), 7 Year Deal, $50 NNN - PH. 2). Root causes, all in classify_label:
--
--   1. THE QUALIFIER ALTERNATION HAD `[0-9]+` AND `k`/`sf`/`yr` AS SEPARATE TOKENS, but the
--      normalizer emits SINGLE tokens like `10k`, `2k`, `5ksf`, `10yr`. So every size-bucketed
--      space category ("Inline (5-10k SF)", "Shops 2k - 6k SF", "Office <5k") failed the
--      whole-phrase test and fell through to tenant. This was the dominant cause.
--   2. `\mfloors?\M` missed the abbreviations the firm actually uses: flrs, LR/MR/HR
--      (low/mid/high rise), upper/lower, high/low.
--   3. The lease-term test anchored at `$`, so "7 Year Deal" / "5 yr. deal" / "10 years" and
--      "MLA 2" were not lease terms.
--   4. Labels that LEAD WITH A RENT VALUE ("$50 NNN - PH. 2", "$14/SF") are a rent column, not
--      a scope. They now classify `unknown` rather than polluting the tenant list. raw_value is
--      preserved either way, so nothing is lost.
--
-- TWO PRECEDENCE RULES that the read-only diff proved necessary (each fixed a regression I
-- introduced while fixing the above):
--   A. space_category requires AT LEAST ONE ACTUAL NOUN. Without it, a pure-size phrase like
--      "<10k SF" matched the vocabulary (every token being a qualifier) and stopped being a
--      size bucket.
--   B. A size bucket is only floor_area when the phrase has NO space noun. "Shops > 2,500 sf"
--      keeps its space_category -- an analyst looking for shops comps should find it there --
--      while ">10,000 SF" alone is floor_area.
--
-- DELIBERATE RECLASSIFICATION, not a leak fix: 39 labels / 860 cells move floor_area ->
-- space_category ("Office<10k-sf", "Inline < 10K SF"). A noun plus a size cut belongs with the
-- space types; Floor/size is for pure floor and size descriptors.
--
-- MEASURED, verified as a real authenticated user after applying:
--   tenant       14,313 -> 11,915 cells      space_category 10,795 -> 11,908
--   floor_area    5,861 ->  5,939            unknown           676 ->  1,694
--   lease_term      311 ->    500            v_assumption   30,664 -> 30,664 (nothing lost)
-- Tenant list top 12 is now entirely real retailers: Whole Foods, PetSmart, Starbuck's,
-- Best Buy, LA Fitness, Chipotle, Burlington Coat Factory, Dollar Tree, Old Navy, Ulta,
-- Bed Bath & Beyond, Dick's Sporting Goods.
--
-- KNOWN RESIDUAL (~19 labels / 169 cells, deliberately not chased): genuinely ambiguous label
-- text such as "RS V <15K SF" (phase code), "G&S Signs <5k sf" and "Mike & Tony's Gyro ... <5k
-- sf" (real tenants carrying a size). More vocabulary here would be over-fitting; raw_value is
-- kept and the analyst sees the label.

create or replace function comps.classify_label(s text) returns text
language sql immutable as $fn$
  with n as (select comps.norm_label(s) k),
  v as (select
    -- tokens that do not identify a scope on their own. NOTE the combined numeric+unit form:
    -- the normalizer emits `10k` / `5ksf` / `10yr` as SINGLE tokens.
    '(new|renewal|[0-9]+(\.[0-9]+)?k?m?(sf|psf)?|k|sf|psf|yr|yrs|year|years|mo|mos|month|months|lt|gt|over|under|in|and|the|per|only|partial|mla|term|deal|midsize|i|ii|iii|iv|v)' as qual,
    '(inline|line|shops?|anchors?|jr|junior|majors?|small|large|mini|restaurants?|caf|cafe|food|court|deli|grocer|grocery|outparcels?|pads?|endcap|end|cap|bank|convenience|store|storage|office|retail|industrial|warehouse|flex|medical|med|lab|data|center|centre|roof|license|atm|kiosk|theater|theatre|cinema|fitness|gym|salon|qsr|quick|service|drive|thru|vacant|spec|speculative|second|generation|mall|common|area|parking|antenna|billboard|signage|construction|space|freestanding|corners?|strip|storefront|patio|seasonal|temporary|temp|block|tenants)' as noun)
  select case
    when (select k from n) = 'property' then 'property'
    when (select k from n) ~ 'broker' then 'scenario'
    -- a label leading with a rent value is a rent column, not a scope
    when s ~ '^\s*\$' then 'unknown'
    when (select k from n) ~ '^col[0-9]+$'
      or (select k from n) ~ '^[0-9]+( [0-9]+)*$'
      or (select k from n) ~ 'total assessed|assessed value|subtotal|weighted|blended average'
      or length((select k from n)) > 55 then 'unknown'
    when (select k from n) ~ '^[0-9]+ ?(yr|yrs|year|years)( (lease|deal|term))?$'
      or (select k from n) ~ '^(mla|market lease)( ?[0-9]+)?$|^new lease$|^renewal$' then 'lease_term'
    -- explicit floor references, including the abbreviations in use: flrs, LR/MR/HR, upper/lower
    when (select k from n) ~ '\m(floors?|flrs?|upper|lower|high|low|lr|mr|hr)\M|high rise|mid rise|low rise|penthouse|concourse|basement|mezzanine|^ll |rooftop' then 'floor_area'
    when (select k from n) ~ '^(suite|ste|unit) ' then 'suite'
    -- whole phrase is nouns + qualifiers AND contains at least one real noun (rule A)
    when (select k from n) ~ ('^((' || (select noun from v) || '|' || (select qual from v) || ')( |$))+$')
      and (select k from n) ~ ('\m' || (select noun from v) || '\M') then 'space_category'
    -- pure size/qualifier phrase with a size marker -> a size bucket (rule B)
    when (select k from n) ~ ('^((' || (select qual from v) || ')( |$))+$')
      and (select k from n) ~ '\m(sf|psf|k|lt|gt|over|under)\M' then 'floor_area'
    else 'tenant'
  end;
$fn$;
comment on function comps.classify_label is
  'Deterministic scope_kind for a column label. Precedence: property, scenario, rent-value labels, junk, lease term, explicit floor refs, suite, space category (needs >=1 noun), pure size bucket, else tenant. The qualifier list must carry COMBINED numeric+unit tokens (10k, 5ksf, 10yr) because comps.norm_label emits those as single tokens -- that omission was what put every size-bucketed space category into the tenant list.';

-- re-run the idempotent resolver so the map and the fact rows pick up the new rules
with lbl as (
  select comps.norm_label(scope_label) k,
         (array_agg(scope_label order by length(scope_label), scope_label))[1] disp,
         count(distinct assumption_set_id) n_sets, count(*) n_cells
  from comps.assumption where scope_label is not null and scope_label <> '' group by 1
),
cls as (select k, disp, n_sets, n_cells, comps.classify_label(disp) sk from lbl),
tn as (
  select id, comps.norm_label(name) k from public.tenants where name is not null
  union select id, comps.norm_label(trade_name) from public.tenants where trade_name is not null
  union select t.id, comps.norm_label(a) from public.tenants t, unnest(t.file_aliases) a
),
tmatch as (
  select c.k, (array_agg(distinct tn.id))[1] tid, count(distinct tn.id) nmatch
  from cls c join tn on tn.k = c.k and tn.k <> '' where c.sk='tenant' group by c.k
)
insert into comps.scope_label_map (label_key, display_name, scope_kind, trust_tier, public_tenant_id, match_method, n_sets, n_cells, updated_at)
select c.k, c.disp, c.sk,
       case when c.sk='scenario' then 'broker' else null end,
       case when tm.nmatch=1 then tm.tid else null end,
       case when tm.nmatch=1 then 'exact_tenant' when c.sk='tenant' then 'unmatched' else 'regex' end,
       c.n_sets, c.n_cells, now()
from cls c left join tmatch tm on tm.k=c.k
on conflict (label_key) do update set
  display_name = excluded.display_name,
  scope_kind   = case when comps.scope_label_map.is_curated then comps.scope_label_map.scope_kind else excluded.scope_kind end,
  trust_tier   = case when comps.scope_label_map.is_curated then comps.scope_label_map.trust_tier else excluded.trust_tier end,
  public_tenant_id = case when comps.scope_label_map.is_curated then comps.scope_label_map.public_tenant_id else excluded.public_tenant_id end,
  match_method = excluded.match_method, n_sets = excluded.n_sets, n_cells = excluded.n_cells, updated_at = now();

update comps.assumption a
set scope_kind = m.scope_kind, tenant_id = m.public_tenant_id, trust_tier = m.trust_tier
from comps.scope_label_map m
where m.label_key = comps.norm_label(a.scope_label)
  and (a.scope_kind is distinct from m.scope_kind
    or a.tenant_id is distinct from m.public_tenant_id
    or a.trust_tier is distinct from m.trust_tier);

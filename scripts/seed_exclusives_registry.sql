-- seed_exclusives_registry.sql — one-time bootstrap of property_exclusives
-- (migration 20240112). Auto-seeds one registry row per tenant whose EFFECTIVE
-- exclusive (base abstract + human override) exists=true, plus the manual
-- Buy Buy Baby (vacated) entry that the J. Crew misattribution requires.
-- Idempotency: re-running will INSERT duplicates — truncate the auto-seeded rows
-- first if re-seeding (delete where notes like 'Auto-seeded%').

insert into public.property_exclusives (property_id, owner_tenant, description, category, keywords, source_citation, active, notes)
select la.property_id,
       la.tenant_name,
       left(coalesce(la.overrides->>'exclusives.exact_language', la.abstract->'exclusives'->>'exact_language', ''), 500),
       'auto-seeded',
       array[lower(la.tenant_name)],
       coalesce(la.overrides->>'exclusives.section', la.abstract->'exclusives'->>'section'),
       true,
       'Auto-seeded from lease_abstracts (effective exclusives.exists=true). Curate as needed.'
from public.lease_abstracts la
where coalesce((la.overrides->>'exclusives.exists')::boolean, (la.abstract->'exclusives'->>'exists')::boolean, false) = true;

insert into public.property_exclusives (property_id, owner_tenant, category, description, keywords, source_citation, active, notes)
select distinct la.property_id, 'Buy Buy Baby', 'infant & children''s products',
       'Exclusive for infant/children furniture, clothing and products (ages 0-4); also a bath & linen restriction.',
       array['buy buy baby','bath and linen','infant','children','baby furniture'],
       'Existing-Exclusives exhibit referenced in co-located leases (e.g. J. Crew Rider 1)',
       false,
       'Vacated tenant. Kept active=false as ground truth so its exclusive is never misattributed to another tenant (user-flagged J. Crew error).'
from public.lease_abstracts la where la.tenant_name = 'J. Crew';

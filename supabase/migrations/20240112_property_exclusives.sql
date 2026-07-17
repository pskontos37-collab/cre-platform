-- 20240112_property_exclusives.sql
-- #3 of the abstraction accuracy work: a per-property EXCLUSIVES-OWNERSHIP
-- REGISTRY — durable, human-curated ground truth for WHO holds which exclusive
-- at each property. It exists to kill, deterministically, the recurring class of
-- error where a model attributes ANOTHER tenant's exclusive to the wrong tenant
-- (e.g. filing Buy Buy Baby's infant-products exclusive under J. Crew). The
-- abstract-ensemble guard consults this: a proposed exclusive for tenant X that
-- names/keyword-matches an entry owned by tenant Y != X, or cites an "Existing
-- Exclusives" exhibit, is rejected rather than flagged. Encode the fact ONCE
-- (including for vacated tenants), and no component re-derives it wrong.

create table if not exists public.property_exclusives (
  id            uuid primary key default uuid_generate_v4(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  owner_tenant  text not null,                       -- tenant that HOLDS the exclusive (may be vacated)
  category      text,                                -- short use-category, e.g. "infant & children's products"
  description   text,                                -- the exclusive's substance / verbatim if known
  keywords      text[] not null default '{}',        -- lowercased match tokens (owner aliases + protected-use terms)
  source_citation text,                              -- where the exclusive is documented
  active        boolean not null default true,       -- false = historical/vacated (STILL used to reject misattribution)
  notes         text,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists property_exclusives_property_idx on public.property_exclusives (property_id);

alter table public.property_exclusives enable row level security;

-- Same posture as the abstracts surface: admin / asset-manager only.
create policy "prex_select" on public.property_exclusives for select using (public.is_admin_or_am());
create policy "prex_insert" on public.property_exclusives for insert with check (public.is_admin_or_am());
create policy "prex_update" on public.property_exclusives for update using (public.is_admin_or_am());
create policy "prex_delete" on public.property_exclusives for delete using (public.is_admin_or_am());

grant select, insert, update, delete on public.property_exclusives to authenticated;

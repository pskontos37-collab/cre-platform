-- ============================================================
-- Portfolios: capital-PARTNER grouping + one-level hierarchy
-- Migration 20240060
--
-- The three existing portfolio rows were really JV *vehicles* (Gateway,
-- Magnolia, Knightdale). This recasts them into capital-PARTNER portfolios,
-- adds the remaining partners, and introduces a parent/child hierarchy so
-- that MetLife/URS nests under MetLife:
--
--   * Filtering / scoping MetLife rolls UP to include every MetLife/URS asset.
--   * The reverse does NOT hold (MetLife-direct assets are not in MetLife/URS).
--
-- Existing row ids are preserved so the properties.portfolio_id FK stays intact.
-- No live entitlement uses the `portfolio` scope today, so the RLS changes below
-- are forward-looking correctness rather than a data migration.
-- ============================================================

-- 1) Hierarchy column ---------------------------------------------------------
alter table portfolios
  add column if not exists parent_id uuid references portfolios(id) on delete set null;

-- 2) Recast the three existing rows (ids preserved) ---------------------------
--      001  BBK Knightdale LLC  ->  Bailard        (top level)
--      003  Magnolia JV         ->  MetLife        (top level)
--      002  Gateway JV          ->  MetLife/URS    (child of MetLife 003)
update portfolios set
  name        = 'Bailard',
  description = 'Bailard (BBK) JV. Knightdale Marketplace — KM East, KM West, Consolidated.',
  parent_id   = null
where id = '00000000-0000-0000-0000-000000000001';

update portfolios set
  name        = 'MetLife',
  description = 'MetLife-affiliated assets. Top level; rolls up the MetLife/URS sub-portfolio.',
  parent_id   = null
where id = '00000000-0000-0000-0000-000000000003';

update portfolios set
  name        = 'MetLife/URS',
  description = 'MetLife/URS JV. Nested under MetLife — its assets roll up into MetLife.',
  parent_id   = '00000000-0000-0000-0000-000000000003'
where id = '00000000-0000-0000-0000-000000000002';

-- 3) Add the remaining top-level partner portfolios ---------------------------
insert into portfolios (id, name, description, parent_id) values
  ('00000000-0000-0000-0000-0000000000a4', 'DRA',                  'DRA JV.',                        null),
  ('00000000-0000-0000-0000-0000000000a5', 'BIG Shopping Centers', 'BIG Shopping Centers JV.',       null),
  ('00000000-0000-0000-0000-0000000000a6', 'Alto',                 'Alto JV.',                       null),
  ('00000000-0000-0000-0000-0000000000a7', 'Bixby',                'Bixby JV.',                      null),
  ('00000000-0000-0000-0000-0000000000a8', 'Intercontinental',     'Intercontinental JV.',           null),
  ('00000000-0000-0000-0000-0000000000a9', 'Affinius',             'Affinius JV.',                   null),
  ('00000000-0000-0000-0000-0000000000af', 'Other',                'Unassigned — partner TBD.',      null)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  parent_id   = excluded.parent_id;

-- 4) Attach each property to its partner portfolio ----------------------------
--    (KM East/West/Consolidated already point at 001/Bailard; Gateway at 002;
--     Magnolia at 003 — restated here for idempotency.)

-- MetLife (direct)
update properties set portfolio_id = '00000000-0000-0000-0000-000000000003' where id in (
  'd4f08824-2d88-472d-b7aa-a703310c2aaf',  -- Magnolia Park Shopping Center
  '7fc45bb1-1917-4619-9415-8ca666e4653f'   -- Chapel Hills East
);

-- MetLife/URS (child of MetLife)
update properties set portfolio_id = '00000000-0000-0000-0000-000000000002' where id in (
  'd5a4ed03-0b60-4168-9208-83822dd24884',  -- Gateway Port Chester
  '2397a619-31d5-4322-a1a6-7fc7c8000498',  -- Southlands Town Center Office
  'ac1c355f-ae29-4981-9f65-3aa33739613d',  -- Southlands Town Center Retail
  '63036a6e-406a-4016-a8f8-cf9d73e073ea'   -- Town Center of Mililani
);

-- Bailard
update properties set portfolio_id = '00000000-0000-0000-0000-000000000001' where id in (
  '00000000-0000-0000-0000-000000000010',  -- KM East
  '00000000-0000-0000-0000-000000000011',  -- KM West
  '00000000-0000-0000-0000-000000000012'   -- KM Consolidated
);

-- DRA
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a4' where id in (
  '4dd56eb8-d2f6-48f5-a09e-00585c329b5d',  -- Cherry Creek Corporate Center
  '87c85b3a-2704-4114-b7b0-ce65a2e971e0'   -- One East Erie
);

-- BIG Shopping Centers
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a5' where id =
  'cb1fd6c0-159f-42ed-b677-85b776c0d98b';  -- The Waterfront

-- Alto
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a6' where id =
  '9d25ff35-ab62-4b6a-9e76-c0306a95b142';  -- Miracle Mile Shopping Center

-- Bixby
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a7' where id =
  'a5407d2f-b12d-4922-9cc0-41dde8044ec9';  -- Outlets of Maui

-- Intercontinental
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a8' where id =
  '8c73d962-5271-4202-bb05-0ec7dc9b358d';  -- Parker Ranch Center

-- Affinius
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000a9' where id =
  '3c66605b-f947-45a8-aa27-4d95ae3c554d';  -- East Gate Square

-- Other (partner TBD)
update properties set portfolio_id = '00000000-0000-0000-0000-0000000000af' where id in (
  'b4de870b-ef45-4d97-803b-03fdfa81e15e',  -- Bank Financial Building
  'e7d9a97e-668c-4a50-a966-92ce919f1f95',  -- Meridian Plaza
  '7edf27f6-f268-4376-93e1-4db67e053480',  -- Penn Center East Office
  'c16a3e02-d3b7-4e9f-95e3-e7158ef0d3ef'   -- Penn Center Retail
);

-- 5) Ancestry helper: a portfolio + every ancestor up the tree ----------------
--    Used so an entitlement / filter on a PARENT portfolio resolves to include
--    all descendant portfolios' assets.
create or replace function public.portfolio_ancestry(p_portfolio_id uuid)
returns setof uuid language sql stable
set search_path = public as $$
  with recursive up as (
    select id, parent_id from public.portfolios where id = p_portfolio_id
    union all
    select p.id, p.parent_id from public.portfolios p join up on p.id = up.parent_id
  )
  select id from up;
$$;

-- 6) Extend access checks to honor the hierarchy ------------------------------
--    A portfolio entitlement now grants a property when the entitlement targets
--    the property's portfolio OR any ANCESTOR of it. search_path pinned to match
--    the security-hardening baseline (migration 20240040).
create or replace function public.can_access_property(p_property_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select
    public.is_admin_or_am()
    or exists (
      select 1
      from public.entitlements e
      join public.users u on u.id = e.user_id
      where e.user_id = auth.uid()
        and u.is_active = true
        and e.can_read = true
        and (
          e.scope = 'global'
          or (e.scope = 'property'   and e.property_id = p_property_id)
          or (e.scope = 'portfolio'  and e.portfolio_id in (
                select public.portfolio_ancestry(
                  (select portfolio_id from public.properties where id = p_property_id))
              ))
        )
    );
$$;

-- Portfolios visibility: see a portfolio row if entitled to it or any ancestor.
drop policy if exists "portfolios_select" on portfolios;
create policy "portfolios_select" on portfolios for select using (
  public.is_admin_or_am()
  or exists (
    select 1 from public.entitlements e
    where e.user_id = auth.uid() and e.can_read = true
      and (
        e.scope = 'global'
        or (e.scope = 'portfolio' and e.portfolio_id in (
              select public.portfolio_ancestry(portfolios.id)
            ))
      )
  )
);

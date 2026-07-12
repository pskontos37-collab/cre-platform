-- 20240067_deal_team_members.sql
-- Canonical acquisitions team roster (initials <-> full name) so deals pick
-- people BY NAME, plus a structured Acquisition Lead and Assigned Analyst on
-- each deal. The free-text pipeline_deals.team[] (initials) stays for the broader
-- team tag list; the roster is what the pickers read.

create table if not exists public.deal_team_members (
  id uuid primary key default uuid_generate_v4(),
  initials text not null unique,
  full_name text not null,
  title text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.deal_team_members (initials, full_name, sort_order)
select * from (values
  ('GW', 'Gregg Wilkow', 1),
  ('MS', 'Marty Sweeney', 2),
  ('JW', 'John Wiechart', 3),
  ('LJ', 'Luke Jackson', 4),
  ('MR', 'Matt Rodgers', 5),
  ('PS', 'Peter Skontos', 6),
  -- 2026-07-11: Georgi Solar replaced Brock (departed; his row was set active=false
  -- in the live DB rather than deleted, preserving any historical references).
  ('GS', 'Georgi Solar', 7),
  ('DR', 'Darcy Rutzen', 8)
) as v(initials, full_name, sort_order)
where not exists (select 1 from public.deal_team_members);

alter table public.pipeline_deals
  add column if not exists lead_member_id    uuid references public.deal_team_members(id) on delete set null,
  add column if not exists analyst_member_id uuid references public.deal_team_members(id) on delete set null;

-- Roster is non-sensitive names, but only the pipeline (admin/AM) uses it.
alter table public.deal_team_members enable row level security;
create policy "deal_team_members_select" on public.deal_team_members
  for select using (public.is_admin_or_am());
create policy "deal_team_members_write" on public.deal_team_members
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.deal_team_members to authenticated;

notify pgrst, 'reload schema';

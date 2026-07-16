-- Auto-sync capital_flows from GL distribution accounts. The property GL is
-- the source of record for owner distributions (user 2026-07-16); this keeps
-- the /investors ledger and waterfall history current on every GL load with
-- no manual entry. Mappings validated against actuals before seeding:
-- Magnolia 3051-00 matched 2024 flows 10/10; BBC Knightdale entity GL 3051-00
-- tied to the full 2019-2025 flow history; Gateway 302100 confirmed via the
-- 6/4/2025 State Street thread.
-- NOTE: the exclusion regex in sync_capital_flows_from_gl is superseded by
-- 20240100_gl_sync_regex_fix (first live run caught a year-open rebook).

create table public.capital_flow_gl_map (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.deals(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  account_code text not null,
  party text not null,
  role text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (property_id, account_code)
);
alter table public.capital_flow_gl_map enable row level security;
create policy cfgm_read on public.capital_flow_gl_map for select to authenticated using (is_admin_or_am());
create policy cfgm_admin on public.capital_flow_gl_map for all to authenticated using (is_admin()) with check (is_admin());

-- Guards, learned from the reconciliation:
--  - only entries NEWER than the party's last recorded flow (historical noise
--    like accrual/reversal pairs and true-ups stays untouched);
--  - skip opening-balance rebooks, accruals, reclasses, reserve releases;
--  - net debit-credit per entry; ignore net movements under $1,000 (bank noise
--    like the $900 Gateway wire);
--  - idempotent: exact (deal, party, date, amount) rows are never re-inserted.
create or replace function public.sync_capital_flows_from_gl()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  insert into public.capital_flows (deal_id, party, role, flow_date, amount, source, notes)
  select m.deal_id, m.party, m.role, g.entry_date, (g.debit - g.credit),
         'gl-auto-sync ' || m.account_code,
         left(coalesce(g.description, ''), 200)
  from public.capital_flow_gl_map m
  join public.gl_entries g
    on g.property_id = m.property_id and g.account_code = m.account_code
  where g.entry_date > coalesce((
          select max(cf.flow_date) from public.capital_flows cf
          where cf.deal_id = m.deal_id and cf.party = m.party), '1900-01-01')
    and abs(g.debit - g.credit) >= 1000
    and coalesce(g.description, '') !~* 'opening balance|accrual|reclass|true.?up|reserve'
    and not exists (
      select 1 from public.capital_flows cf2
      where cf2.deal_id = m.deal_id and cf2.party = m.party
        and cf2.flow_date = g.entry_date and cf2.amount = (g.debit - g.credit));
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.sync_capital_flows_from_gl() from public, anon;
grant execute on function public.sync_capital_flows_from_gl() to authenticated, service_role;

-- Seed the validated mappings. The Knightdale row points at the Consolidated
-- property: inert until BBC Knightdale entity-GL exports are loaded there.
insert into public.capital_flow_gl_map (deal_id, property_id, account_code, party, role, note)
select d.id, v.property_id::uuid, v.account_code, v.party, v.role, v.note
from (values
  ('Magnolia%Layer 1%', 'd4f08824-2d88-472d-b7aa-a703310c2aaf', '3051-00', 'MetLife', 'lp',
   'Other Owners #1 Distributions - validated 10/10 vs 2024 flows'),
  ('Gateway%Layer 1%', 'd5a4ed03-0b60-4168-9208-83822dd24884', '302100', 'MetLife / URS', 'lp',
   'Distributions-Capital #1 - Apr 2025 wire confirmed via State Street thread'),
  ('Knightdale%Layer 1%', '00000000-0000-0000-0000-000000000012', '3051-00', 'Bailard (BBK)', 'lp',
   'BBC Knightdale entity GL - load entity exports under KM Consolidated to activate')
) as v(deal_pattern, property_id, account_code, party, role, note)
join deals d on d.name like v.deal_pattern;

-- Nightly, after any GL load lands.
select cron.schedule('sync-capital-flows-from-gl', '25 6 * * *',
                     'select public.sync_capital_flows_from_gl()');

-- First live run of sync_capital_flows_from_gl caught "Open Year (Prior Yr
-- Adj 12/25)." — a year-open rebook, not cash. Widen the exclusion filter.
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
    and coalesce(g.description, '') !~* 'opening balance|open year|prior yr|prior year|accrual|reclass|true.?up|reserve|balance forward'
    and not exists (
      select 1 from public.capital_flows cf2
      where cf2.deal_id = m.deal_id and cf2.party = m.party
        and cf2.flow_date = g.entry_date and cf2.amount = (g.debit - g.credit));
  get diagnostics n = row_count;
  return n;
end $$;

delete from public.capital_flows where source = 'gl-auto-sync 302100' and notes = 'Open Year (Prior Yr Adj 12/25).';

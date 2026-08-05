-- Fix v_gl_balance_sheet: MRI GENLEDG re-books each year's opening balance as a
-- regular January entry (verified on Gateway 218200: one $120M credit per year),
-- so each period_year is self-contained. Use the LATEST year only.
create or replace view public.v_gl_balance_sheet
with (security_invoker = true) as
with latest as (
  select property_id, max(period_year) as yr
  from gl_entries
  where account_code ~ '^[1-3]' and not is_balance_forward
  group by property_id
)
select g.property_id,
       g.account_code,
       g.account_name,
       sum(g.debit) - sum(g.credit) as balance,
       max(g.entry_date) as last_activity
from gl_entries g
join latest l on l.property_id = g.property_id and g.period_year = l.yr
where g.account_code ~ '^[1-3]' and not g.is_balance_forward
group by g.property_id, g.account_code, g.account_name;

grant select on public.v_gl_balance_sheet to authenticated;
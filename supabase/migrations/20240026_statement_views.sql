-- 20240026_statement_views.sql
-- User feedback pass 2026-07-03: vendors default to trailing-12-months, and the
-- Financials page grows an income statement (MTD/YTD/TTM) + balance sheet.

-- Trailing-12-month vendor spend (same shape as v_vendor_spend).
create or replace view public.v_vendor_spend_ttm
with (security_invoker = true) as
select i.property_id,
       i.vendor_id,
       v.name as vendor,
       count(distinct i.id) as invoice_count,
       sum(d.amount) as total_spend,
       min(i.posting_date) as first_invoice,
       max(i.posting_date) as last_invoice
from invoice_distributions d
join invoices i on i.id = d.invoice_id
left join vendors v on v.id = i.vendor_id
where i.posting_date >= (current_date - interval '12 months')
group by i.property_id, i.vendor_id, v.name;

grant select on public.v_vendor_spend_ttm to authenticated;

-- Balance sheet per GL: 1xxx (assets) / 2xxx (liabilities) / 3xxx (equity).
-- IMPORTANT (verified on Gateway's mortgage account 218200): the MRI GENLEDG
-- export re-books each year's OPENING BALANCE as a regular January entry, so
-- each period_year is self-contained. Summing all years multiplies balances by
-- the year count (~10x). Correct as-of balance = sum over the LATEST year only.
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

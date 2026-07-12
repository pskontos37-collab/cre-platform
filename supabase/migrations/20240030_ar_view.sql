-- 20240030_ar_view.sql
-- Net tenant A/R balance by month from the GL (latest self-contained year per
-- property — the MRI export re-books opening balances each January, see
-- 20240026). Includes receivable + allowance (contra) accounts; excludes
-- straight-line deferred rent and prior-owner receivables (not collectible
-- tenant A/R). Tenant-level AGING buckets require the MRI A/R aging export —
-- this view powers the dashboard A/R widget until that lands.

create or replace view public.v_gl_ar_monthly
with (security_invoker = true) as
with latest as (
  select property_id, max(period_year) as yr
  from gl_entries
  where account_code ~ '^1' and not is_balance_forward
  group by property_id
),
deltas as (
  select g.property_id,
         g.period_month,
         sum(g.debit - g.credit) as delta
  from gl_entries g
  join latest l on l.property_id = g.property_id and g.period_year = l.yr
  where not g.is_balance_forward
    and g.account_code ~ '^1'
    and g.account_name ~* '(receivab|recv|a/r)'
    and g.account_name !~* '(deferred|prior own)'
  group by g.property_id, g.period_month
)
select property_id,
       period_month,
       sum(delta) over (partition by property_id order by period_month) as ar_balance
from deltas;

grant select on public.v_gl_ar_monthly to authenticated;

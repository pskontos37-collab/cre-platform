-- ============================================================
-- property_nca(pid): net current assets from the property's
-- latest GL year, name-classified. Used by the sell-today
-- waterfall page as the default NCA (user can override).
--
-- Included: current assets (cash/operating/deposit/money-market
--   accounts, receivables + allowances, prepaids, escrows/reserves)
--   less current liabilities (payables, accruals, security deposits,
--   prepaid rent, other liabilities).
-- Excluded: straight-line/deferred rent (not collectible at sale),
--   mortgage/loan/note principal (belongs in the payoff input),
--   fixed assets, intangibles and their A/D-A/A.
-- ============================================================

create or replace function property_nca(pid uuid)
returns table (nca numeric, assets numeric, liabilities numeric, gl_year int)
language sql
stable
as $$
  with latest as (
    select max(period_year) as y from gl_entries where property_id = pid
  ),
  bal as (
    select e.account_code as code, max(e.account_name) as name,
           sum(coalesce(e.debit, 0) - coalesce(e.credit, 0)) as b
    from gl_entries e, latest
    where e.property_id = pid
      and e.period_year = latest.y
      and e.account_code ~ '^[12]'
    group by e.account_code
  ),
  cls as (
    select b,
      case
        when name ~* 'deferred rent|defer rent|straight' then null
        when name ~* '(mort\w*|loan|note).{0,10}pay' then null
        when code like '1%' and name ~* 'cash|operat|deposit|money market|receivab|a/r|recv|allow|prepaid|escrow|reserve' then 'A'
        when code like '2%' and name ~* 'payab|accrued|deposit|prepaid|liabilit' then 'L'
        else null
      end as k
    from bal
  )
  select coalesce(sum(b), 0)::numeric as nca,
         coalesce(sum(b) filter (where k = 'A'), 0)::numeric as assets,
         coalesce(sum(b) filter (where k = 'L'), 0)::numeric as liabilities,
         (select y from latest) as gl_year
  from cls
  where k is not null;
$$;

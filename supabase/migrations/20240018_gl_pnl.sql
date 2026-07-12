-- ============================================================
-- GL-derived P&L — per-entity NOI from the general ledger.
-- 4xxx = revenue, 5xxx = operating expense (NOI line), 6xxx/7xxx/9xxx +
-- 5221 (loan servicing) = below-the-line (interest, financing amort, legal,
-- asset-mgmt fee, owner costs) -> EXCLUDED from NOI. Capex is capitalized to
-- the balance sheet (1xxx), so it never appears here.
-- security_invoker => gl_entries RLS applies to the caller.
-- ============================================================

-- Base: classify each income/expense GL line + signed amount.
create or replace view public.v_gl_pnl_lines with (security_invoker = true) as
  select
    property_id, entity_code, period_year, period_month, entry_date,
    account_code, account_name,
    case
      when account_code ~ '^4'                              then 'revenue'
      when account_code ~ '^5' and account_code <> '5221-00' then 'opex'
      else 'below_line'
    end as line_type,
    case
      -- revenue
      when account_code like '4601%' or account_code = '4151-04' then 'percentage_rent'
      when account_code like '4151%' or account_code like '4241%' or account_code like '4242%' then 'base_rent'
      when account_code like '478%' or account_code like '479%' or account_code like '480%' then 'cam_recovery'
      when account_code ~ '^4' then 'other_income'
      -- expense
      when account_code like '5231%' then 'management_fee'
      when account_code like '5102%' or account_code like '5112%' then 'taxes'
      when account_code like '509%' then 'insurance'
      when account_code like '500%' or account_code like '5010%' then 'utilities'
      when account_code like '501%' or account_code like '502%' or account_code like '503%' then 'repairs_maintenance'
      when account_code like '504%' or account_code like '505%' or account_code like '506%'
        or account_code like '507%' or account_code like '508%' then 'operating_expenses'
      when account_code ~ '^5' then 'other_expense'
      else 'below_line'
    end as category,
    -- revenue is credit-normal; expense is debit-normal. Always a positive magnitude.
    case when account_code ~ '^4' then (credit - debit) else (debit - credit) end as amount
  from public.gl_entries
  where not is_balance_forward
    and account_code ~ '^[4-9]'
    and period_year is not null and period_month is not null;

-- Monthly NOI per property (revenue - operating expense).
create or replace view public.v_gl_pnl_monthly with (security_invoker = true) as
  select property_id, period_year, period_month,
         coalesce(sum(amount) filter (where line_type = 'revenue'), 0) as revenue,
         coalesce(sum(amount) filter (where line_type = 'opex'), 0)    as opex,
         coalesce(sum(amount) filter (where line_type = 'revenue'), 0)
           - coalesce(sum(amount) filter (where line_type = 'opex'), 0) as noi
  from public.v_gl_pnl_lines
  group by property_id, period_year, period_month;

-- Category x month breakdown (for the NOI widget's income/expense lines).
create or replace view public.v_gl_pnl_category with (security_invoker = true) as
  select property_id, period_year, period_month, line_type, category,
         sum(amount) as amount
  from public.v_gl_pnl_lines
  group by property_id, period_year, period_month, line_type, category;

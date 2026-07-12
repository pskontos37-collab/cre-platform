-- ============================================================
-- GL-derived P&L v3 — reconcile NOI to the official income statements.
-- Validated GL calendar-2025 NOI against each property's MRI "Comparative Income
-- Statement" (Dec-2025 YTD). KM East/West already tied to the penny; this fixes
-- the Magnolia + Gateway opex classification so all four conform exactly:
--   * 'deprec'->'depr' and 'amorti'->'amort'  (catch abbreviated names like
--     "FF&E Depr", "Int Exp - Amort Def Fin")
--   * + 'ground rent|ground lease'            (ground rent is below NOI; previously
--     mis-caught as opex via the 'ground' R&M keyword)
--   * + 'leasing expense'                     ("Other Leasing Expense" is below NOI)
--   * interest INCOME (non-4xxx) -> below NOI (Magnolia "Misc Interest Income" 600100;
--     4xxx interest income stays revenue, e.g. Gateway 475600 which the IS includes in income)
--   * Gateway "Other Professional Fees" (601200) is operating in its IS, but Magnolia
--     codes the identical name below NOI — a property-specific CoA exception that no
--     global name rule can resolve, so it is pinned explicitly.
-- v_gl_pnl_monthly / v_gl_pnl_category read from this view unchanged.
-- ============================================================
create or replace view public.v_gl_pnl_lines with (security_invoker = true) as
  select
    property_id, entity_code, period_year, period_month, entry_date, account_code, account_name,
    line_type,
    case
      when line_type = 'revenue' and account_name ~* '(percentage rent|% rent)'                 then 'percentage_rent'
      when line_type = 'revenue' and account_name ~* '(base rent|rental|^rent| rent )'           then 'base_rent'
      when line_type = 'revenue' and account_name ~* '(recover|recov|reimburs)'                  then 'cam_recovery'
      when line_type = 'revenue'                                                                  then 'other_income'
      when line_type = 'opex' and account_name ~* '(real estate tax|property tax|^taxes|re tax)' then 'taxes'
      when line_type = 'opex' and account_name ~* 'insurance'                                     then 'insurance'
      when line_type = 'opex' and account_name ~* '(electric|water|gas|sewer|utilit)'            then 'utilities'
      when line_type = 'opex' and account_name ~* 'management fee'                                then 'management_fee'
      when line_type = 'opex' and account_name ~* '(repair|mainten|roof|hvac|plumb|paint|elevat|landscap|janitor|clean|parking|snow|sweep|pest|security|alarm|fire|sign|light|ground|powerwash|waste|trash|sprinkler)' then 'repairs_maintenance'
      when line_type = 'opex' and account_name ~* '(advertis|market|payroll|postage|telephone|office|dues|subscription|license|travel|courier|admin)' then 'other_expense'
      when line_type = 'opex'                                                                     then 'operating_expenses'
      else 'below_line'
    end as category,
    amount
  from (
    select
      property_id, entity_code, period_year, period_month, entry_date, account_code, account_name,
      case
        -- property-specific chart-of-accounts exception: Gateway "Other Professional
        -- Fees" (601200) is an operating cost in its income statement.
        when property_id = 'd5a4ed03-0b60-4168-9208-83822dd24884' and account_code = '601200' then 'opex'
        -- below-the-line / non-operating / capital / owner-level (by name, any code)
        when account_name ~* '(interest exp|depr|amort|disposition|provision for bad debt|deferred rent|favorable lease|unfavorable lease|improvement|leasing comm|leasing cost|leasing expense|ground rent|ground lease|construction in progress|asset management fee|gain on sale|loss on sale|legal fee|professional fee|audit|accounting fee|bank fee|filing fee|franchise tax|income tax|owner)'
             then 'below_line'
        when account_name ~* 'interest income' and account_code !~ '^4' then 'below_line'
        when account_code ~ '^4' then 'revenue'
        else 'opex'
      end as line_type,
      case when account_code ~ '^4' then (credit - debit) else (debit - credit) end as amount
    from public.gl_entries
    where not is_balance_forward
      and account_code ~ '^[4-9]'
      and period_year is not null and period_month is not null
  ) t;

-- ============================================================
-- GL-derived P&L v2 — NAME-BASED classification.
-- Properties use different charts of accounts (e.g. Knightdale codes property tax
-- in 5xxx; Gateway codes it 920000). Code-prefix classification therefore does NOT
-- generalize. Classify by ACCOUNT NAME (stable across charts) for below-the-line vs
-- operating; revenue stays code 4xxx (MRI revenue is universally 4xxx).
-- Replaces v_gl_pnl_lines; v_gl_pnl_monthly / v_gl_pnl_category read from it unchanged.
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
        -- below-the-line / non-operating / capital / owner-level (by name, any code)
        when account_name ~* '(interest exp|deprec|amorti|disposition|provision for bad debt|deferred rent|favorable lease|unfavorable lease|improvement|leasing comm|leasing cost|construction in progress|asset management fee|gain on sale|loss on sale|legal fee|professional fee|audit|accounting fee|bank fee|filing fee|franchise tax|income tax|owner)'
             then 'below_line'
        when account_code ~ '^4' then 'revenue'
        else 'opex'
      end as line_type,
      case when account_code ~ '^4' then (credit - debit) else (debit - credit) end as amount
    from public.gl_entries
    where not is_balance_forward
      and account_code ~ '^[4-9]'
      and period_year is not null and period_month is not null
  ) t;

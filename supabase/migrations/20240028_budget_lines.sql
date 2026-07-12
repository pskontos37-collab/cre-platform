-- 20240028_budget_lines.sql
-- Approved operating budgets (account x month), loaded from the property budget
-- workbooks (MRI BF_PROFORMD proformas for Gateway/Magnolia; the Summary tabs of
-- the Knightdale budget workbook). v_budget_pnl_category classifies budget lines
-- with the SAME name-based rules as v_gl_pnl_lines (migrations 20240019/21) so
-- budget-vs-actual compares like-for-like categories.

create table if not exists public.budget_lines (
  id uuid primary key default uuid_generate_v4(),
  property_id uuid not null references public.properties(id) on delete cascade,
  budget_year int not null,
  period_month int not null check (period_month between 1 and 12),
  account_code text not null,
  account_name text not null,
  amount numeric not null,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists budget_lines_prop_year on public.budget_lines(property_id, budget_year);

alter table public.budget_lines enable row level security;
create policy "budget_lines_select" on public.budget_lines
  for select using (public.can_access_property(property_id));
create policy "budget_lines_write" on public.budget_lines
  for all using (public.is_admin_or_am());
grant select, insert, update, delete on public.budget_lines to authenticated;

-- Same classifier as v_gl_pnl_lines: line_type first (incl. the Gateway 601200
-- pin and interest-income rule), then category by account name.
create or replace view public.v_budget_pnl_category
with (security_invoker = true) as
select property_id,
       budget_year as period_year,
       period_month,
       line_type,
       case
         when line_type = 'revenue' and account_name ~* '(percentage rent|% rent)' then 'percentage_rent'
         when line_type = 'revenue' and account_name ~* '(base rent|rental|^rent| rent )' then 'base_rent'
         when line_type = 'revenue' and account_name ~* '(recover|recov|reimburs)' then 'cam_recovery'
         when line_type = 'revenue' then 'other_income'
         when line_type = 'opex' and account_name ~* '(real estate tax|property tax|^taxes|re tax)' then 'taxes'
         when line_type = 'opex' and account_name ~* 'insurance' then 'insurance'
         when line_type = 'opex' and account_name ~* '(electric|water|gas|sewer|utilit)' then 'utilities'
         when line_type = 'opex' and account_name ~* 'management fee' then 'management_fee'
         when line_type = 'opex' and account_name ~* '(repair|mainten|roof|hvac|plumb|paint|elevat|landscap|janitor|clean|parking|snow|sweep|pest|security|alarm|fire|sign|light|ground|powerwash|waste|trash|sprinkler)' then 'repairs_maintenance'
         when line_type = 'opex' and account_name ~* '(advertis|market|payroll|postage|telephone|office|dues|subscription|license|travel|courier|admin)' then 'other_expense'
         when line_type = 'opex' then 'operating_expenses'
         else 'below_line'
       end as category,
       sum(amount) as amount
from (
  select property_id, budget_year, period_month, account_name, amount,
    case
      when property_id = 'd5a4ed03-0b60-4168-9208-83822dd24884'::uuid and account_code = '601200' then 'opex'
      when account_name ~* '(interest exp|depr|amort|disposition|provision for bad debt|deferred rent|favorable lease|unfavorable lease|improvement|leasing comm|leasing cost|leasing expense|ground rent|ground lease|construction in progress|asset management fee|gain on sale|loss on sale|legal fee|professional fee|audit|accounting fee|bank fee|filing fee|franchise tax|income tax|owner)' then 'below_line'
      when account_name ~* 'interest income' and account_code !~ '^4' then 'below_line'
      when account_code ~ '^4' then 'revenue'
      else 'opex'
    end as line_type
  from public.budget_lines
  where account_code ~ '^[4-9]'
) t
group by property_id, budget_year, period_month, line_type, category;

grant select on public.v_budget_pnl_category to authenticated;

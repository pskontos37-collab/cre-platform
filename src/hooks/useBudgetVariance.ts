import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { num } from './useFinancials'
import { fetchAllRows } from '../lib/fetchAll'

// YTD actuals vs approved budget, aggregated across the selected properties.
// Actuals come from the GL category matview (v_gl_pnl_category); budget from
// v_budget_pnl_category (migration 20240028). Both share the same name-based
// classifier so categories line up. YTD is summed per property through that
// property's latest actuals month within the budget year, then totalled — so a
// property that has only closed through May doesn't get a full-year budget
// compared against a partial actual.

export interface BvaLine { category: string; label: string; actual: number; budget: number }

// One property's YTD comparison (through its own close month).
export interface PropertyBva {
  propertyId: string
  throughMonth: number
  income: BvaLine[]
  expense: BvaLine[]
  revenue: BvaLine
  opex: BvaLine
  noi: BvaLine
}

export interface BudgetVarianceData {
  year: number
  throughMonth: number     // representative (latest) close month across properties
  mixedClose: boolean      // true when properties closed through different months
  income: BvaLine[]
  expense: BvaLine[]
  revenue: BvaLine
  opex: BvaLine
  noi: BvaLine
  byProperty: PropertyBva[]   // per-property breakdown of the same comparison
}

const CAT_LABEL: Record<string, string> = {
  base_rent: 'Base Rent', percentage_rent: 'Percentage Rent', cam_recovery: 'Recoveries',
  other_income: 'Other Income', taxes: 'Real Estate Taxes', insurance: 'Insurance',
  utilities: 'Utilities', repairs_maintenance: 'Repairs & Maintenance',
  operating_expenses: 'Contract Services', management_fee: 'Management Fee',
  other_expense: 'G&A / Marketing',
}
const INCOME_ORDER  = ['base_rent', 'percentage_rent', 'cam_recovery', 'other_income']
const EXPENSE_ORDER = ['taxes', 'insurance', 'utilities', 'repairs_maintenance', 'operating_expenses', 'management_fee', 'other_expense']

export function useBudgetVariance(propertyIds: string[]) {
  return useQuery<BudgetVarianceData | null>(async () => {
    if (!propertyIds.length) return null

    // Budget rows for the selection — this also tells us which properties have a
    // budget at all. Compare only against these so a GL-only property (no budget)
    // can't inflate the total against a $0 plan.
    const budRows = await fetchAllRows<any>((from, to) => supabase
      .from('v_budget_pnl_category')
      .select('property_id, period_year, period_month, line_type, category, amount')
      .in('property_id', propertyIds)
      .order('property_id').order('period_year').order('period_month').order('line_type').order('category')
      .range(from, to))
    if (!budRows.length) return null

    // Compare against the most recent budgeted year.
    const year = Math.max(...(budRows as any[]).map(r => num(r.period_year)))
    const budgetProps = new Set((budRows as any[]).filter(r => num(r.period_year) === year).map(r => r.property_id))

    // Per-property close month within that year (only budgeted properties).
    const monthly = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_monthly')
      .select('property_id, period_month')
      .in('property_id', [...budgetProps])
      .eq('period_year', year)
      .order('property_id').order('period_month')
      .range(from, to))

    const asOf = new Map<string, number>()      // property_id -> close month in `year`
    for (const r of monthly as any[]) {
      const m = num(r.period_month)
      if (m > (asOf.get(r.property_id) ?? 0)) asOf.set(r.property_id, m)
    }
    if (!asOf.size) return null                 // budget exists but no actuals yet this year
    const eligible = [...asOf.keys()]           // budgeted AND has actuals in `year`
    const months = new Set([...asOf.values()])
    const throughMonth = Math.max(...months)
    const mixedClose = months.size > 1

    // Actuals categories for the comparison year, budgeted properties only.
    const actRows = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_category')
      .select('property_id, period_month, line_type, category, amount')
      .in('property_id', eligible)
      .eq('period_year', year)
      .order('property_id').order('period_month').order('line_type').order('category')
      .range(from, to))

    // Aggregate at two grains from the same rows: portfolio-wide
    // (`${line_type}|${category}`) and per-property
    // (`${property_id}|${line_type}|${category}`), YTD through each
    // property's close month.
    const agg = new Map<string, { actual: number; budget: number }>()
    const perAgg = new Map<string, { actual: number; budget: number }>()
    const bump = (map: Map<string, { actual: number; budget: number }>, key: string, field: 'actual' | 'budget', amt: number) => {
      const cur = map.get(key) ?? { actual: 0, budget: 0 }
      cur[field] += amt
      map.set(key, cur)
    }
    const add = (r: any, field: 'actual' | 'budget') => {
      const closeMonth = asOf.get(r.property_id)
      if (closeMonth == null || num(r.period_month) > closeMonth) return
      const amt = num(r.amount)
      bump(agg, `${r.line_type}|${r.category}`, field, amt)
      bump(perAgg, `${r.property_id}|${r.line_type}|${r.category}`, field, amt)
    }
    for (const r of actRows as any[]) add(r, 'actual')
    for (const r of budRows as any[]) if (num(r.period_year) === year) add(r, 'budget')

    const sum = (lines: BvaLine[], label: string): BvaLine => ({
      category: label, label,
      actual: lines.reduce((s, l) => s + l.actual, 0),
      budget: lines.reduce((s, l) => s + l.budget, 0),
    })
    // Build the income/expense/revenue/opex/noi block from any agg map + key prefix.
    const buildBlock = (map: Map<string, { actual: number; budget: number }>, prefix: string) => {
      const mkLine = (lineType: string, category: string): BvaLine => {
        const v = map.get(`${prefix}${lineType}|${category}`) ?? { actual: 0, budget: 0 }
        return { category, label: CAT_LABEL[category] ?? category, actual: v.actual, budget: v.budget }
      }
      const income  = INCOME_ORDER.filter(c => map.has(`${prefix}revenue|${c}`)).map(c => mkLine('revenue', c))
      const expense = EXPENSE_ORDER.filter(c => map.has(`${prefix}opex|${c}`)).map(c => mkLine('opex', c))
      const revenue = sum(income, 'Total Revenue')
      const opex = sum(expense, 'Total Operating Expenses')
      const noi: BvaLine = {
        category: 'noi', label: 'Net Operating Income',
        actual: revenue.actual - opex.actual, budget: revenue.budget - opex.budget,
      }
      return { income, expense, revenue, opex, noi }
    }

    const portfolio = buildBlock(agg, '')
    const byProperty: PropertyBva[] = eligible
      .map(pid => ({ propertyId: pid, throughMonth: asOf.get(pid)!, ...buildBlock(perAgg, `${pid}|`) }))
      .filter(p => p.income.length || p.expense.length)

    if (!portfolio.income.length && !portfolio.expense.length) return null
    return { year, throughMonth, mixedClose, ...portfolio, byProperty }
  }, [propertyIds.join(',')])
}

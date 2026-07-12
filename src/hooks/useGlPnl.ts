import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { num } from './useFinancials'
import { fetchAllRows } from '../lib/fetchAll'

export interface PnlMonth { year: number; month: number; revenue: number; opex: number; noi: number }
export interface PnlCatLine { category: string; label: string; amount: number }

// One property's slice of the same T12 window (the combined series' last 12
// months), for per-property breakdowns in multi-property widgets.
export interface PropertyPnl {
  propertyId: string
  t12: { revenue: number; opex: number; noi: number }
  trend: PnlMonth[]               // this property's months within the window, ascending
  t12ExpenseLines: PnlCatLine[]   // trailing 12 months, ranked desc
}

export interface GlPnlData {
  t12: { revenue: number; opex: number; noi: number }
  latest: PnlMonth | null
  trend: PnlMonth[]               // up to last 12 months, ascending
  incomeLines: PnlCatLine[]       // latest month
  expenseLines: PnlCatLine[]      // latest month
  t12ExpenseLines: PnlCatLine[]   // trailing 12 months, ranked desc
  byProperty: PropertyPnl[]
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

const EMPTY: GlPnlData = { t12: { revenue: 0, opex: 0, noi: 0 }, latest: null, trend: [], incomeLines: [], expenseLines: [], t12ExpenseLines: [], byProperty: [] }

export function useGlPnl(propertyIds: string[]) {
  return useQuery<GlPnlData>(async () => {
    if (!propertyIds.length) return EMPTY

    const monthly = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_monthly')
      .select('property_id, period_year, period_month, revenue, opex, noi')
      .in('property_id', propertyIds)
      .order('property_id').order('period_year').order('period_month')
      .range(from, to))

    // Aggregate across properties by (year, month)
    const byKey = new Map<number, PnlMonth>()
    for (const r of (monthly ?? []) as any[]) {
      const y = Number(r.period_year), m = Number(r.period_month)
      const key = y * 12 + m
      const prev = byKey.get(key) ?? { year: y, month: m, revenue: 0, opex: 0, noi: 0 }
      byKey.set(key, { year: y, month: m, revenue: prev.revenue + num(r.revenue), opex: prev.opex + num(r.opex), noi: prev.noi + num(r.noi) })
    }
    const series = [...byKey.values()].sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month))
    if (!series.length) return EMPTY

    const trend = series.slice(-12)
    const t12 = trend.reduce((s, m) => ({ revenue: s.revenue + m.revenue, opex: s.opex + m.opex, noi: s.noi + m.noi }), { revenue: 0, opex: 0, noi: 0 })
    const latest = series[series.length - 1]

    // Category breakdown for the trend window; paged because the row count
    // crosses the 1,000-row API cap once more property GLs are loaded.
    const cats = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_category')
      .select('property_id, period_year, period_month, line_type, category, amount')
      .in('property_id', propertyIds)
      .gte('period_year', trend[0].year)
      .order('property_id').order('period_year').order('period_month').order('line_type').order('category')
      .range(from, to))

    const latestKey = latest.year * 12 + latest.month
    const t12StartKey = latestKey - 11
    const inWindow = (key: number) => key >= t12StartKey && key <= latestKey
    const latestIncome = new Map<string, number>()
    const latestExpense = new Map<string, number>()
    const t12Expense = new Map<string, number>()
    const propT12Expense = new Map<string, Map<string, number>>()   // pid -> category -> amount
    for (const r of (cats ?? []) as any[]) {
      const key = Number(r.period_year) * 12 + Number(r.period_month)
      const amt = num(r.amount)
      if (key === latestKey) {
        const m = r.line_type === 'revenue' ? latestIncome : r.line_type === 'opex' ? latestExpense : null
        if (m) m.set(r.category, (m.get(r.category) ?? 0) + amt)
      }
      if (r.line_type === 'opex' && inWindow(key)) {
        t12Expense.set(r.category, (t12Expense.get(r.category) ?? 0) + amt)
        const pm = propT12Expense.get(r.property_id) ?? new Map<string, number>()
        pm.set(r.category, (pm.get(r.category) ?? 0) + amt)
        propT12Expense.set(r.property_id, pm)
      }
    }
    const toLines = (map: Map<string, number>, order: string[]): PnlCatLine[] =>
      order.filter(c => map.has(c)).map(c => ({ category: c, label: CAT_LABEL[c] ?? c, amount: map.get(c)! }))
    const rankLines = (map: Map<string, number>): PnlCatLine[] =>
      [...map.entries()]
        .map(([category, amount]) => ({ category, label: CAT_LABEL[category] ?? category, amount }))
        .sort((a, b) => b.amount - a.amount)

    // Per-property T12 totals + monthly trend over the same window as the
    // combined series. v_gl_pnl_monthly is already one row per property/month,
    // so each in-window row is a trend point as-is.
    const propT12 = new Map<string, { revenue: number; opex: number; noi: number }>()
    const propTrend = new Map<string, PnlMonth[]>()
    for (const r of (monthly ?? []) as any[]) {
      const key = Number(r.period_year) * 12 + Number(r.period_month)
      if (!inWindow(key)) continue
      const cur = propT12.get(r.property_id) ?? { revenue: 0, opex: 0, noi: 0 }
      cur.revenue += num(r.revenue); cur.opex += num(r.opex); cur.noi += num(r.noi)
      propT12.set(r.property_id, cur)
      const pts = propTrend.get(r.property_id) ?? []
      pts.push({ year: Number(r.period_year), month: Number(r.period_month), revenue: num(r.revenue), opex: num(r.opex), noi: num(r.noi) })
      propTrend.set(r.property_id, pts)
    }
    const byProperty: PropertyPnl[] = [...propT12.entries()].map(([propertyId, pt12]) => ({
      propertyId,
      t12: pt12,
      trend: (propTrend.get(propertyId) ?? []).sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month)),
      t12ExpenseLines: rankLines(propT12Expense.get(propertyId) ?? new Map()),
    }))

    return {
      t12, latest, trend,
      incomeLines: toLines(latestIncome, INCOME_ORDER),
      expenseLines: toLines(latestExpense, EXPENSE_ORDER),
      t12ExpenseLines: rankLines(t12Expense),
      byProperty,
    }
  }, [propertyIds.join(',')])
}

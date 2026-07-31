import { type PcfRow, type PcfSection, type PcfTotals, type PcfBudget } from '../hooks/usePcf'

// Presentation shape of the /pcf statement: which lines appear, in what order, and
// where the subtotals fall. It lives here rather than in PcfPage so the PDF can
// render the SAME row list. Duplicating this in the report was the alternative, and
// a second implementation of a statement's subtotals is precisely the failure mode
// (a variance reversed on two rows, a SUM range that dropped a line) that /pcf was
// built to retire.

export const SUBSECTION_LABEL: Record<string, string> = {
  utilities: 'Utilities', repairs_maintenance: 'Repairs & Maintenance', cleaning: 'Cleaning',
  grounds_lot: 'Grounds & Lot', security: 'Security', insurance: 'Insurance',
  property_taxes: 'Property Taxes', administrative: 'Administrative', management_fee: 'Management Fee',
}

export type DisplayRow =
  | { kind: 'section'; label: string }
  | { kind: 'line'; row: PcfRow }
  // budgetValues is the same subtotal run through the SAME cascade over budget
  // amounts, so a subtotal variance can never disagree with its member lines.
  // Absent => that subtotal has no budget counterpart (the equity cascade).
  | { kind: 'subtotal'; label: string; values: number[]; budgetValues?: number[]; strong?: boolean }
  | { kind: 'spacer' }

export function buildDisplayRows(rows: PcfRow[], totals: PcfTotals, budgetTotals: PcfTotals | null): DisplayRow[] {
  const out: DisplayRow[] = []
  const bySection = (s: PcfSection) => rows.filter(r => r.section === s)
  const bt = (pick: (t: PcfTotals) => number[]): number[] | undefined =>
    budgetTotals ? pick(budgetTotals) : undefined

  out.push({ kind: 'section', label: 'Income' })
  for (const r of bySection('income')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total income', values: totals.totalIncome, budgetValues: bt(t => t.totalIncome) })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Operating expenses' })
  const opex = bySection('opex')
  const subs = [...new Set(opex.map(r => r.subsection ?? 'other'))]
  for (const sub of subs) {
    const lines = opex.filter(r => (r.subsection ?? 'other') === sub)
    if (!lines.length) continue
    out.push({ kind: 'section', label: SUBSECTION_LABEL[sub] ?? sub })
    for (const r of lines) out.push({ kind: 'line', row: r })
  }
  out.push({ kind: 'subtotal', label: 'Total operating expenses', values: totals.totalOpex, budgetValues: bt(t => t.totalOpex) })
  out.push({ kind: 'subtotal', label: 'Net operating income', values: totals.noi, budgetValues: bt(t => t.noi), strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Non-operating' })
  for (const r of bySection('non_operating')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Net income', values: totals.netIncome, budgetValues: bt(t => t.netIncome), strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Capital expenditures' })
  for (const r of bySection('capital')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total capital', values: totals.capital, budgetValues: bt(t => t.capital) })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Other balance sheet' })
  for (const r of bySection('balance_sheet')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total other balance sheet', values: totals.balanceSheet, budgetValues: bt(t => t.balanceSheet) })
  out.push({ kind: 'subtotal', label: 'Net monthly cash', values: totals.netMonthlyCash, budgetValues: bt(t => t.netMonthlyCash), strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Equity' })
  for (const r of bySection('equity')) out.push({ kind: 'line', row: r })
  // Net cash and the cash recap deliberately carry NO budget: equity is budgeted
  // nowhere (mig 20240146), so a "budgeted ending cash" would be a fabricated number.
  out.push({ kind: 'subtotal', label: 'Net cash', values: totals.netCash, strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Cash recap' })
  out.push({ kind: 'subtotal', label: 'Beginning cash', values: totals.beginningCash })
  out.push({ kind: 'subtotal', label: 'Change in cash', values: totals.netCash })
  out.push({ kind: 'subtotal', label: 'Ending cash', values: totals.endingCash, strong: true })

  return out
}

// Budget amounts wearing the grid's own row shape, so the tested cascade in
// computeTotals produces the budget subtotals rather than a parallel
// re-implementation that could drift from it. A line with no budget row gets null
// cells, not zeros - see the note on PcfBudget.
export function budgetShapedRows(rows: PcfRow[], budget: PcfBudget): PcfRow[] {
  return rows.map(r => {
    const b = budget.byLine.get(r.lineKey)
    return {
      ...r,
      cells: r.cells.map((c, i) => ({ ...c, amount: b ? b[i] : null })),
    }
  })
}

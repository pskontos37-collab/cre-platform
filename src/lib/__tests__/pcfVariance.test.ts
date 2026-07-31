import { describe, it, expect } from 'vitest'
import { computeVariance, computeTotals } from '../../hooks/usePcf'
import type { PcfRow, PcfSection, PcfBudget } from '../../hooks/usePcf'
import { budgetShapedRows, buildDisplayRows } from '../pcfDisplay'

// Fixtures. `amounts` is 12 monthly values; null means genuinely unset.
function row(lineKey: string, section: PcfSection, amounts: (number | null)[], opts?: Partial<PcfRow>): PcfRow {
  const cells = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    isActual: i < 6,
    amount: amounts[i] ?? null,
    method: null,
    note: null,
    derivedFromYear: null,
  }))
  return {
    lineKey, section, subsection: null, label: lineKey, sortOrder: 1,
    isNonCash: false, hasBudgetSeed: true, cells,
    fyTotal: cells.reduce((s, c) => s + (c.amount ?? 0), 0),
    ...opts,
  }
}
const flat = (v: number) => Array.from({ length: 12 }, () => v)

describe('computeVariance', () => {
  it('sums YTD only through the as-of month, and FY across all twelve', () => {
    const v = computeVariance(flat(10).map(a => ({ amount: a })), flat(8), 6)
    expect(v.ytdActual).toBe(60)
    expect(v.ytdBudget).toBe(48)
    expect(v.ytdVar).toBe(12)
    expect(v.fyProjected).toBe(120)
    expect(v.fyBudget).toBe(96)
    expect(v.fyVar).toBe(24)
  })

  it('reports hasBudget=false when the line is unbudgeted, and never invents a variance', () => {
    const v = computeVariance(flat(10).map(a => ({ amount: a })), undefined, 6)
    expect(v.hasBudget).toBe(false)
    // The arithmetic still runs, but the caller must render a dash rather than
    // treating the whole actual as an overspend - that is the trap this guards.
    expect(v.ytdBudget).toBe(0)
  })

  it('treats a null (unset) month as zero for totals but keeps budget separate', () => {
    const amounts = [10, 10, null, null, null, null, null, null, null, null, null, null]
    const v = computeVariance(amounts.map(a => ({ amount: a })), flat(5), 6)
    expect(v.ytdActual).toBe(20)
    expect(v.ytdBudget).toBe(30)
    expect(v.ytdVar).toBe(-10)
  })

  it('gives a UNIFORM favourable sign across sections, because amounts are effect-on-cash', () => {
    // income above budget: +
    const inc = computeVariance(flat(100).map(a => ({ amount: a })), flat(90), 12)
    expect(inc.fyVar).toBeGreaterThan(0)
    // opex UNDER budget: stored negative, so -80 actual vs -90 budget is also +
    const opex = computeVariance(flat(-80).map(a => ({ amount: a })), flat(-90), 12)
    expect(opex.fyVar).toBeGreaterThan(0)
    // opex OVER budget is negative
    const over = computeVariance(flat(-100).map(a => ({ amount: a })), flat(-90), 12)
    expect(over.fyVar).toBeLessThan(0)
  })

  it('handles as-of month 0 (nothing closed) without leaking a YTD figure', () => {
    const v = computeVariance(flat(10).map(a => ({ amount: a })), flat(8), 0)
    expect(v.ytdActual).toBe(0)
    expect(v.ytdBudget).toBe(0)
    expect(v.ytdVar).toBe(0)
    expect(v.fyVar).toBe(24)
  })
})

describe('budgetShapedRows', () => {
  const rows = [row('rent', 'income', flat(100)), row('mgmt', 'opex', flat(-10))]
  const budget: PcfBudget = { byLine: new Map([['rent', flat(90)]]), fiscalYear: 2026 }

  it('carries budget amounts onto the matching line', () => {
    const shaped = budgetShapedRows(rows, budget)
    expect(shaped[0].cells.map(c => c.amount)).toEqual(flat(90))
  })

  it('leaves an UNBUDGETED line null rather than zero', () => {
    const shaped = budgetShapedRows(rows, budget)
    // All null, not all 0. A zero here would make the opex line look 100% underspent.
    expect(shaped[1].cells.every(c => c.amount === null)).toBe(true)
  })

  it('preserves row identity so the cascade groups the same way', () => {
    const shaped = budgetShapedRows(rows, budget)
    expect(shaped.map(r => [r.lineKey, r.section])).toEqual([['rent', 'income'], ['mgmt', 'opex']])
  })
})

describe('buildDisplayRows budget wiring', () => {
  const rows = [row('rent', 'income', flat(100)), row('mgmt', 'opex', flat(-10))]
  const budget: PcfBudget = { byLine: new Map([['rent', flat(90)], ['mgmt', flat(-12)]]), fiscalYear: 2026 }
  const totals = computeTotals(rows, 0)
  const budgetTotals = computeTotals(budgetShapedRows(rows, budget), 0)

  it('attaches budget subtotals that agree with the member lines', () => {
    const display = buildDisplayRows(rows, totals, budgetTotals)
    const noi = display.find(d => d.kind === 'subtotal' && d.label === 'Net operating income')
    expect(noi).toBeDefined()
    if (noi?.kind !== 'subtotal') throw new Error('expected a subtotal')
    // budget NOI = 90 income + (-12) opex = 78 per month
    expect(noi.budgetValues?.[0]).toBe(78)
    // and the actual NOI is 100 - 10 = 90, so the variance is +12 a month
    expect(noi.values[0] - (noi.budgetValues?.[0] ?? 0)).toBe(12)
  })

  it('gives Net cash and the cash recap NO budget, because equity is budgeted nowhere', () => {
    const display = buildDisplayRows(rows, totals, budgetTotals)
    for (const label of ['Net cash', 'Beginning cash', 'Change in cash', 'Ending cash']) {
      const r = display.find(d => d.kind === 'subtotal' && d.label === label)
      if (r?.kind !== 'subtotal') throw new Error(`missing subtotal ${label}`)
      expect(r.budgetValues).toBeUndefined()
    }
  })

  it('omits every budget column when no budget is loaded', () => {
    const display = buildDisplayRows(rows, totals, null)
    const subtotals = display.filter(d => d.kind === 'subtotal')
    expect(subtotals.length).toBeGreaterThan(0)
    expect(subtotals.every(d => d.kind === 'subtotal' && d.budgetValues === undefined)).toBe(true)
  })
})

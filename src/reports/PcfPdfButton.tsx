import { PdfDownloadButton, sanitizeFilename } from './PdfDownloadButton'
import { computeVariance } from '../hooks/usePcf'
import type { PcfRow, PcfTotals, PcfBudget } from '../hooks/usePcf'
import { buildDisplayRows } from '../lib/pcfDisplay'
import { fmt } from './theme'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Everything already computed by the page is passed in rather than re-fetched, and
// the row list is built with the PAGE'S OWN buildDisplayRows. That is deliberate: a
// PDF that re-derives its own subtotals is a second implementation that can silently
// disagree with the screen, which is the whole failure mode this feature replaces.
export function PcfPdfButton({
  propertyName, fiscalYear, asOfMonth, status, cashBasis, openingCash,
  rows, totals, budgetTotals, budget, includeVariance,
}: {
  propertyName: string
  fiscalYear: number
  asOfMonth: number
  status: 'draft' | 'published'
  cashBasis: 'bank_balance' | 'cumulative' | null
  openingCash: number
  rows: PcfRow[]
  totals: PcfTotals
  budgetTotals: PcfTotals | null
  budget: PcfBudget | null
  includeVariance: boolean
}) {
  const V = includeVariance && !!budget

  return (
    <PdfDownloadButton
      label="⬇ PDF"
      filename={`Wilkow-PCF-${sanitizeFilename(propertyName)}-FY${fiscalYear}${V ? '-variance' : ''}.pdf`}
      title={`Download FY${fiscalYear} projected cash flow as a branded PDF${V ? ', including budget variance' : ''}`}
      build={async () => {
        const display = buildDisplayRows(rows, totals, budgetTotals)

        const lines = display.map(dr => {
          if (dr.kind === 'spacer') return { kind: 'spacer' as const, label: '', values: [], fyTotal: 0 }
          if (dr.kind === 'section') return { kind: 'section' as const, label: dr.label, values: [], fyTotal: 0 }

          if (dr.kind === 'subtotal') {
            const v = V ? computeVariance(dr.values.map(x => ({ amount: x })), dr.budgetValues, asOfMonth) : null
            return {
              kind: 'subtotal' as const,
              label: dr.label,
              values: dr.values as (number | null)[],
              fyTotal: dr.values.reduce((s, x) => s + x, 0),
              strong: dr.strong,
              // hasBudget is false for the equity cascade and the cash recap, which
              // have no budget counterpart at all - those must print a dash, not 0.
              fyBudget: v && v.hasBudget ? v.fyBudget : null,
              fyVar: v && v.hasBudget ? v.fyVar : null,
            }
          }

          const r = dr.row
          const v = V ? computeVariance(r.cells, budget?.byLine.get(r.lineKey), asOfMonth) : null
          return {
            kind: 'line' as const,
            label: r.label,
            values: r.cells.map(c => c.amount),
            fyTotal: r.fyTotal,
            isNonCash: r.isNonCash,
            noBudgetCoverage: !r.hasBudgetSeed,
            fyBudget: v && v.hasBudget ? v.fyBudget : null,
            fyVar: v && v.hasBudget ? v.fyVar : null,
          }
        })

        // The KPI band carries the YTD story the table has no room for. NOI and Net
        // cash are the two figures asked about first; both come from the same cascade.
        const kpis: Array<{ label: string; value: string; sub?: string }> = []
        const ytd = (series: number[]) => series.slice(0, asOfMonth).reduce((s, x) => s + x, 0)
        const noiYtd = ytd(totals.noi)
        const netCashFy = totals.netCash.reduce((s, x) => s + x, 0)

        kpis.push({
          label: `NOI YTD`,
          value: fmt(noiYtd),
          sub: asOfMonth > 0 ? `through ${MONTH_ABBR[asOfMonth - 1]}` : 'no month closed',
        })
        if (V && budgetTotals) {
          const noiBudYtd = ytd(budgetTotals.noi)
          const d = noiYtd - noiBudYtd
          kpis.push({ label: 'NOI vs budget YTD', value: fmt(d), sub: `${d >= 0 ? 'favourable' : 'unfavourable'} - budget ${fmt(noiBudYtd)}` })
        }
        kpis.push({ label: 'NOI FY projected', value: fmt(totals.noi.reduce((s, x) => s + x, 0)) })
        if (V && budgetTotals) {
          const noiFy = totals.noi.reduce((s, x) => s + x, 0)
          const noiBudFy = budgetTotals.noi.reduce((s, x) => s + x, 0)
          kpis.push({ label: 'NOI vs budget FY', value: fmt(noiFy - noiBudFy), sub: `budget ${fmt(noiBudFy)}` })
        }
        kpis.push({
          label: 'Net cash FY',
          value: fmt(netCashFy),
          sub: cashBasis === 'bank_balance'
            ? `ending ${fmt(totals.endingCash[11])}`
            : 'cumulative cash generated',
        })

        const { buildPcfPdf } = await import('./PcfReport')
        return buildPcfPdf({
          propertyName,
          fiscalYear,
          asOfMonth,
          statusLabel: status === 'published' ? 'Published (frozen)' : 'Draft',
          cashBasisLabel:
            cashBasis === 'bank_balance' ? `Bank balance, opening ${fmt(openingCash)}`
            : cashBasis === 'cumulative' ? 'Cumulative cash generated'
            : '',
          lines,
          includeVariance: V,
          kpis,
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}

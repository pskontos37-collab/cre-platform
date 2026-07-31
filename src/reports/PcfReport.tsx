import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, pdfSafe } from './theme'

// Branded PDF of the /pcf grid. The on-screen table is the source of truth for
// what this shows: the same 12 months split at the same ACTUAL|FORECAST boundary,
// the same subtotal cascade, and the same budget variance when it is switched on.
//
// LAYOUT NOTE. Letter landscape is 792pt wide and ReportShell reserves 36pt each
// side, leaving 720pt. The widths below total exactly 720 in both modes, so the
// table fills the page and react-pdf never has to compress the last column:
//   plain     140 + 12*44 + 52           = 140 + 528 + 52           = 720
//   variance  116 + 12*36 + 52 + 60 + 60 = 116 + 432 + 52 + 60 + 60 = 720
// Carrying all five on-screen variance columns would not fit at a legible size, so
// the PDF keeps FY budget and FY variance in the table and puts the YTD story in the
// KPI band, where an asset manager looks first anyway.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface PcfReportLine {
  kind: 'section' | 'line' | 'subtotal' | 'spacer'
  label: string
  values: (number | null)[]       // 12 months; null renders as a dash, never as 0
  fyTotal: number
  strong?: boolean
  isNonCash?: boolean
  noBudgetCoverage?: boolean
  fyBudget?: number | null       // null/undefined => genuinely unbudgeted
  fyVar?: number | null
}

export interface PcfReportInput {
  propertyName: string
  fiscalYear: number
  asOfMonth: number
  statusLabel: string
  cashBasisLabel: string
  lines: PcfReportLine[]
  includeVariance: boolean
  kpis: Array<{ label: string; value: string; sub?: string }>
  generatedAt: string
}

export async function buildPcfPdf(input: PcfReportInput): Promise<Blob> {
  return pdf(<PcfReport {...input} />).toBlob()
}

// A blank forward month must stay blank on paper too. Rendering 0 for an unset cell
// is exactly how a cash flow stops tying without anything looking wrong.
const cell = (v: number | null): string => {
  if (v === null || v === undefined) return '-'
  const r = Math.round(v)
  if (r === 0) return '0'
  const s = Math.abs(r).toLocaleString('en-US')
  return r < 0 ? `(${s})` : s
}

function varColor(v: number): string {
  if (Math.round(v) === 0) return TEXT_MUTED
  return v > 0 ? GREEN : '#c25b52'
}

export function PcfReport(input: PcfReportInput) {
  const { propertyName, fiscalYear, asOfMonth, statusLabel, cashBasisLabel, lines, includeVariance, kpis, generatedAt } = input
  const V = includeVariance
  const W = V
    ? { label: 116, month: 36, fy: 52, bud: 60, var: 60 }
    : { label: 140, month: 44, fy: 52, bud: 0, var: 0 }

  const boundary = asOfMonth > 0 ? `actuals through ${MONTH_ABBR[asOfMonth - 1]}` : 'no month closed yet'

  return (
    <ReportShell
      kicker="M&J Wilkow - Projected Cash Flow"
      title={pdfSafe(propertyName)}
      subtitle={`FY${fiscalYear} - ${boundary} - ${statusLabel}${cashBasisLabel ? ` - ${cashBasisLabel}` : ''}`}
      metaRight={[`FY${fiscalYear}`, `Generated ${generatedAt}`]}
    >
      {kpis.length > 0 && (
        <View style={{ flexDirection: 'row', marginBottom: 14 }}>
          {kpis.map((k, i) => (
            <Kpi key={k.label} label={k.label} value={k.value} sub={k.sub} last={i === kpis.length - 1} />
          ))}
        </View>
      )}

      <SectionLabel>Monthly Detail{V ? ' and Budget Variance' : ''}</SectionLabel>

      {/* header repeats on page breaks so a spilled table stays readable */}
      <View fixed style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 3, paddingHorizontal: 2 }}>
        <Text style={{ ...hcell, width: W.label }}>LINE</Text>
        {MONTH_ABBR.map((m, i) => (
          <Text key={m} style={{ ...hcell, width: W.month, textAlign: 'right', color: i + 1 <= asOfMonth ? WILKOW : TEXT_FAINT }}>
            {m.toUpperCase()}
          </Text>
        ))}
        <Text style={{ ...hcell, width: W.fy, textAlign: 'right' }}>FY</Text>
        {V && <Text style={{ ...hcell, width: W.bud, textAlign: 'right' }}>FY BUD</Text>}
        {V && <Text style={{ ...hcell, width: W.var, textAlign: 'right' }}>FY VAR</Text>}
      </View>

      {lines.map((l, idx) => {
        if (l.kind === 'spacer') return <View key={idx} style={{ height: 5 }} />

        if (l.kind === 'section') return (
          <View key={idx} wrap={false} style={{ paddingTop: 5, paddingBottom: 1, paddingHorizontal: 2 }}>
            <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.9, color: WILKOW_MIST }}>
              {pdfSafe(l.label).toUpperCase()}
            </Text>
          </View>
        )

        const sub = l.kind === 'subtotal'
        return (
          <View
            key={idx}
            wrap={false}
            style={{
              flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 2,
              borderBottomWidth: sub ? 0 : 0.4, borderBottomColor: RULE,
              borderTopWidth: sub ? 0.75 : 0, borderTopColor: sub ? RULE : undefined,
              backgroundColor: l.strong ? '#f6f8f9' : undefined,
            }}
          >
            <Text style={{ width: W.label, fontSize: 6.6, fontFamily: sub ? 'Helvetica-Bold' : 'Helvetica', color: sub ? TEXT : TEXT_MUTED }}>
              {pdfSafe(l.label)}
              {l.isNonCash ? ' (non-cash)' : ''}
            </Text>
            {l.values.map((v, i) => (
              <Text
                key={i}
                style={{
                  width: W.month, textAlign: 'right', fontSize: 6.4,
                  fontFamily: sub ? 'Helvetica-Bold' : 'Helvetica',
                  color: v === null ? TEXT_FAINT : TEXT,
                }}
              >
                {cell(v)}
              </Text>
            ))}
            <Text style={{ width: W.fy, textAlign: 'right', fontSize: 6.4, fontFamily: 'Helvetica-Bold', color: sub ? TEXT : TEXT_MUTED }}>
              {cell(l.fyTotal)}
            </Text>
            {V && (
              <Text style={{ width: W.bud, textAlign: 'right', fontSize: 6.4, color: TEXT_MUTED }}>
                {l.fyBudget === null || l.fyBudget === undefined ? '-' : cell(l.fyBudget)}
              </Text>
            )}
            {V && (
              <Text
                style={{
                  width: W.var, textAlign: 'right', fontSize: 6.4,
                  fontFamily: sub ? 'Helvetica-Bold' : 'Helvetica',
                  color: l.fyVar === null || l.fyVar === undefined ? TEXT_FAINT : varColor(l.fyVar),
                }}
              >
                {l.fyVar === null || l.fyVar === undefined ? '-' : cell(l.fyVar)}
              </Text>
            )}
          </View>
        )
      })}

      <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 8, lineHeight: 1.5 }}>
        Months through {asOfMonth > 0 ? MONTH_ABBR[asOfMonth - 1] : 'none'} are closed and read from the general
        ledger; later months are forecast and editable in the app. A dash is a genuinely unset month, not zero.
        Every amount is stated as its effect on cash, so each subtotal is a plain sum and{' '}
        {V ? 'a positive variance is favourable in every section - income above budget and expenses under budget both read positive. ' : ''}
        non-cash lines sit inside net income but are excluded from the cash bridge in matched pairs.
        {V ? ' A dash in a budget column means the line has no approved budget; equity is budgeted nowhere by design, so Net cash and the cash recap carry no budget comparison.' : ''}
      </Text>
    </ReportShell>
  )
}

const hcell = { fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.5, color: TEXT_FAINT } as const

function Kpi({ label, value, sub, last }: { label: string; value: string; sub?: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: WILKOW, borderRadius: 4, paddingVertical: 7, paddingHorizontal: 9 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: TEXT_FAINT, marginBottom: 4 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 12, color: TEXT }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 3 }}>{sub}</Text> : null}
    </View>
  )
}

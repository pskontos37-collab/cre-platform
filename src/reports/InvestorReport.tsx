import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_MUTED, WILKOW, fmt, pdfSafe } from './theme'

// Quarterly Investor Report — the platform's version of the manual quarterly
// package assembled in K:\Working Files - Qtrly Investor Rptg. One property
// per document: performance for the quarter, leasing, and the distribution
// ledger with realized returns.

export interface InvestorReportInput {
  property: { name: string; location: string | null; assetType: string; totalSf: number | null }
  quarter: { label: string; start: string; end: string }
  financials: {
    months: Array<{ label: string; revenue: number; opex: number; noi: number }>   // the quarter's months
    qRevenue: number; qOpex: number; qNoi: number
    prevQNoi: number | null
    t12Noi: number
    hasGl: boolean
  }
  leasing: {
    occupancyPct: number | null
    walt: number | null
    tenantCount: number | null
    avgPsf: number | null
    annualRent: number | null
    asOfLabel: string | null
  }
  topTenants: Array<{ tenant: string; sf: number; annualRent: number; pct: number; leaseEnd: string | null }>
  rollover: Array<{ year: number; sf: number; pct: number }>
  partnerships: Array<{
    dealName: string
    layer: 1 | 2 | null
    parties: Array<{
      name: string
      contributed: number
      qDistributed: number
      ytdDistributed: number
      cumDistributed: number
      dpi: number | null
      irr: number | null
      lastDistribution: string | null
    }>
  }>
  generatedAt: string
}

const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`
const sf = (n: number) => `${Math.round(n).toLocaleString('en-US')} SF`

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={{ flex: 1, borderWidth: 0.75, borderColor: RULE, borderRadius: 4, padding: 8 }}>
      <Text style={{ fontSize: 6.5, color: TEXT_MUTED, letterSpacing: 1, marginBottom: 4 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 12.5, color: accent ? GREEN : WILKOW }}>{value}</Text>
    </View>
  )
}

function Row({ cells, widths, bold, muted, rule }: {
  cells: string[]; widths: number[]; bold?: boolean; muted?: boolean; rule?: boolean
}) {
  return (
    <View style={{
      flexDirection: 'row',
      borderBottomWidth: rule ? 0.75 : 0.5,
      borderBottomColor: rule ? WILKOW : RULE,
      paddingVertical: 3.5,
    }}>
      {cells.map((c, i) => (
        <Text key={i} style={{
          width: `${widths[i]}%`,
          fontSize: 7.5,
          fontFamily: bold ? 'Helvetica-Bold' : 'Helvetica',
          color: muted ? TEXT_MUTED : TEXT,
          textAlign: i === 0 ? 'left' : 'right',
          paddingRight: i === 0 ? 4 : 0,
        }}>{pdfSafe(c)}</Text>
      ))}
    </View>
  )
}

function InvestorReportDoc({ input }: { input: InvestorReportInput }) {
  const f = input.financials
  const noiDelta = f.prevQNoi != null && f.prevQNoi !== 0 ? (f.qNoi - f.prevQNoi) / Math.abs(f.prevQNoi) : null
  const qDistTotal = input.partnerships.reduce((s, p) => s + p.parties.reduce((s2, x) => s2 + x.qDistributed, 0), 0)

  return (
    <ReportShell
      kicker="Quarterly Investor Report"
      title={input.property.name}
      subtitle={[input.property.location, input.property.assetType.replace('_', ' '), input.property.totalSf ? sf(input.property.totalSf) : null].filter(Boolean).join('  ·  ')}
      metaRight={[input.quarter.label, `Prepared ${input.generatedAt}`, 'M&J Wilkow Asset Management']}
      orientation="portrait"
    >
      {/* KPI strip */}
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14 }}>
        <Kpi label={`${input.quarter.label} NOI`} value={f.hasGl ? fmt(f.qNoi) : '-'} />
        <Kpi label="T12 NOI" value={f.hasGl ? fmt(f.t12Noi) : '-'} />
        <Kpi label="Occupancy" value={input.leasing.occupancyPct != null ? pct(input.leasing.occupancyPct) : '-'} />
        <Kpi label="WALT" value={input.leasing.walt != null ? `${input.leasing.walt.toFixed(1)} yrs` : '-'} />
        <Kpi label={`${input.quarter.label} Distributions`} value={fmt(qDistTotal)} accent={qDistTotal > 0} />
      </View>

      {/* Financial performance */}
      <View style={{ marginBottom: 14 }}>
        <SectionLabel>Financial performance</SectionLabel>
        {f.hasGl ? (
          <View>
            <Row cells={['', 'Revenue', 'Operating expenses', 'NOI']} widths={[40, 20, 20, 20]} bold rule />
            {f.months.map(m => (
              <Row key={m.label} cells={[m.label, fmt(m.revenue), fmt(m.opex), fmt(m.noi)]} widths={[40, 20, 20, 20]} />
            ))}
            <Row cells={[`${input.quarter.label} total`, fmt(f.qRevenue), fmt(f.qOpex), fmt(f.qNoi)]} widths={[40, 20, 20, 20]} bold />
            {noiDelta != null ? (
              <Text style={{ fontSize: 7, color: TEXT_MUTED, marginTop: 4 }}>
                NOI {noiDelta >= 0 ? 'up' : 'down'} {pct(Math.abs(noiDelta))} versus the prior quarter{f.prevQNoi != null ? ` (${fmt(f.prevQNoi)})` : ''}.
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={{ fontSize: 8, color: TEXT_MUTED }}>General-ledger data for this property has not been loaded for the selected quarter.</Text>
        )}
      </View>

      {/* Distributions & returns */}
      <View style={{ marginBottom: 14 }}>
        <SectionLabel>Distributions and realized returns</SectionLabel>
        {input.partnerships.length === 0 ? (
          <Text style={{ fontSize: 8, color: TEXT_MUTED }}>No modeled capital partnerships for this property.</Text>
        ) : input.partnerships.map(p => (
          <View key={p.dealName} style={{ marginBottom: 8 }} wrap={false}>
            <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: WILKOW, marginBottom: 3 }}>
              {pdfSafe(p.dealName)}{p.layer ? `  (Layer ${p.layer})` : ''}
            </Text>
            <Row cells={['Partner', 'Contributed', `${input.quarter.label}`, 'YTD', 'Cumulative', 'DPI', 'Realized IRR']} widths={[28, 14, 12, 12, 14, 9, 11]} bold rule />
            {p.parties.map(x => (
              <Row
                key={x.name}
                cells={[
                  x.name,
                  fmt(x.contributed),
                  x.qDistributed !== 0 ? fmt(x.qDistributed) : '-',
                  x.ytdDistributed !== 0 ? fmt(x.ytdDistributed) : '-',
                  fmt(x.cumDistributed),
                  x.dpi != null ? `${x.dpi.toFixed(2)}x` : '-',
                  x.irr != null ? pct(x.irr) : '-',
                ]}
                widths={[28, 14, 12, 12, 14, 9, 11]}
              />
            ))}
          </View>
        ))}
        <Text style={{ fontSize: 6.5, color: TEXT_MUTED, marginTop: 2 }}>
          Realized IRR reflects actual dated capital flows to date with no residual value. DPI = cumulative distributions / contributed capital.
        </Text>
      </View>

      {/* Leasing */}
      <View style={{ marginBottom: 14 }} wrap={false}>
        <SectionLabel>Top tenants</SectionLabel>
        {input.topTenants.length ? (
          <View>
            <Row cells={['Tenant', 'SF', 'Annual rent', '% of rent', 'Lease end']} widths={[38, 14, 18, 14, 16]} bold rule />
            {input.topTenants.map(t => (
              <Row key={t.tenant} cells={[t.tenant, Math.round(t.sf).toLocaleString('en-US'), fmt(t.annualRent), pct(t.pct), t.leaseEnd ?? '-']} widths={[38, 14, 18, 14, 16]} />
            ))}
            {input.leasing.asOfLabel ? (
              <Text style={{ fontSize: 6.5, color: TEXT_MUTED, marginTop: 3 }}>Rent roll as of {input.leasing.asOfLabel}.</Text>
            ) : null}
          </View>
        ) : (
          <Text style={{ fontSize: 8, color: TEXT_MUTED }}>Rent-roll data has not been loaded for this property.</Text>
        )}
      </View>

      {input.rollover.length ? (
        <View wrap={false}>
          <SectionLabel>Lease rollover</SectionLabel>
          <Row cells={['Year', 'Expiring SF', '% of GLA']} widths={[40, 30, 30]} bold rule />
          {input.rollover.map(r => (
            <Row key={r.year} cells={[String(r.year), Math.round(r.sf).toLocaleString('en-US'), pct(r.pct)]} widths={[40, 30, 30]} />
          ))}
        </View>
      ) : null}
    </ReportShell>
  )
}

export async function buildInvestorReportPdf(input: InvestorReportInput): Promise<Blob> {
  return pdf(<InvestorReportDoc input={input} />).toBlob()
}

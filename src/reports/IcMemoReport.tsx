import { pdf, Text, View } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { WILKOW, WILKOW_MIST, GREEN, TEXT, TEXT_MUTED, TEXT_FAINT, RULE, SERIF, pdfSafe, fmt } from './theme'

// Investment Committee review memo — a branded, presentation-styled PDF built
// from a pipeline deal's structured data + an AI-drafted narrative (ic-memo
// edge fn). Reuses the shared ReportShell (letterhead + footer on every page).

export interface IcMemoInput {
  deal: {
    name: string
    assetType: string
    riskProfile: string
    subType: string | null
    submarket: string | null
    city: string | null
    state: string | null
    glaSf: number | null
    yearBuilt: number | null
    askPrice: number | null
    priceText: string | null
    goingInCap: number | null
    equityRequired: number | null
    totalCapitalization: number | null
    targetCloseDate: string | null
    projIrr: number | null
    equityMultiple: number | null
    avgCoc: number | null
    holdYears: number | null
    exitCap: number | null
    stabilizedYield: number | null
    thesis: string | null
    partner: string | null
    broker: string | null
    seller: string | null
    team: string[]
    lps: { partnerName: string; status: string; soft: number | null; committed: number | null }[]
    tenants: { name: string; sf: number | null; expiration: string | null }[]
  }
  promote?: {
    lpEquityPct: number; prefRate: number
    lpIrr: number | null; lpEm: number | null
    gpIrr: number | null; gpEm: number | null
    gpPromote: number; gpPromotePctOfProfit: number
  } | null
  memo: {
    headline?: string
    executive_summary?: string
    business_plan?: string
    risks?: { risk: string; mitigant: string }[]
    recommendation?: string
    ask?: string
  }
  preparedBy: string
  generatedAt: string
}

const RISK_LABEL: Record<string, string> = { core: 'Core', core_plus: 'Core-Plus', value_add: 'Value-Add', opportunistic: 'Opportunistic' }
const ASSET_LABEL: Record<string, string> = { retail: 'Retail', office: 'Office', mixed: 'Mixed-Use', industrial: 'Industrial' }
const LP_LABEL: Record<string, string> = { identified: 'Identified', teaser_sent: 'Teaser sent', reviewing: 'Reviewing', soft_circle: 'Soft-circled', committed: 'Committed', passed: 'Passed' }
const pct = (d: number | null, dp = 1) => (d == null ? '—' : `${(d * 100).toFixed(dp)}%`)
const safe = (s: string | null | undefined) => (s ? pdfSafe(s) : '')
const priceLabel = (d: IcMemoInput['deal']) => (d.askPrice != null ? fmt(d.askPrice) : (d.priceText ? safe(d.priceText) : '—'))

// ── small building blocks ──
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '25%', paddingRight: 12, marginBottom: 12 }}>
      <Text style={{ fontSize: 6.5, letterSpacing: 1, color: TEXT_FAINT, fontFamily: 'Helvetica-Bold', marginBottom: 2 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontSize: 11, color: TEXT, fontFamily: SERIF, fontWeight: 700 }}>{value}</Text>
    </View>
  )
}
function Metric({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <View style={{ flex: 1, borderWidth: 0.75, borderColor: RULE, borderRadius: 4, padding: '8 10', marginRight: 8 }}>
      <Text style={{ fontSize: 6.5, letterSpacing: 1, color: TEXT_FAINT, fontFamily: 'Helvetica-Bold', marginBottom: 3 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontSize: 15, color: tint ?? WILKOW, fontFamily: SERIF, fontWeight: 700 }}>{value}</Text>
    </View>
  )
}
function Para({ children }: { children: string }) {
  return <Text style={{ fontSize: 9.5, lineHeight: 1.5, color: TEXT, marginBottom: 6 }}>{children}</Text>
}
function Divider() { return <View style={{ borderTopWidth: 0.75, borderTopColor: RULE, marginVertical: 12 }} /> }

function IcMemoDoc({ deal, memo, preparedBy, generatedAt, promote }: IcMemoInput) {
  const profile = `${RISK_LABEL[deal.riskProfile] ?? deal.riskProfile} ${ASSET_LABEL[deal.assetType] ?? deal.assetType}`
  const loc = [deal.city, deal.state].filter(Boolean).join(', ')
  const committed = deal.lps.reduce((a, l) => a + (l.committed ?? 0), 0)
  const soft = deal.lps.reduce((a, l) => a + (l.soft ?? 0), 0)
  const gap = Math.max(0, (deal.equityRequired ?? 0) - committed - soft)

  return (
    <ReportShell
      kicker="Investment Summary"
      title={pdfSafe(deal.name)}
      subtitle={`${profile}${deal.subType ? ` · ${safe(deal.subType)}` : ''}${loc ? ` · ${loc}` : ''}`}
      metaRight={[`Prepared by ${pdfSafe(preparedBy)}`, generatedAt, 'Confidential']}
    >
      {/* ── Executive summary ── */}
      <SectionLabel>Executive Summary</SectionLabel>
      {memo.headline ? (
        <Text style={{ fontSize: 13, fontFamily: SERIF, fontWeight: 700, color: WILKOW, marginBottom: 8, lineHeight: 1.3 }}>{safe(memo.headline)}</Text>
      ) : null}
      {memo.executive_summary ? <Para>{safe(memo.executive_summary)}</Para> : <Para>{safe(deal.thesis) || 'No summary available.'}</Para>}

      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        <Metric label={deal.askPrice != null ? 'Purchase price' : 'Pricing guidance'} value={priceLabel(deal)} />
        <Metric label="Going-in cap" value={pct(deal.goingInCap)} />
        <Metric label="Projected IRR" value={pct(deal.projIrr)} tint={GREEN} />
        <Metric label="Equity multiple" value={deal.equityMultiple != null ? `${deal.equityMultiple.toFixed(2)}x` : '—'} />
        <View style={{ flex: 1 }}>
          <View style={{ borderWidth: 0.75, borderColor: RULE, borderRadius: 4, padding: '8 10' }}>
            <Text style={{ fontSize: 6.5, letterSpacing: 1, color: TEXT_FAINT, fontFamily: 'Helvetica-Bold', marginBottom: 3 }}>EQUITY TO RAISE</Text>
            <Text style={{ fontSize: 15, color: WILKOW, fontFamily: SERIF, fontWeight: 700 }}>{deal.equityRequired != null ? fmt(deal.equityRequired) : '—'}</Text>
          </View>
        </View>
      </View>

      <Divider />

      {/* ── The asset ── */}
      <SectionLabel>The Asset</SectionLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <Fact label="Investment profile" value={profile} />
        <Fact label="Submarket" value={deal.submarket ? safe(deal.submarket) : '—'} />
        <Fact label="Size" value={deal.glaSf != null ? `${Math.round(deal.glaSf).toLocaleString()} SF` : '—'} />
        <Fact label="Year built" value={deal.yearBuilt != null ? String(deal.yearBuilt) : '—'} />
        <Fact label="Seller" value={deal.seller ? safe(deal.seller) : '—'} />
        <Fact label="Broker" value={deal.broker ? safe(deal.broker) : '—'} />
        <Fact label="Target close" value={deal.targetCloseDate ?? '—'} />
        <Fact label="Deal team" value={deal.team.length ? deal.team.join(', ') : '—'} />
      </View>
      {deal.tenants.length > 0 && (
        <View style={{ marginTop: 4 }}>
          <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: WILKOW_MIST, marginBottom: 4 }}>MAJOR TENANTS</Text>
          <TableHeader cols={['Tenant', 'SF', 'Expiration']} widths={['60%', '20%', '20%']} />
          {deal.tenants.slice(0, 8).map((t, i) => (
            <TableRow key={i} cells={[safe(t.name), t.sf != null ? Math.round(t.sf).toLocaleString() : '—', t.expiration ? safe(t.expiration) : '—']} widths={['60%', '20%', '20%']} />
          ))}
        </View>
      )}

      {/* ── Strategy & returns ── */}
      <View break>
        <SectionLabel>Strategy &amp; Returns</SectionLabel>
        {memo.business_plan ? <Para>{safe(memo.business_plan)}</Para> : null}
        <View style={{ flexDirection: 'row', marginTop: 8 }}>
          <Metric label="Projected IRR" value={pct(deal.projIrr)} tint={GREEN} />
          <Metric label="Equity multiple" value={deal.equityMultiple != null ? `${deal.equityMultiple.toFixed(2)}x` : '—'} />
          <Metric label="Avg cash-on-cash" value={pct(deal.avgCoc)} />
          <Metric label="Stabilized yield" value={pct(deal.stabilizedYield)} />
          <Metric label="Exit cap" value={pct(deal.exitCap)} />
          <View style={{ flex: 1 }}>
            <View style={{ borderWidth: 0.75, borderColor: RULE, borderRadius: 4, padding: '8 10' }}>
              <Text style={{ fontSize: 6.5, letterSpacing: 1, color: TEXT_FAINT, fontFamily: 'Helvetica-Bold', marginBottom: 3 }}>HOLD</Text>
              <Text style={{ fontSize: 15, color: WILKOW, fontFamily: SERIF, fontWeight: 700 }}>{deal.holdYears != null ? `${deal.holdYears} yr` : '—'}</Text>
            </View>
          </View>
        </View>
        <Divider />

        {/* ── Capital & LPs ── */}
        <SectionLabel>Capital &amp; LP Syndication</SectionLabel>
        <View style={{ flexDirection: 'row', marginBottom: 10 }}>
          <Metric label="Total capitalization" value={deal.totalCapitalization != null ? fmt(deal.totalCapitalization) : (deal.askPrice != null ? fmt(deal.askPrice) : '—')} />
          <Metric label="Equity to raise" value={deal.equityRequired != null ? fmt(deal.equityRequired) : '—'} />
          <Metric label="Committed" value={fmt(committed)} tint={GREEN} />
          <Metric label="Soft-circled" value={fmt(soft)} />
          <Metric label="Remaining gap" value={fmt(gap)} tint={gap > 0 ? '#c25b52' : GREEN} />
        </View>
        {promote ? (
          <>
            <Text style={{ fontSize: 7, letterSpacing: 0.8, color: TEXT_FAINT, fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
              {`LP / GP PROMOTE — ${Math.round(promote.lpEquityPct * 100)}/${Math.round((1 - promote.lpEquityPct) * 100)} CO-INVEST, ${pct(promote.prefRate)} PREF, ${pct(promote.gpPromotePctOfProfit)} OF PROFIT TO GP`}
            </Text>
            <View style={{ flexDirection: 'row', marginBottom: 10 }}>
              <Metric label="LP IRR" value={pct(promote.lpIrr)} tint={GREEN} />
              <Metric label="LP multiple" value={promote.lpEm != null ? `${promote.lpEm.toFixed(2)}x` : '—'} />
              <Metric label="GP IRR" value={pct(promote.gpIrr)} tint={GREEN} />
              <Metric label="GP multiple" value={promote.gpEm != null ? `${promote.gpEm.toFixed(2)}x` : '—'} />
              <Metric label="GP promote" value={fmt(promote.gpPromote)} />
            </View>
          </>
        ) : null}
        {deal.lps.length > 0 ? (
          <>
            <TableHeader cols={['Capital partner', 'Status', 'Soft-circled', 'Committed']} widths={['40%', '24%', '18%', '18%']} />
            {deal.lps.map((l, i) => (
              <TableRow key={i} cells={[safe(l.partnerName), LP_LABEL[l.status] ?? l.status, l.soft != null ? fmt(l.soft) : '—', l.committed != null ? fmt(l.committed) : '—']} widths={['40%', '24%', '18%', '18%']} />
            ))}
          </>
        ) : <Text style={{ fontSize: 9, color: TEXT_MUTED }}>No LPs engaged yet — capital raise to commence on IC approval.</Text>}
      </View>

      {/* ── Risks & mitigants ── */}
      <View break>
        <SectionLabel>Key Risks &amp; Mitigants</SectionLabel>
        {(memo.risks ?? []).length > 0 ? (memo.risks ?? []).map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', marginBottom: 9 }}>
            <Text style={{ width: 16, fontSize: 10, fontFamily: SERIF, fontWeight: 700, color: WILKOW }}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 9.5, color: TEXT, fontFamily: 'Helvetica-Bold', marginBottom: 2 }}>{safe(r.risk)}</Text>
              <Text style={{ fontSize: 9, color: TEXT_MUTED, lineHeight: 1.45 }}>Mitigant: {safe(r.mitigant)}</Text>
            </View>
          </View>
        )) : <Text style={{ fontSize: 9, color: TEXT_MUTED }}>No risks drafted.</Text>}

        <Divider />

        {/* ── Recommendation & the ask ── */}
        <SectionLabel>Recommendation &amp; the Ask</SectionLabel>
        {memo.recommendation ? <Para>{safe(memo.recommendation)}</Para> : null}
        {memo.ask ? (
          <View style={{ marginTop: 6, borderLeftWidth: 3, borderLeftColor: WILKOW, backgroundColor: '#f2f5f6', padding: '9 12', borderRadius: 3 }}>
            <Text style={{ fontSize: 6.5, letterSpacing: 1, color: WILKOW_MIST, fontFamily: 'Helvetica-Bold', marginBottom: 3 }}>THE ASK</Text>
            <Text style={{ fontSize: 10.5, color: TEXT, fontFamily: SERIF, fontWeight: 700, lineHeight: 1.4 }}>{safe(memo.ask)}</Text>
          </View>
        ) : null}
        <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 14, lineHeight: 1.4 }}>
          Narrative sections (summary, business plan, risks, recommendation) are AI-drafted from the deal record and are a starting point for committee discussion — verify against source materials before relying on them.
        </Text>
      </View>
    </ReportShell>
  )
}

function TableHeader({ cols, widths }: { cols: string[]; widths: string[] }) {
  return (
    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingBottom: 3, marginBottom: 3 }}>
      {cols.map((c, i) => (
        <Text key={i} style={{ width: widths[i] as any, fontSize: 6.5, letterSpacing: 0.8, color: WILKOW_MIST, fontFamily: 'Helvetica-Bold', textAlign: i === 0 ? 'left' : 'right' }}>{c.toUpperCase()}</Text>
      ))}
    </View>
  )
}
function TableRow({ cells, widths }: { cells: string[]; widths: string[] }) {
  return (
    <View style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 3 }}>
      {cells.map((c, i) => (
        <Text key={i} style={{ width: widths[i] as any, fontSize: 8.5, color: i === 0 ? TEXT : TEXT_MUTED, textAlign: i === 0 ? 'left' : 'right' }}>{c}</Text>
      ))}
    </View>
  )
}

/** Dynamic-imported by the button so @react-pdf stays out of the main bundle. */
export async function buildIcMemoPdf(input: IcMemoInput): Promise<Blob> {
  return pdf(<IcMemoDoc {...input} />).toBlob()
}

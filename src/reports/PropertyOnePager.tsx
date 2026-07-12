import type { ReactNode } from 'react'
import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, fmt, pdfSafe } from './theme'

// Plain input struct — the button on PropertyDetailPage maps the hook data
// into this so the report stays decoupled from hook types.
export interface OnePagerInput {
  property: {
    name: string
    address: string | null
    assetType: string
    totalSf: number | null
    acquisitionDate: string | null
    acquisitionPrice: number | null
  }
  kpis: {
    t12Noi: number | null
    t12Revenue: number | null
    occupancyPct: number | null
    annualRent: number | null
    avgPsf: number | null
    walt: number | null
    rentRollAsOf: string | null
    docCount: number | null
  }
  noiTrend: Array<{ label: string; value: number }>
  topTenants: Array<{ tenant: string; sf: number; annualRent: number; leaseEnd: string | null }>
  loans: Array<{
    lender: string
    balance: number | null
    rate: number | null
    maturity: string | null
    dscr: number | null
    debtYield: number | null
    covenant: string | null
    status: 'breach' | 'near' | 'ok' | 'none'
  }>
  deals: Array<{ name: string; tiers: number; equity: number | null; prefs: string[] }>
  management: {
    manager: string | null
    mgmtFeePct: number | null
    constructionFeePct: number | null
    leasingFeePct: number | null
    reportsDueDay: number | null
  } | null
  criticalDates: Array<{ label: string; due: string; days: number }>
  generatedAt: string
}

export async function buildPropertyOnePagerPdf(input: OnePagerInput): Promise<Blob> {
  return pdf(<PropertyOnePager {...input} />).toBlob()
}

const sfmt = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`

export function PropertyOnePager({ property, kpis, noiTrend, topTenants, loans, deals, management, criticalDates, generatedAt }: OnePagerInput) {
  const subtitleBits = [
    property.address,
    property.assetType.replace(/_/g, ' '),
    property.totalSf ? `${sfmt(property.totalSf)} SF GLA` : null,
    property.acquisitionDate ? `acquired ${property.acquisitionDate}${property.acquisitionPrice ? ` for ${fmt(property.acquisitionPrice)}` : ''}` : null,
  ].filter(Boolean)

  return (
    <ReportShell
      orientation="portrait"
      kicker="M&J Wilkow · Property Profile"
      title={property.name}
      subtitle={subtitleBits.join(' · ')}
      metaRight={[`Generated ${generatedAt}`]}
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 14 }}>
        <Kpi label="T12 NOI" value={kpis.t12Noi != null && kpis.t12Noi !== 0 ? fmt(kpis.t12Noi) : '—'} />
        <Kpi label="T12 Revenue" value={kpis.t12Revenue != null && kpis.t12Revenue !== 0 ? fmt(kpis.t12Revenue) : '—'} />
        <Kpi label="Occupancy" value={kpis.occupancyPct != null ? pct(kpis.occupancyPct) : '—'} sub={kpis.rentRollAsOf ? `${kpis.rentRollAsOf} roll` : undefined} />
        <Kpi label="Annual Rent" value={kpis.annualRent != null && kpis.annualRent > 0 ? fmt(kpis.annualRent) : '—'} sub={kpis.avgPsf != null && kpis.avgPsf > 0 ? `${fmt(kpis.avgPsf)}/SF` : undefined} />
        <Kpi label="WALT" value={kpis.walt != null && kpis.walt > 0 ? `${kpis.walt.toFixed(1)} yrs` : '—'} last />
      </View>

      {/* ── two-column body ── */}
      <View style={{ flexDirection: 'row' }}>
        {/* left column */}
        <View style={{ flex: 1, marginRight: 14 }}>
          {noiTrend.length > 0 && (
            <Card title="NOI Trend (monthly, GL)">
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 58 }}>
                {noiTrend.map((m, i) => {
                  const max = Math.max(...noiTrend.map(x => Math.abs(x.value)), 1)
                  return (
                    <View key={i} style={{ flex: 1, alignItems: 'center', marginRight: 2 }}>
                      <View style={{ width: '100%', height: Math.max(2, (Math.abs(m.value) / max) * 44), backgroundColor: m.value >= 0 ? WILKOW : '#c25b52', borderRadius: 1.5, opacity: 0.9 }} />
                      <Text style={{ fontSize: 5.5, color: TEXT_FAINT, marginTop: 2 }}>{m.label}</Text>
                    </View>
                  )
                })}
              </View>
            </Card>
          )}

          <Card title={`Top Tenants${topTenants.length ? ` (${topTenants.length})` : ''}`}>
            {topTenants.length === 0 ? <Muted>No rent roll loaded.</Muted> : (
              <>
                <View style={{ flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: RULE, paddingBottom: 2 }}>
                  <Text style={{ ...hcell, flex: 1 }}>TENANT</Text>
                  <Text style={{ ...hcell, width: 48, textAlign: 'right' }}>SF</Text>
                  <Text style={{ ...hcell, width: 60, textAlign: 'right' }}>ANNUAL</Text>
                  <Text style={{ ...hcell, width: 56, textAlign: 'right' }}>LEASE END</Text>
                </View>
                {topTenants.map((t, i) => (
                  <View key={i} style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 2.5 }}>
                    <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT, flex: 1, paddingRight: 4 }}>{t.tenant}</Text>
                    <Text style={{ fontSize: 7, color: TEXT_MUTED, width: 48, textAlign: 'right' }}>{sfmt(t.sf)}</Text>
                    <Text style={{ fontSize: 7.5, color: TEXT, width: 60, textAlign: 'right' }}>{fmt(t.annualRent)}</Text>
                    <Text style={{ fontSize: 7, color: TEXT_FAINT, width: 56, textAlign: 'right' }}>{t.leaseEnd ?? '—'}</Text>
                  </View>
                ))}
              </>
            )}
          </Card>

          {management && (
            <Card title="Property Management">
              <FactRow k="Manager" v={management.manager ?? '—'} />
              <FactRow k="Management fee" v={management.mgmtFeePct != null ? `${management.mgmtFeePct}%` : '—'} />
              {management.constructionFeePct != null && <FactRow k="Construction fee" v={`${management.constructionFeePct}%`} />}
              {management.leasingFeePct != null && <FactRow k="Leasing fee" v={`${management.leasingFeePct}%`} />}
              {management.reportsDueDay != null && <FactRow k="Monthly reports due" v={`${management.reportsDueDay}th`} />}
            </Card>
          )}
        </View>

        {/* right column */}
        <View style={{ flex: 1 }}>
          <Card title="Debt & Coverage">
            {loans.length === 0 ? <Muted>No debt on this property.</Muted> : loans.map((l, i) => (
              <View key={i} style={{ marginBottom: i === loans.length - 1 ? 0 : 7 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT }}>{l.lender}</Text>
                  <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', color: l.status === 'breach' ? '#c25b52' : l.status === 'near' ? '#b8860b' : l.status === 'ok' ? GREEN : TEXT_FAINT }}>
                    {l.status === 'breach' ? 'BREACH' : l.status === 'near' ? 'NEAR COVENANT' : l.status === 'ok' ? 'IN COMPLIANCE' : 'NO COVENANT'}
                  </Text>
                </View>
                <FactRow k="Balance" v={l.balance != null ? fmt(l.balance) : '—'} />
                <FactRow k="Rate / Maturity" v={`${l.rate != null ? pct(l.rate, 2) : '—'} · ${l.maturity ?? '—'}`} />
                <FactRow k="DSCR / Debt yield" v={`${l.dscr != null ? `${l.dscr.toFixed(2)}x` : '—'} · ${l.debtYield != null ? pct(l.debtYield) : '—'}`} />
                {l.covenant && <FactRow k="Covenant" v={l.covenant} />}
              </View>
            ))}
          </Card>

          {deals.length > 0 && (
            <Card title="Equity Structure">
              {deals.map((d, i) => (
                <View key={i} style={{ marginBottom: i === deals.length - 1 ? 0 : 6 }}>
                  <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT, marginBottom: 1 }}>{d.name}</Text>
                  <FactRow k="Waterfall tiers" v={String(d.tiers)} />
                  {d.equity != null && <FactRow k="Total equity" v={fmt(d.equity)} />}
                  {d.prefs.map((p, j) => <FactRow key={j} k="Pref equity" v={p} />)}
                </View>
              ))}
            </Card>
          )}

          <Card title="Critical Dates · next 90 days">
            {criticalDates.length === 0 ? <Muted>Nothing due in the next 90 days.</Muted> : criticalDates.map((d, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 2.5 }}>
                <Text style={{ fontSize: 7.5, color: TEXT, flex: 1, paddingRight: 6 }}>{pdfSafe(d.label)}</Text>
                <Text style={{ fontSize: 7.5, fontFamily: d.days <= 14 ? 'Helvetica-Bold' : 'Helvetica', color: d.days <= 14 ? '#c25b52' : TEXT_FAINT }}>
                  {d.due} · {d.days}d
                </Text>
              </View>
            ))}
          </Card>

          {kpis.docCount != null && kpis.docCount > 0 && (
            <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 2 }}>
              Document corpus: {kpis.docCount.toLocaleString('en-US')} ingested documents for this property.
            </Text>
          )}
        </View>
      </View>

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 12, lineHeight: 1.5 }}>
        T12 figures from the property GL; occupancy and rents from the latest MRI rent roll; DSCR computed on the loan's
        full collateral set (cross-collateralized loans include sister properties).
      </Text>
    </ReportShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, last }: { label: string; value: string; sub?: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 8, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: WILKOW, borderRadius: 4, paddingVertical: 7, paddingHorizontal: 8 }}>
      <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: TEXT_FAINT, marginBottom: 4 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 11.5, color: TEXT }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 6, color: TEXT_FAINT, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View wrap={false} style={{ borderWidth: 0.75, borderColor: RULE, borderRadius: 4, paddingVertical: 7, paddingHorizontal: 9, marginBottom: 10 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.4, color: WILKOW_MIST, marginBottom: 5 }}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 }}>
      <Text style={{ fontSize: 7, color: TEXT_FAINT }}>{k}</Text>
      <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT, textAlign: 'right', maxWidth: '65%' }}>{v}</Text>
    </View>
  )
}

function Muted({ children }: { children: string }) {
  return <Text style={{ fontSize: 7.5, color: TEXT_FAINT }}>{children}</Text>
}

const hcell = { fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT } as const

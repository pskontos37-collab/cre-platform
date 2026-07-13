import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, fmt, pdfSafe } from './theme'

// ── Input shape ──────────────────────────────────────────────────────────────
// A plain, already-computed snapshot of the portfolio. ExecutiveSnapshotButton
// assembles this from the same dashboard hooks so every figure ties to the
// on-screen widgets to the penny; this module only lays it out.

export interface SnapshotKpis {
  propertyCount: number
  occupancyPct: number          // 0..1
  occupiedSf: number
  totalSf: number
  t12Noi: number
  t12Revenue: number
  t12Opex: number
  walt: number                  // years
  totalPastDueAr: number
  arAsOf: string | null
}

export interface SnapshotNoiPoint { year: number; month: number; noi: number }

export interface SnapshotBudget {
  year: number
  throughMonth: number
  mixedClose: boolean
  noiActual: number
  noiBudget: number
}

export interface SnapshotOccupancyRow {
  propertyName: string
  physicalPct: number           // 0..1
  occupiedSf: number
  totalSf: number
}

export interface SnapshotRolloverYear {
  year: number
  sf: number
  count: number
  pctOfTotal: number            // 0..1
}

export interface SnapshotTenant {
  tenantName: string
  propertyName: string
  annualRent: number
  pctOfTotal: number            // 0..1
  leasedSf: number
}

export interface SnapshotDscrRow {
  propertyName: string
  loanLabel: string
  dscr: number | null
  debtYield: number | null      // 0..1
  covenantType: 'dscr' | 'debt_yield' | null
  headroom: number | null
  isNear: boolean
  isBreach: boolean
}

export interface SnapshotCriticalDate {
  propertyName: string
  tenantName: string | null
  dateType: string
  dueDate: string
  daysUntil: number
  description: string | null
}

export interface SnapshotCoTenancy {
  propertyName: string
  triggerReason: string
}

export interface SnapshotDelinquency {
  tenantName: string
  propertyName: string
  pastDue: number
}

export interface SnapshotWorkOrders {
  open: number
  urgent: number                // priority emergency/urgent/high still open
  unassigned: number
}

export interface SnapshotReturnsRole {
  contributed: number
  distributed: number
  currentEquity: number | null
  totalValueMultiple: number | null
  totalValueIrr: number | null   // 0..1
}

export interface SnapshotReturns {
  dealCount: number
  lp: SnapshotReturnsRole
  gp: SnapshotReturnsRole
  promoteEquity: number | null   // Class B sold-today value (no IRR/EM by design)
}

export interface SnapshotHealthRow {
  tenantName: string
  propertyName: string
  ratio: number                  // occupancy cost / TTM sales, 0..1
  occupancyCost: number
  ttmSales: number
  band: 'healthy' | 'watch' | 'high'
  hasRecoveries: boolean         // false = rent-only floor (understates cost)
}

export interface SnapshotHealth {
  portfolioRatio: number         // 0..1
  ttmLabel: string
  reporterCount: number
  rows: SnapshotHealthRow[]       // worst (highest ratio) first
}

export interface PortfolioSnapshotInput {
  scopeLabel: string             // "Entire portfolio" or "N of M properties"
  generatedAt: string
  kpis: SnapshotKpis
  noiTrend: SnapshotNoiPoint[]
  budget: SnapshotBudget | null
  occupancy: SnapshotOccupancyRow[]
  rollover: SnapshotRolloverYear[]
  topTenants: SnapshotTenant[]
  dscr: SnapshotDscrRow[]
  criticalDates: SnapshotCriticalDate[]
  coTenancy: SnapshotCoTenancy[]
  delinquency: SnapshotDelinquency[]
  workOrders: SnapshotWorkOrders | null
  returns: SnapshotReturns | null
  health: SnapshotHealth | null
}

export async function buildPortfolioSnapshotPdf(input: PortfolioSnapshotInput): Promise<Blob> {
  return pdf(<PortfolioSnapshotReport {...input} />).toBlob()
}

// ── Formatting helpers ───────────────────────────────────────────────────────
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const sfmt = (n: number) => Math.round(n).toLocaleString('en-US')
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`
const fmtC = (n: number) => {
  const s = n < 0 ? '(' : ''
  const e = n < 0 ? ')' : ''
  const a = Math.abs(n)
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M${e}`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K${e}`
  return `${s}$${a.toFixed(0)}${e}`
}
const mult = (n: number | null) => (n == null || !isFinite(n) ? '—' : `${n.toFixed(2)}x`)
const irr = (n: number | null) => (n == null || !isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`)

const BAND_COLOR: Record<'healthy' | 'watch' | 'high', string> = { healthy: GREEN, watch: '#cf8544', high: '#8e3d3d' }
const healthBand = (r: number): 'healthy' | 'watch' | 'high' => (r <= 0.10 ? 'healthy' : r <= 0.15 ? 'watch' : 'high')

// ── Report ───────────────────────────────────────────────────────────────────
export function PortfolioSnapshotReport(p: PortfolioSnapshotInput) {
  const { kpis } = p
  const noiMargin = kpis.t12Revenue > 0 ? kpis.t12Noi / kpis.t12Revenue : null
  const budgetVar = p.budget ? p.budget.noiActual - p.budget.noiBudget : null
  const nearOrBreach = p.dscr.filter(d => d.isNear || d.isBreach).length

  return (
    <ReportShell
      kicker="M&J Wilkow · Executive Snapshot"
      title="Portfolio Snapshot"
      subtitle={`${p.scopeLabel} · ${kpis.propertyCount} ${kpis.propertyCount === 1 ? 'property' : 'properties'} · Financials GL-derived, trailing 12 months`}
      metaRight={[`Generated ${p.generatedAt}`, kpis.arAsOf ? `A/R as of ${kpis.arAsOf}` : 'Confidential']}
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 8, flexWrap: 'wrap' }}>
        <Kpi label="Properties" value={String(kpis.propertyCount)} />
        <Kpi label="Occupancy" value={kpis.totalSf > 0 ? pct1(kpis.occupancyPct) : '—'} sub={kpis.totalSf > 0 ? `${sfmt(kpis.occupiedSf)} / ${sfmt(kpis.totalSf)} SF` : undefined} />
        <Kpi label="T12 NOI" value={fmtC(kpis.t12Noi)} sub={noiMargin != null ? `${Math.round(noiMargin * 100)}% margin` : undefined} />
        <Kpi label="WALT" value={kpis.walt > 0 ? `${kpis.walt.toFixed(1)} yrs` : '—'} sub="weighted by SF" last />
      </View>
      <View style={{ flexDirection: 'row', marginBottom: 16, flexWrap: 'wrap' }}>
        <Kpi label="T12 Revenue" value={fmtC(kpis.t12Revenue)} />
        <Kpi label="T12 OpEx" value={fmtC(kpis.t12Opex)} />
        <Kpi label="Past-Due A/R" value={fmt(kpis.totalPastDueAr)} sub={p.delinquency.length ? `${p.delinquency.length} tenants` : undefined} />
        <Kpi label="Covenant Watch" value={nearOrBreach > 0 ? String(nearOrBreach) : 'None'} sub={`${p.dscr.length} loans tracked`} last />
      </View>

      {/* ── NOI trend + budget ── */}
      {p.noiTrend.length > 1 && (
        <View wrap={false} style={{ marginBottom: 16 }}>
          <SectionLabel>{`Monthly NOI — Trailing ${p.noiTrend.length} Months (GL)`}</SectionLabel>
          <NoiBars trend={p.noiTrend} />
          {p.budget && (
            <View style={{ flexDirection: 'row', marginTop: 8, alignItems: 'center', gap: 14 }}>
              <MiniStat label={`YTD Actual NOI (thru ${MON[p.budget.throughMonth]} ${p.budget.year})`} value={fmt(p.budget.noiActual)} />
              <MiniStat label="YTD Budget NOI" value={fmt(p.budget.noiBudget)} />
              <MiniStat
                label="Variance to Budget"
                value={`${budgetVar! >= 0 ? '+' : ''}${fmt(budgetVar!)}`}
                color={budgetVar! >= 0 ? GREEN : '#c25b52'}
              />
              {p.budget.mixedClose && <Text style={{ fontSize: 6.5, color: TEXT_FAINT }}>Properties closed through different months.</Text>}
            </View>
          )}
        </View>
      )}

      {/* ── Occupancy + rollover, side by side ── */}
      <View style={{ flexDirection: 'row', gap: 18, marginBottom: 16 }}>
        {/* Occupancy by property */}
        <View style={{ flex: 1 }}>
          <SectionLabel>Occupancy by Property</SectionLabel>
          <View wrap={false}>
            {p.occupancy.slice(0, 12).map((o, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
                <Text style={{ flex: 1, fontSize: 7.5, color: TEXT, paddingRight: 6 }}>{pdfSafe(o.propertyName)}</Text>
                <View style={{ width: 70, height: 6, backgroundColor: '#eef1f3', borderRadius: 3, marginRight: 6 }}>
                  <View style={{ width: `${Math.min(100, o.physicalPct * 100)}%`, height: 6, backgroundColor: o.physicalPct >= 0.9 ? GREEN : o.physicalPct >= 0.75 ? WILKOW : '#c25b52', borderRadius: 3 }} />
                </View>
                <Text style={{ width: 34, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT }}>{pct1(o.physicalPct)}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Rollover */}
        <View style={{ flex: 1 }}>
          <SectionLabel>Lease Rollover by Expiration Year</SectionLabel>
          {p.rollover.length > 0 ? (
            <RolloverBars rollover={p.rollover.slice(0, 10)} />
          ) : (
            <Text style={{ fontSize: 8, color: TEXT_FAINT }}>No dated active leases in scope.</Text>
          )}
        </View>
      </View>

      {/* ── Top tenants + DSCR ── */}
      <View style={{ flexDirection: 'row', gap: 18, marginBottom: 16 }} wrap={false}>
        <View style={{ flex: 1 }}>
          <SectionLabel>Top Tenants by Annual Base Rent</SectionLabel>
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 2 }}>
            <Text style={{ ...hcell, flex: 1 }}>TENANT</Text>
            <Text style={{ ...hcell, width: 60, textAlign: 'right' }}>ANNUAL RENT</Text>
            <Text style={{ ...hcell, width: 34, textAlign: 'right' }}>% ABR</Text>
          </View>
          {p.topTenants.slice(0, 10).map((t, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
              <View style={{ flex: 1, paddingRight: 6 }}>
                <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(t.tenantName)}</Text>
                <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{pdfSafe(t.propertyName)}</Text>
              </View>
              <Text style={{ width: 60, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{fmt(t.annualRent)}</Text>
              <Text style={{ width: 34, textAlign: 'right', fontSize: 7.5, color: TEXT_MUTED }}>{pct1(t.pctOfTotal)}</Text>
            </View>
          ))}
        </View>

        <View style={{ flex: 1 }}>
          <SectionLabel>Debt Coverage (DSCR / Debt Yield)</SectionLabel>
          {p.dscr.length > 0 ? (
            <>
              <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 2 }}>
                <Text style={{ ...hcell, flex: 1 }}>LOAN</Text>
                <Text style={{ ...hcell, width: 42, textAlign: 'right' }}>DSCR</Text>
                <Text style={{ ...hcell, width: 46, textAlign: 'right' }}>DEBT YLD</Text>
                <Text style={{ ...hcell, width: 44, textAlign: 'right' }}>STATUS</Text>
              </View>
              {p.dscr.slice(0, 10).map((d, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
                  <View style={{ flex: 1, paddingRight: 6 }}>
                    <Text style={{ fontSize: 7.5, color: TEXT }}>{pdfSafe(d.loanLabel)}</Text>
                    <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{pdfSafe(d.propertyName)}</Text>
                  </View>
                  <Text style={{ width: 42, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{d.dscr != null ? `${d.dscr.toFixed(2)}x` : '—'}</Text>
                  <Text style={{ width: 46, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{d.debtYield != null ? pct1(d.debtYield) : '—'}</Text>
                  <View style={{ width: 44, alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: d.isBreach ? '#8e3d3d' : d.isNear ? '#cf8544' : GREEN }}>
                      {d.isBreach ? 'BREACH' : d.isNear ? 'NEAR' : 'OK'}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : (
            <Text style={{ fontSize: 8, color: TEXT_FAINT }}>No loans tracked in scope.</Text>
          )}
        </View>
      </View>

      {/* ── Risk & critical dates ── */}
      <View style={{ flexDirection: 'row', gap: 18, marginBottom: 16 }}>
        <View style={{ flex: 1 }}>
          <SectionLabel>Critical Dates — Next 90 Days</SectionLabel>
          {p.criticalDates.length > 0 ? (
            p.criticalDates.slice(0, 10).map((c, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
                <Text style={{ width: 52, fontSize: 7, color: c.daysUntil <= 30 ? '#c25b52' : TEXT_MUTED, fontFamily: c.daysUntil <= 30 ? 'Helvetica-Bold' : 'Helvetica' }}>{c.dueDate}</Text>
                <View style={{ flex: 1, paddingRight: 6 }}>
                  <Text style={{ fontSize: 7.5, color: TEXT }}>{pdfSafe(labelDate(c.dateType))}{c.tenantName ? ` · ${pdfSafe(c.tenantName)}` : ''}</Text>
                  <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{pdfSafe(c.propertyName)}</Text>
                </View>
                <Text style={{ width: 36, textAlign: 'right', fontSize: 7, color: TEXT_MUTED }}>{c.daysUntil}d</Text>
              </View>
            ))
          ) : (
            <Text style={{ fontSize: 8, color: TEXT_FAINT }}>No critical dates in the next 90 days.</Text>
          )}
        </View>

        <View style={{ flex: 1 }}>
          <SectionLabel>Co-Tenancy Flags & Delinquency</SectionLabel>
          <View style={{ marginBottom: 6 }}>
            <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: p.coTenancy.length ? '#8e3d3d' : GREEN, marginBottom: 3 }}>
              {p.coTenancy.length ? `${p.coTenancy.length} pending co-tenancy ${p.coTenancy.length === 1 ? 'flag' : 'flags'}` : 'No live co-tenancy flags'}
            </Text>
            {p.coTenancy.slice(0, 4).map((f, i) => (
              <Text key={i} style={{ fontSize: 6.5, color: TEXT_MUTED, marginBottom: 1.5 }}>
                {pdfSafe(f.propertyName)}: {pdfSafe(f.triggerReason)}
              </Text>
            ))}
          </View>
          <View style={{ borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 5 }}>
            <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED, marginBottom: 3 }}>Largest past-due balances</Text>
            {p.delinquency.length > 0 ? p.delinquency.slice(0, 5).map((d, i) => (
              <View key={i} style={{ flexDirection: 'row', paddingVertical: 1.5 }}>
                <View style={{ flex: 1, paddingRight: 6 }}>
                  <Text style={{ fontSize: 7, color: TEXT }}>{pdfSafe(d.tenantName)}</Text>
                  <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{pdfSafe(d.propertyName)}</Text>
                </View>
                <Text style={{ fontSize: 7.5, color: '#8e3d3d', fontFamily: 'Helvetica-Bold' }}>{fmt(d.pastDue)}</Text>
              </View>
            )) : <Text style={{ fontSize: 7, color: TEXT_FAINT }}>No past-due balances.</Text>}
          </View>
        </View>
      </View>

      {/* ── Operations + Returns ── */}
      <View style={{ flexDirection: 'row', gap: 18 }} wrap={false}>
        <View style={{ flex: 1 }}>
          <SectionLabel>Operations</SectionLabel>
          {p.workOrders ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <MiniStat label="Open Work Orders" value={String(p.workOrders.open)} />
              <MiniStat label="Urgent / High" value={String(p.workOrders.urgent)} color={p.workOrders.urgent > 0 ? '#cf8544' : undefined} />
              <MiniStat label="Unassigned" value={String(p.workOrders.unassigned)} />
            </View>
          ) : (
            <Text style={{ fontSize: 8, color: TEXT_FAINT }}>No work-order data in scope.</Text>
          )}
        </View>

        <View style={{ flex: 1 }}>
          <SectionLabel>Investor Returns — Sold Today (Layer 1)</SectionLabel>
          {p.returns && p.returns.dealCount > 0 ? (
            <>
              <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 2 }}>
                <Text style={{ ...hcell, flex: 1 }}>POSITION</Text>
                <Text style={{ ...hcell, width: 56, textAlign: 'right' }}>EQUITY VALUE</Text>
                <Text style={{ ...hcell, width: 34, textAlign: 'right' }}>TV/EM</Text>
                <Text style={{ ...hcell, width: 38, textAlign: 'right' }}>IRR</Text>
              </View>
              <ReturnsRow label="LP (institutional)" r={p.returns.lp} />
              <ReturnsRow label="GP (M&J blended)" r={p.returns.gp} />
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5 }}>
                <Text style={{ flex: 1, fontSize: 7.5, color: TEXT }}>Promote (Class B)</Text>
                <Text style={{ width: 56, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{p.returns.promoteEquity != null ? fmtC(p.returns.promoteEquity) : '—'}</Text>
                <Text style={{ width: 34, textAlign: 'right', fontSize: 7, color: TEXT_FAINT }}>—</Text>
                <Text style={{ width: 38, textAlign: 'right', fontSize: 7, color: TEXT_FAINT }}>—</Text>
              </View>
              <Text style={{ fontSize: 6, color: TEXT_FAINT, marginTop: 4 }}>
                Sold-today value across {p.returns.dealCount} layer-1 {p.returns.dealCount === 1 ? 'deal' : 'deals'} in scope. Promote basis nominal — IRR/EM not meaningful.
              </Text>
            </>
          ) : (
            <Text style={{ fontSize: 8, color: TEXT_FAINT }}>No layer-1 JV deals in scope.</Text>
          )}
        </View>
      </View>

      {/* ── Tenant health (occupancy-cost ratio) ── */}
      {p.health && p.health.rows.length > 0 && (
        <View wrap={false} style={{ marginTop: 16 }}>
          <SectionLabel>{`Tenant Health — Occupancy-Cost Ratio (${p.health.reporterCount} sales reporters · TTM ${p.health.ttmLabel})`}</SectionLabel>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <View style={{ width: 130 }}>
              <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginBottom: 2 }}>PORTFOLIO OCC. COST</Text>
              <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: BAND_COLOR[healthBand(p.health.portfolioRatio)] }}>{pct1(p.health.portfolioRatio)}</Text>
              <Text style={{ fontSize: 6, color: TEXT_FAINT, marginTop: 2 }}>occupancy cost ÷ sales, blended across reporters</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 2 }}>
                <Text style={{ ...hcell, flex: 1 }}>TENANT (HIGHEST BURDEN)</Text>
                <Text style={{ ...hcell, width: 54, textAlign: 'right' }}>OCC. COST</Text>
                <Text style={{ ...hcell, width: 54, textAlign: 'right' }}>TTM SALES</Text>
                <Text style={{ ...hcell, width: 40, textAlign: 'right' }}>RATIO</Text>
              </View>
              {p.health.rows.slice(0, 6).map((h, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
                  <View style={{ flex: 1, paddingRight: 6 }}>
                    <Text style={{ fontSize: 7.5, color: TEXT }}>{pdfSafe(h.tenantName)}{h.hasRecoveries ? '' : ' *'}</Text>
                    <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{pdfSafe(h.propertyName)}</Text>
                  </View>
                  <Text style={{ width: 54, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{fmtC(h.occupancyCost)}</Text>
                  <Text style={{ width: 54, textAlign: 'right', fontSize: 7.5, color: TEXT_MUTED }}>{fmtC(h.ttmSales)}</Text>
                  <Text style={{ width: 40, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: BAND_COLOR[h.band] }}>{pct1(h.ratio)}</Text>
                </View>
              ))}
              <Text style={{ fontSize: 6, color: TEXT_FAINT, marginTop: 3 }}>Healthy &lt;=10% · Watch 10-15% · High &gt;15% (general-retail screen). * rent-only — recoveries not yet loaded, so cost is a floor.</Text>
            </View>
          </View>
        </View>
      )}

      <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 14, lineHeight: 1.5 }}>
        NOI, revenue and OpEx are GL-derived (trailing 12 months). Occupancy is physical (leased SF / rentable SF). WALT weighted by leased SF over remaining term.
        Base rent excludes recoveries and percentage rent. Debt coverage evaluates each loan's governing covenant against trailing-12 NOI of its collateral.
        Investor returns credit each position's current sold-today value as an unrealized terminal inflow. Prepared for internal executive review.
      </Text>
    </ReportShell>
  )
}

// ── Small components ───────────────────────────────────────────────────────────
const hcell = { fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT } as const

function Kpi({ label, value, sub, last }: { label: string; value: string; sub?: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: 110, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: WILKOW, borderRadius: 4, paddingVertical: 7, paddingHorizontal: 10 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: TEXT_FAINT, marginBottom: 4 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 13, color: TEXT }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  )
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View>
      <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginBottom: 2 }}>{label}</Text>
      <Text style={{ fontSize: 11, fontFamily: 'Helvetica-Bold', color: color ?? TEXT }}>{value}</Text>
    </View>
  )
}

function NoiBars({ trend }: { trend: SnapshotNoiPoint[] }) {
  const max = Math.max(...trend.map(t => Math.abs(t.noi)), 1)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 52 }}>
      {trend.map((m, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center', marginRight: 3 }}>
          <View style={{ width: '100%', height: Math.max(2, (Math.abs(m.noi) / max) * 40), backgroundColor: m.noi >= 0 ? WILKOW : '#c25b52', borderRadius: 1.5, opacity: 0.9 }} />
          <Text style={{ fontSize: 5.5, color: TEXT_FAINT, marginTop: 2 }}>{MON[m.month]}{m.month === 1 ? ` ${String(m.year).slice(2)}` : ''}</Text>
        </View>
      ))}
    </View>
  )
}

function RolloverBars({ rollover }: { rollover: SnapshotRolloverYear[] }) {
  const max = Math.max(...rollover.map(r => r.sf), 1)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 60 }}>
      {rollover.map(r => (
        <View key={r.year} style={{ flex: 1, alignItems: 'center', marginRight: 4 }}>
          <Text style={{ fontSize: 5.5, color: TEXT_MUTED, marginBottom: 1 }}>{sfmt(r.sf)}</Text>
          <View style={{ width: '100%', height: Math.max(2, (r.sf / max) * 38), backgroundColor: WILKOW, borderRadius: 1.5, opacity: 0.9 }} />
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED, marginTop: 2 }}>{r.year}</Text>
          <Text style={{ fontSize: 5.5, color: TEXT_FAINT }}>{r.count} · {Math.round(r.pctOfTotal * 100)}%</Text>
        </View>
      ))}
    </View>
  )
}

function ReturnsRow({ label, r }: { label: string; r: SnapshotReturnsRole }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: RULE }}>
      <Text style={{ flex: 1, fontSize: 7.5, color: TEXT }}>{label}</Text>
      <Text style={{ width: 56, textAlign: 'right', fontSize: 7.5, color: TEXT }}>{r.currentEquity != null ? fmtC(r.currentEquity) : '—'}</Text>
      <Text style={{ width: 34, textAlign: 'right', fontSize: 7.5, color: TEXT_MUTED }}>{mult(r.totalValueMultiple)}</Text>
      <Text style={{ width: 38, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: r.totalValueIrr != null && isFinite(r.totalValueIrr) ? (r.totalValueIrr < 0 ? '#c25b52' : WILKOW) : TEXT_FAINT }}>{irr(r.totalValueIrr)}</Text>
    </View>
  )
}

const DATE_LABELS: Record<string, string> = {
  lease_expiration: 'Lease expiration',
  option_deadline: 'Option deadline',
  renewal_deadline: 'Renewal deadline',
  loan_maturity: 'Loan maturity',
  rate_reset: 'Rate reset',
  insurance_renewal: 'Insurance renewal',
  tax_appeal: 'Tax appeal',
  cam_reconciliation: 'CAM reconciliation',
}
const labelDate = (t: string) => DATE_LABELS[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

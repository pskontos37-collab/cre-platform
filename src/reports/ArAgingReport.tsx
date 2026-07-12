import { Text, View, pdf } from '@react-pdf/renderer'
import type { ArAgingRow } from '../hooks/useArAging'
import { ReportShell, SectionLabel } from './ReportShell'
import {
  BUCKETS, GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW,
  fmt, pdfSafe, type BucketKey,
} from './theme'

export interface ArAgingReportInput {
  rows: ArAgingRow[]
  notes: Record<string, string>   // keyed "propertyId|mriLeaseId" (see useArNotes)
  reaMris: string[]               // MRI lease ids that are REA parties, not leased tenants
  asOf: string | null
  generatedAt: string
}

// Renders and serializes in the browser; called via dynamic import so
// @react-pdf/renderer stays out of the main bundle.
export async function buildArAgingPdf(input: ArAgingReportInput): Promise<Blob> {
  return pdf(<ArAgingReport {...input} />).toBlob()
}

// ── column layout (landscape letter, 720pt usable) ──────────────────────────
const COL = { status: 46, pmt: 82, current: 56, b30: 52, b60: 52, b90: 52, b120: 52, pastDue: 60, total: 62 }

const eps = (v: number) => Math.abs(v) > 0.005

export function ArAgingReport({ rows, notes, reaMris, asOf, generatedAt }: ArAgingReportInput) {
  const rea = new Set(reaMris)

  const kpi = rows.reduce(
    (t, r) => {
      t.total += r.total; t.current += r.current; t.pastDue += r.pastDue
      t.severe += r.b90 + r.b120
      if (r.total < 0) t.credits += r.total
      return t
    },
    { total: 0, current: 0, pastDue: 0, severe: 0, credits: 0 },
  )

  // group tenants by property, properties by total desc, tenants by past-due desc
  const groups = new Map<string, { name: string; rows: ArAgingRow[]; current: number; b30: number; b60: number; b90: number; b120: number; pastDue: number; total: number }>()
  for (const r of rows) {
    const g = groups.get(r.propertyId) ?? { name: r.propertyName, rows: [], current: 0, b30: 0, b60: 0, b90: 0, b120: 0, pastDue: 0, total: 0 }
    g.rows.push(r)
    g.current += r.current; g.b30 += r.b30; g.b60 += r.b60; g.b90 += r.b90; g.b120 += r.b120
    g.pastDue += r.pastDue; g.total += r.total
    groups.set(r.propertyId, g)
  }
  const properties = Array.from(groups.values()).sort((a, b) => b.total - a.total)
  for (const p of properties) p.rows.sort((a, b) => b.pastDue - a.pastDue)

  return (
    <ReportShell
      kicker="M&J Wilkow · Portfolio Receivables"
      title="Accounts Receivable — Aged Delinquencies"
      subtitle={`${properties.length} ${properties.length === 1 ? 'property' : 'properties'} · ${rows.length} tenant accounts · Source: MRI Aged Delinquencies`}
      metaRight={[asOf ? `As of ${asOf}` : 'As of latest snapshot', `Generated ${generatedAt}`]}
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 18 }}>
        <Kpi label="Total Outstanding" value={fmt(kpi.total)} accent={WILKOW} />
        <Kpi label="Current" value={fmt(kpi.current)} accent={WILKOW} sub={kpi.total > 0 ? `${Math.round((kpi.current / kpi.total) * 100)}% of balance` : undefined} />
        <Kpi label="Past Due · 30d+" value={fmt(kpi.pastDue)} accent="#c2a35a" sub={kpi.total > 0 ? `${Math.round((kpi.pastDue / kpi.total) * 100)}% of balance` : undefined} />
        <Kpi label="At Risk · 90d+" value={fmt(kpi.severe)} accent="#c25b52" />
        <Kpi label="Credits & Prepaids" value={fmt(kpi.credits)} accent={GREEN} last />
      </View>

      {/* ── aging composition by property ── */}
      <SectionLabel>Aging Composition by Property</SectionLabel>
      <View style={{ flexDirection: 'row', marginBottom: 8 }}>
        {BUCKETS.map(b => (
          <View key={b.key} style={{ flexDirection: 'row', alignItems: 'center', marginRight: 14 }}>
            <View style={{ width: 7, height: 7, borderRadius: 1.5, backgroundColor: b.color, marginRight: 4 }} />
            <Text style={{ fontSize: 7, color: TEXT_MUTED }}>{b.label}</Text>
          </View>
        ))}
      </View>
      <View style={{ marginBottom: 16 }}>
        {properties.map(p => {
          const pos = BUCKETS.reduce((s, b) => s + Math.max(p[b.key], 0), 0)
          return (
            <View key={p.name} wrap={false} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
                <Text style={{ fontSize: 8.5, fontFamily: 'Helvetica-Bold' }}>{p.name}</Text>
                <Text style={{ fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED }}>{fmt(p.total)}</Text>
              </View>
              <View style={{ flexDirection: 'row', height: 9, borderRadius: 2, backgroundColor: '#eef1f3', overflow: 'hidden' }}>
                {BUCKETS.map(b => {
                  const v = Math.max(p[b.key], 0)
                  if (pos <= 0 || v <= 0) return null
                  return <View key={b.key} style={{ width: `${(v / pos) * 100}%`, backgroundColor: b.color }} />
                })}
              </View>
              <View style={{ flexDirection: 'row', marginTop: 2, flexWrap: 'wrap' }}>
                {BUCKETS.map(b => eps(p[b.key]) ? (
                  <Text key={b.key} style={{ fontSize: 6.5, color: TEXT_FAINT, marginRight: 12 }}>
                    {b.label}: {fmt(p[b.key])}
                  </Text>
                ) : null)}
              </View>
            </View>
          )
        })}
      </View>

      {/* ── tenant detail, grouped by property ── */}
      <SectionLabel>Tenant Detail</SectionLabel>
      {properties.map(p => (
        <View key={p.name} style={{ marginBottom: 14 }}>
          <View wrap={false} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#eef1f3', borderLeftWidth: 3, borderLeftColor: WILKOW, paddingVertical: 4, paddingHorizontal: 8, marginBottom: 2 }}>
            <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 10, color: WILKOW }}>{p.name}</Text>
            <Text style={{ fontSize: 7.5, color: TEXT_MUTED }}>
              {p.rows.length} accounts · past due {fmt(p.pastDue)} · total {fmt(p.total)}
            </Text>
          </View>
          <HeaderRow />
          {p.rows.map(r => (
            <TenantRow key={r.id} r={r} note={notes[`${r.propertyId}|${r.mriLeaseId}`] ?? null} isRea={r.mriLeaseId != null && rea.has(r.mriLeaseId)} />
          ))}
          <TotalsRow p={p} />
        </View>
      ))}

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 4, lineHeight: 1.5 }}>
        Amounts in parentheses are credits / prepaid balances. Tenants marked REA are parties to a Reciprocal Easement
        Agreement, not leased tenants. Bucket ages reflect MRI invoice dates as of the snapshot date shown above.
      </Text>
    </ReportShell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent, sub, last }: { label: string; value: string; accent: string; sub?: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: TEXT_FAINT, marginBottom: 5 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 13, color: TEXT }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 3 }}>{sub}</Text> : null}
    </View>
  )
}

const hcell = { fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT } as const

function HeaderRow() {
  return (
    <View wrap={false} style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 3, paddingHorizontal: 4 }}>
      <Text style={{ ...hcell, flex: 1 }}>TENANT</Text>
      <Text style={{ ...hcell, width: COL.status }}>STATUS</Text>
      <Text style={{ ...hcell, width: COL.pmt }}>LAST PAYMENT</Text>
      <Text style={{ ...hcell, width: COL.current, textAlign: 'right' }}>CURRENT</Text>
      <Text style={{ ...hcell, width: COL.b30, textAlign: 'right' }}>30D</Text>
      <Text style={{ ...hcell, width: COL.b60, textAlign: 'right' }}>60D</Text>
      <Text style={{ ...hcell, width: COL.b90, textAlign: 'right' }}>90D</Text>
      <Text style={{ ...hcell, width: COL.b120, textAlign: 'right' }}>120D+</Text>
      <Text style={{ ...hcell, width: COL.pastDue, textAlign: 'right' }}>PAST DUE</Text>
      <Text style={{ ...hcell, width: COL.total, textAlign: 'right' }}>TOTAL</Text>
    </View>
  )
}

function Amt({ v, w, color, bold }: { v: number; w: number; color?: string; bold?: boolean }) {
  const zero = !eps(v)
  return (
    <Text style={{
      width: w, textAlign: 'right', fontSize: 7.5,
      fontFamily: bold && !zero ? 'Helvetica-Bold' : 'Helvetica',
      color: zero ? TEXT_FAINT : v < 0 ? GREEN : (color ?? TEXT),
    }}>
      {zero ? '—' : fmt(v)}
    </Text>
  )
}

function TenantRow({ r, note, isRea }: { r: ArAgingRow; note: string | null; isRea: boolean }) {
  const worst = eps(r.b120) ? BUCKETS[4] : eps(r.b90) ? BUCKETS[3] : eps(r.b60) ? BUCKETS[2] : eps(r.b30) ? BUCKETS[1] : null
  const bucketColor = (k: BucketKey) => (eps(r[k]) && r[k] > 0 ? BUCKETS.find(b => b.key === k)?.color : undefined)
  return (
    <View wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: RULE, borderLeftWidth: 2, borderLeftColor: worst ? worst.color : 'transparent', paddingVertical: 3.5, paddingHorizontal: 4 }}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold' }}>{pdfSafe(r.tenantName)}</Text>
          {isRea ? (
            <Text style={{ fontSize: 5.5, fontFamily: 'Helvetica-Bold', color: '#ffffff', backgroundColor: WILKOW, borderRadius: 4, paddingVertical: 1, paddingHorizontal: 4, marginLeft: 5 }}>REA</Text>
          ) : null}
        </View>
        <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 1 }}>
          {[r.suite ? `Suite ${r.suite}` : null, r.mriLeaseId ? `MRI ${r.mriLeaseId}` : null].filter(Boolean).join(' · ') || ' '}
        </Text>
        {note ? <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Oblique', color: '#8a6d3b', marginTop: 1.5 }}>{pdfSafe(note)}</Text> : null}
      </View>
      <Text style={{ width: COL.status, fontSize: 7, color: TEXT_MUTED }}>{r.status ?? '—'}</Text>
      <Text style={{ width: COL.pmt, fontSize: 7, color: TEXT_MUTED }}>
        {r.lastPaymentDate ?? '—'}{r.lastPaymentAmount != null ? `  ${fmt(r.lastPaymentAmount)}` : ''}
      </Text>
      <Amt v={r.current} w={COL.current} />
      <Amt v={r.b30} w={COL.b30} color={bucketColor('b30')} />
      <Amt v={r.b60} w={COL.b60} color={bucketColor('b60')} />
      <Amt v={r.b90} w={COL.b90} color={bucketColor('b90')} />
      <Amt v={r.b120} w={COL.b120} color={bucketColor('b120')} />
      <Amt v={r.pastDue} w={COL.pastDue} color={worst?.color} bold />
      <Amt v={r.total} w={COL.total} bold />
    </View>
  )
}

function TotalsRow({ p }: { p: { name: string; rows: ArAgingRow[]; current: number; b30: number; b60: number; b90: number; b120: number; pastDue: number; total: number } }) {
  return (
    <View wrap={false} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 4, paddingHorizontal: 4, backgroundColor: '#f6f8f9' }}>
      <Text style={{ flex: 1, fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED }}>Property Total</Text>
      <Text style={{ width: COL.status }} />
      <Text style={{ width: COL.pmt }} />
      <Amt v={p.current} w={COL.current} bold />
      <Amt v={p.b30} w={COL.b30} bold />
      <Amt v={p.b60} w={COL.b60} bold />
      <Amt v={p.b90} w={COL.b90} bold />
      <Amt v={p.b120} w={COL.b120} bold />
      <Amt v={p.pastDue} w={COL.pastDue} bold />
      <Amt v={p.total} w={COL.total} bold />
    </View>
  )
}

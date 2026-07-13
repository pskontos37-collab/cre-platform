import { Text, View, pdf } from '@react-pdf/renderer'
import type { Lifecycle } from '../hooks/useServiceAgreements'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, fmt, pdfSafe } from './theme'

// One vendor relationship, flattened for the PDF (see ServiceAgreementsPage.VendorGroup).
export interface SaReportGroup {
  propertyName: string
  vendor: string
  category: string
  lifecycle: Lifecycle
  description: string | null
  termSummary: string | null
  startDate: string | null
  endDate: string | null
  agreementDate: string | null
  pricingSummary: string | null
  annualValue: number | null
  cancelNoticeDays: number | null
  isForm: boolean
}

export interface SaReportInput {
  groups: SaReportGroup[]
  scopeLabel: string       // "All properties" or the single property name
  generatedAt: string
}

// Renders and serializes in the browser; called via dynamic import so
// @react-pdf/renderer stays out of the main bundle.
export async function buildServiceAgreementsPdf(input: SaReportInput): Promise<Blob> {
  return pdf(<ServiceAgreementsReport {...input} />).toBlob()
}

// Lifecycle presentation — mirrors ServiceAgreementsPage. Sections print in this
// order; the two headline groups the report is about (active / expired) lead.
const LC: Record<Lifecycle, { label: string; rank: number; color: string }> = {
  active:     { label: 'Active',           rank: 0, color: GREEN },
  evergreen:  { label: 'Auto-renewing',    rank: 1, color: WILKOW },
  expiring:   { label: 'Expiring soon',    rank: 2, color: '#c2a35a' },
  expired:    { label: 'Expired',          rank: 3, color: '#c25b52' },
  terminated: { label: 'Terminated',       rank: 4, color: TEXT_FAINT },
  unknown:    { label: 'No term on file',  rank: 5, color: TEXT_MUTED },
  superseded: { label: 'Superseded',       rank: 6, color: TEXT_FAINT },
  completed:  { label: 'Completed',        rank: 7, color: TEXT_FAINT },
  cancelled:  { label: 'Cancelled',        rank: 8, color: TEXT_FAINT },
  ignored:    { label: 'Ignored',          rank: 9, color: TEXT_FAINT },
}

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return '—'
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// portrait letter, 540pt usable
const COL = { category: 96, term: 120, annual: 74, expiry: 78 }

export function ServiceAgreementsReport({ groups, scopeLabel, generatedAt }: SaReportInput) {
  const activeCount = groups.filter(g => g.lifecycle === 'active' || g.lifecycle === 'evergreen' || g.lifecycle === 'expiring').length
  const expiredCount = groups.filter(g => g.lifecycle === 'expired' || g.lifecycle === 'terminated').length
  const annualTotal = groups
    .filter(g => g.lifecycle === 'active' || g.lifecycle === 'evergreen' || g.lifecycle === 'expiring')
    .reduce((s, g) => s + (g.annualValue ?? 0), 0)

  // section (lifecycle) -> property -> rows
  const present = (Object.keys(LC) as Lifecycle[])
    .filter(k => groups.some(g => g.lifecycle === k))
    .sort((a, b) => LC[a].rank - LC[b].rank)

  return (
    <ReportShell
      kicker="M&J Wilkow · Property Operations"
      title="Service Agreements — Active & Expired"
      subtitle={`${scopeLabel} · ${groups.length} vendor relationships · ${activeCount} active · ${expiredCount} expired / terminated`}
      metaRight={[`Generated ${generatedAt}`]}
      orientation="portrait"
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 16 }}>
        <Kpi label="Active & Renewing" value={String(activeCount)} accent={GREEN} />
        <Kpi label="Expired / Terminated" value={String(expiredCount)} accent="#c25b52" />
        <Kpi label="Annual Value · Active" value={fmt(annualTotal)} accent={WILKOW} last />
      </View>

      {present.map(lc => {
        const rows = groups.filter(g => g.lifecycle === lc)
        const byProp = new Map<string, SaReportGroup[]>()
        for (const r of rows) (byProp.get(r.propertyName) ?? byProp.set(r.propertyName, []).get(r.propertyName)!).push(r)
        const props = Array.from(byProp.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        return (
          <View key={lc} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: LC[lc].color, marginRight: 6 }} />
              <SectionLabel>{`${LC[lc].label} · ${rows.length}`}</SectionLabel>
            </View>
            {props.map(([propName, list]) => (
              <View key={propName} style={{ marginBottom: 8 }}>
                <View wrap={false} style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#eef1f3', borderLeftWidth: 3, borderLeftColor: WILKOW, paddingVertical: 3, paddingHorizontal: 8, marginBottom: 2 }}>
                  <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 9.5, color: WILKOW }}>{pdfSafe(propName)}</Text>
                  <Text style={{ fontSize: 7.5, color: TEXT_MUTED }}>{list.length} vendor{list.length === 1 ? '' : 's'}</Text>
                </View>
                <HeaderRow />
                {list
                  .sort((a, b) => a.vendor.localeCompare(b.vendor))
                  .map((g, i) => <Row key={`${g.vendor}-${i}`} g={g} accent={LC[lc].color} />)}
              </View>
            ))}
          </View>
        )
      })}

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 4, lineHeight: 1.5 }}>
        One row per vendor relationship (vendor x category at a property); the most recent contract governs and
        prior-year contracts are folded in. Abstracted from executed agreements in the corpus. "Expiring soon"
        means the end date falls within the renewal window. Completed / cancelled / ignored relationships are
        excluded unless present in the current view.
      </Text>
    </ReportShell>
  )
}

function Kpi({ label, value, accent, last }: { label: string; value: string; accent: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: TEXT_FAINT, marginBottom: 5 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14, color: TEXT }}>{value}</Text>
    </View>
  )
}

const hcell = { fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT } as const

function HeaderRow() {
  return (
    <View wrap={false} style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 3, paddingHorizontal: 4 }}>
      <Text style={{ ...hcell, flex: 1 }}>VENDOR</Text>
      <Text style={{ ...hcell, width: COL.category }}>CATEGORY</Text>
      <Text style={{ ...hcell, width: COL.term }}>TERM</Text>
      <Text style={{ ...hcell, width: COL.annual, textAlign: 'right' }}>ANNUAL</Text>
      <Text style={{ ...hcell, width: COL.expiry, textAlign: 'right' }}>EXPIRES</Text>
    </View>
  )
}

function Row({ g, accent }: { g: SaReportGroup; accent: string }) {
  const term = g.termSummary
    ? pdfSafe(g.termSummary)
    : (g.startDate || g.endDate) ? `${fmtDate(g.startDate)} -> ${g.endDate ? fmtDate(g.endDate) : 'open'}` : '—'
  return (
    <View wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: RULE, borderLeftWidth: 2, borderLeftColor: accent, paddingVertical: 3.5, paddingHorizontal: 4 }}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold' }}>{pdfSafe(g.vendor)}</Text>
          {!g.isForm ? (
            <Text style={{ fontSize: 5.5, fontFamily: 'Helvetica-Bold', color: TEXT_FAINT, borderWidth: 0.5, borderColor: RULE, borderRadius: 3, paddingVertical: 0.5, paddingHorizontal: 3, marginLeft: 5 }}>OFF-FORM</Text>
          ) : null}
        </View>
        {g.description ? <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 1.5, lineHeight: 1.4 }}>{pdfSafe(g.description)}</Text> : null}
        {g.pricingSummary ? <Text style={{ fontSize: 6.5, color: TEXT_MUTED, marginTop: 1.5 }}>{pdfSafe(g.pricingSummary)}</Text> : null}
      </View>
      <Text style={{ width: COL.category, fontSize: 7.5, color: TEXT_MUTED }}>{pdfSafe(g.category)}</Text>
      <Text style={{ width: COL.term, fontSize: 7, color: TEXT_MUTED }}>{term}</Text>
      <Text style={{ width: COL.annual, fontSize: 7.5, textAlign: 'right', color: g.annualValue != null ? TEXT : TEXT_FAINT }}>
        {g.annualValue != null ? fmt(g.annualValue) : '—'}
      </Text>
      <Text style={{ width: COL.expiry, fontSize: 7.5, textAlign: 'right', color: WILKOW_MIST }}>{fmtDate(g.endDate)}</Text>
    </View>
  )
}

import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, fmt, pdfSafe } from './theme'

export interface RentRollLine {
  suite: string | null
  tenantName: string | null
  sqft: number
  leaseStart: string | null
  leaseEnd: string | null
  monthlyRent: number
  annualRent: number
  psf: number
  isOccupied: boolean
}

export interface RentRollReportInput {
  propertyName: string
  totalSf: number | null
  asOfLabel: string          // e.g. "June 2026"
  rows: RentRollLine[]
  walt: number
  generatedAt: string
}

export async function buildRentRollPdf(input: RentRollReportInput): Promise<Blob> {
  return pdf(<RentRollReport {...input} />).toBlob()
}

const COL = { suite: 52, sf: 55, start: 64, end: 64, monthly: 68, annual: 76, psf: 48 }
const sfmt = (n: number) => Math.round(n).toLocaleString('en-US')

export function RentRollReport({ propertyName, totalSf, asOfLabel, rows, walt, generatedAt }: RentRollReportInput) {
  const occupied = rows.filter(r => r.isOccupied)
  const vacant = rows.filter(r => !r.isOccupied)
  const leasedSf = occupied.reduce((s, r) => s + r.sqft, 0)
  const vacantSf = vacant.reduce((s, r) => s + r.sqft, 0)
  const annualRent = occupied.reduce((s, r) => s + r.annualRent, 0)
  const avgPsf = leasedSf > 0 ? annualRent / leasedSf : 0
  const occupancy = totalSf && totalSf > 0 ? leasedSf / totalSf : null

  // rollover by lease-expiration year (occupied rows with an end date)
  const yearMap = new Map<number, { sf: number; count: number }>()
  const withEnd = occupied.filter(r => r.leaseEnd)
  for (const r of withEnd) {
    const y = Number((r.leaseEnd as string).slice(0, 4))
    const prev = yearMap.get(y) ?? { sf: 0, count: 0 }
    yearMap.set(y, { sf: prev.sf + r.sqft, count: prev.count + 1 })
  }
  const rolloverSf = withEnd.reduce((s, r) => s + r.sqft, 0)
  const rollover = [...yearMap.entries()].filter(([, v]) => v.sf > 0).sort(([a], [b]) => a - b).slice(0, 12)
  const maxYearSf = Math.max(...rollover.map(([, v]) => v.sf), 1)

  const sorted = [...rows].sort((a, b) => (a.suite ?? '').localeCompare(b.suite ?? '', 'en', { numeric: true }))

  return (
    <ReportShell
      kicker="M&J Wilkow · Rent Roll"
      title={propertyName}
      subtitle={`Rent roll snapshot · ${asOfLabel} · ${occupied.length} occupied ${occupied.length === 1 ? 'suite' : 'suites'}${vacant.length ? ` · ${vacant.length} vacant` : ''} · Source: MRI`}
      metaRight={[`As of ${asOfLabel}`, `Generated ${generatedAt}`]}
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 16 }}>
        <Kpi label="Occupancy" value={occupancy != null ? `${(occupancy * 100).toFixed(1)}%` : '—'} sub={totalSf ? `${sfmt(leasedSf)} of ${sfmt(totalSf)} SF` : undefined} />
        <Kpi label="Annual Base Rent" value={fmt(annualRent)} sub={avgPsf > 0 ? `${fmt(avgPsf)}/SF avg` : undefined} />
        <Kpi label="WALT" value={walt > 0 ? `${walt.toFixed(1)} yrs` : '—'} sub="weighted by SF" />
        <Kpi label="Occupied Suites" value={String(occupied.length)} />
        <Kpi label="Vacant SF" value={vacantSf > 0 ? sfmt(vacantSf) : '—'} last />
      </View>

      {/* ── lease rollover ── */}
      {rollover.length > 0 && (
        <View wrap={false} style={{ marginBottom: 16 }}>
          <SectionLabel>Lease Rollover by Expiration Year</SectionLabel>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            {rollover.map(([year, v]) => (
              <View key={year} style={{ flex: 1, alignItems: 'center', marginRight: 6 }}>
                <Text style={{ fontSize: 6.5, color: TEXT_MUTED, marginBottom: 2 }}>{sfmt(v.sf)} SF</Text>
                <View style={{ width: '100%', height: Math.max(3, (v.sf / maxYearSf) * 42), backgroundColor: WILKOW, borderRadius: 2, opacity: 0.9 }} />
                <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED, marginTop: 3 }}>{year}</Text>
                <Text style={{ fontSize: 6, color: TEXT_FAINT }}>{v.count} {v.count === 1 ? 'lease' : 'leases'} · {rolloverSf > 0 ? Math.round((v.sf / rolloverSf) * 100) : 0}%</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── rent roll table ── */}
      <SectionLabel>Suite Detail</SectionLabel>
      <HeaderRow />
      {sorted.map((r, i) => <SuiteRow key={i} r={r} />)}
      <View wrap={false} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 4, paddingHorizontal: 4, backgroundColor: '#f6f8f9' }}>
        <Text style={{ width: COL.suite, fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED }}>Total</Text>
        <Text style={{ flex: 1, fontSize: 7.5, color: TEXT_FAINT }}>{occupied.length} occupied{vacant.length ? ` · ${vacant.length} vacant` : ''}</Text>
        <Text style={{ width: COL.sf, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold' }}>{sfmt(leasedSf + vacantSf)}</Text>
        <Text style={{ width: COL.start }} />
        <Text style={{ width: COL.end }} />
        <Text style={{ width: COL.monthly, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold' }}>{fmt(occupied.reduce((s, r) => s + r.monthlyRent, 0))}</Text>
        <Text style={{ width: COL.annual, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold' }}>{fmt(annualRent)}</Text>
        <Text style={{ width: COL.psf, textAlign: 'right', fontSize: 7.5, fontFamily: 'Helvetica-Bold' }}>{avgPsf > 0 ? `$${avgPsf.toFixed(2)}` : '—'}</Text>
      </View>

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 6, lineHeight: 1.5 }}>
        Base rent only — excludes recoveries, percentage rent and other charges. Vacant suites shown in gray.
        WALT weighted by leased SF over remaining lease term. Loaded from the MRI rent roll via scripts/load_rentroll.ps1.
      </Text>
    </ReportShell>
  )
}

function Kpi({ label, value, sub, last }: { label: string; value: string; sub?: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: WILKOW, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 }}>
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
      <Text style={{ ...hcell, width: COL.suite }}>SUITE</Text>
      <Text style={{ ...hcell, flex: 1 }}>TENANT</Text>
      <Text style={{ ...hcell, width: COL.sf, textAlign: 'right' }}>SF</Text>
      <Text style={{ ...hcell, width: COL.start, textAlign: 'right' }}>LEASE START</Text>
      <Text style={{ ...hcell, width: COL.end, textAlign: 'right' }}>LEASE END</Text>
      <Text style={{ ...hcell, width: COL.monthly, textAlign: 'right' }}>MONTHLY</Text>
      <Text style={{ ...hcell, width: COL.annual, textAlign: 'right' }}>ANNUAL</Text>
      <Text style={{ ...hcell, width: COL.psf, textAlign: 'right' }}>PSF</Text>
    </View>
  )
}

function SuiteRow({ r }: { r: RentRollLine }) {
  const dim = !r.isOccupied
  const c = dim ? TEXT_FAINT : TEXT
  const expSoon = r.isOccupied && r.leaseEnd != null && r.leaseEnd <= '2027-12-31'
  return (
    <View wrap={false} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 3, paddingHorizontal: 4, backgroundColor: dim ? '#f7f8f9' : undefined }}>
      <Text style={{ width: COL.suite, fontSize: 7.5, color: dim ? TEXT_FAINT : TEXT_MUTED }}>{r.suite ?? '—'}</Text>
      <Text style={{ flex: 1, fontSize: 8, fontFamily: dim ? 'Helvetica-Oblique' : 'Helvetica-Bold', color: c, paddingRight: 8 }}>
        {dim ? 'Vacant' : (r.tenantName ? pdfSafe(r.tenantName) : '—')}
      </Text>
      <Text style={{ width: COL.sf, textAlign: 'right', fontSize: 7.5, color: c }}>{r.sqft > 0 ? sfmt(r.sqft) : '—'}</Text>
      <Text style={{ width: COL.start, textAlign: 'right', fontSize: 7.5, color: dim ? TEXT_FAINT : TEXT_MUTED }}>{r.leaseStart ?? '—'}</Text>
      <Text style={{ width: COL.end, textAlign: 'right', fontSize: 7.5, color: dim ? TEXT_FAINT : expSoon ? '#c25b52' : TEXT_MUTED, fontFamily: expSoon ? 'Helvetica-Bold' : 'Helvetica' }}>{r.leaseEnd ?? '—'}</Text>
      <Text style={{ width: COL.monthly, textAlign: 'right', fontSize: 7.5, color: c }}>{r.monthlyRent > 0 ? fmt(r.monthlyRent) : '—'}</Text>
      <Text style={{ width: COL.annual, textAlign: 'right', fontSize: 7.5, fontFamily: dim ? 'Helvetica' : 'Helvetica-Bold', color: c }}>{r.annualRent > 0 ? fmt(r.annualRent) : '—'}</Text>
      <Text style={{ width: COL.psf, textAlign: 'right', fontSize: 7.5, color: r.psf > 0 ? GREEN : TEXT_FAINT }}>{r.psf > 0 ? `$${r.psf.toFixed(2)}` : '—'}</Text>
    </View>
  )
}

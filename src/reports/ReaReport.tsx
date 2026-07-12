import { Text, View, pdf } from '@react-pdf/renderer'
import type { ReaAgreement } from '../hooks/useRea'
import { ReportShell } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, fmt, pdfSafe } from './theme'

export interface ReaReportInput {
  agreements: ReaAgreement[]
  generatedAt: string
}

export async function buildReaPdf(input: ReaReportInput): Promise<Blob> {
  return pdf(<ReaReport {...input} />).toBlob()
}

const AMBER = '#8a6d3b'

export function ReaReport({ agreements, generatedAt }: ReaReportInput) {
  // group by property, preserving hook order (agreement_date asc within property)
  const byProperty = new Map<string, ReaAgreement[]>()
  for (const a of agreements) {
    const list = byProperty.get(a.propertyName) ?? []
    list.push(a)
    byProperty.set(a.propertyName, list)
  }
  const openItemCount = agreements.filter(a => a.openItems).length

  return (
    <ReportShell
      orientation="portrait"
      kicker="M&J Wilkow · Property Agreements"
      title="Reciprocal Easement Agreements"
      subtitle={`${agreements.length} recorded ${agreements.length === 1 ? 'instrument' : 'instruments'} across ${byProperty.size} ${byProperty.size === 1 ? 'property' : 'properties'}${openItemCount ? ` · ${openItemCount} with open items` : ''} · abstracted from the document corpus`}
      metaRight={[`Generated ${generatedAt}`]}
    >
      {[...byProperty.entries()].map(([propName, list]) => (
        <View key={propName} style={{ marginBottom: 6 }}>
          <View wrap={false} style={{ backgroundColor: '#eef1f3', borderLeftWidth: 3, borderLeftColor: WILKOW, paddingVertical: 4, paddingHorizontal: 8, marginBottom: 8 }}>
            <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 11, color: WILKOW }}>{propName}</Text>
          </View>
          {list.map(a => <Agreement key={a.id} a={a} />)}
        </View>
      ))}

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 4, lineHeight: 1.5 }}>
        Member A/R balances are live joins from the latest MRI aged-delinquencies snapshot (parenthesized amounts are
        credits). Abstracts summarize the recorded instruments — consult the source documents before relying on any term.
      </Text>
    </ReportShell>
  )
}

function Agreement({ a }: { a: ReaAgreement }) {
  return (
    <View style={{ borderWidth: 0.75, borderColor: RULE, borderLeftWidth: 2.5, borderLeftColor: WILKOW_MIST, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 10 }}>
      {/* title row — keep with at least the operator/members start */}
      <View wrap={false}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 10.5, color: TEXT, flex: 1, paddingRight: 8 }}>{a.name}</Text>
          <Text style={{ fontSize: 7, color: TEXT_FAINT }}>{pdfSafe([a.agreementDate, a.termSummary].filter(Boolean).join(' · '))}</Text>
        </View>
        {a.operator ? (
          <Text style={{ fontSize: 7.5, color: TEXT_MUTED, marginTop: 3 }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: WILKOW_MIST }}>OPERATOR  </Text>{pdfSafe(a.operator)}
          </Text>
        ) : null}
      </View>

      {a.members.length > 0 && (
        <View style={{ marginTop: 7 }}>
          <Label>Parties & Tracts</Label>
          <View style={{ flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: RULE, paddingBottom: 2 }}>
            <Text style={{ ...hcell, flex: 1 }}>PARTY</Text>
            <Text style={{ ...hcell, width: 100 }}>ROLE</Text>
            <Text style={{ ...hcell, width: 105 }}>TRACT</Text>
            <Text style={{ ...hcell, width: 88 }}>MRI</Text>
            <Text style={{ ...hcell, width: 60, textAlign: 'right' }}>A/R</Text>
          </View>
          {a.members.map((m, i) => (
            <View key={i} wrap={false} style={{ borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 2.5 }}>
              <View style={{ flexDirection: 'row' }}>
                <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT, flex: 1, paddingRight: 6 }}>{pdfSafe(m.name)}</Text>
                <Text style={{ fontSize: 7, color: TEXT_MUTED, width: 100 }}>{m.role ? pdfSafe(m.role) : '—'}</Text>
                <Text style={{ fontSize: 7, color: TEXT_MUTED, width: 105 }}>{m.tract ? pdfSafe(m.tract) : '—'}</Text>
                <Text style={{ fontSize: 7, color: TEXT_FAINT, width: 88 }}>{m.mri ?? '—'}</Text>
                <Text style={{ fontSize: 7.5, width: 60, textAlign: 'right', fontFamily: 'Helvetica-Bold', color: m.arTotal == null ? TEXT_FAINT : m.arTotal < 0 ? GREEN : m.arTotal > 0 ? AMBER : TEXT_FAINT }}>
                  {m.arTotal != null ? fmt(m.arTotal) : '—'}
                </Text>
              </View>
              {m.note ? <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Oblique', color: AMBER, marginTop: 1.5 }}>{pdfSafe(m.note)}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {a.costSharing ? <Narrative label="Cost Sharing" text={a.costSharing} /> : null}
      {a.keyProvisions ? <Narrative label="Key Provisions" text={a.keyProvisions} /> : null}
      {a.amendments ? <Narrative label="Amendments & Consents" text={a.amendments} /> : null}

      {a.openItems ? (
        <View wrap={false} style={{ marginTop: 7, backgroundColor: '#faf6ec', borderWidth: 0.75, borderColor: '#e4d9b8', borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: AMBER, marginBottom: 2 }}>OPEN ITEMS</Text>
          <Text style={{ fontSize: 7.5, color: TEXT, lineHeight: 1.5 }}>{pdfSafe(a.openItems)}</Text>
        </View>
      ) : null}

      {a.sourceDocs.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={{ fontSize: 6.5, color: TEXT_FAINT }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: WILKOW_MIST }}>SOURCES  </Text>
            {pdfSafe(a.sourceDocs.map(d => d.title).join(' · '))}
          </Text>
        </View>
      )}
    </View>
  )
}

const hcell = { fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT } as const

function Label({ children }: { children: string }) {
  return <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: WILKOW_MIST, marginBottom: 3 }}>{children.toUpperCase()}</Text>
}

function Narrative({ label, text }: { label: string; text: string }) {
  return (
    <View style={{ marginTop: 7 }}>
      <Label>{label}</Label>
      <Text style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.55 }}>{pdfSafe(text)}</Text>
    </View>
  )
}

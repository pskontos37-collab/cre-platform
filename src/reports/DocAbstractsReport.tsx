import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell, SectionLabel } from './ReportShell'
import { RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, fmt, pdfSafe } from './theme'

// One document's narrative abstract, as stored in doc_abstracts.abstract.
export interface DocAbstractItem {
  docTitle: string
  docType: string | null
  roleLabel: string | null
  abstract: any
}

export interface DocAbstractsReportInput {
  title: string
  subtitle: string
  scopeLabel: string
  generatedAt: string
  items: DocAbstractItem[]
}

export async function buildDocAbstractsPdf(input: DocAbstractsReportInput): Promise<Blob> {
  return pdf(<DocAbstractsReport {...input} />).toBlob()
}

const s = (v: unknown): string => (v == null ? '' : String(v))
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

const PREFIX_COLOR = (line: string) =>
  /^DISCREPANCY/i.test(line) ? '#c25b52'
  : /^MISSING FROM FILE/i.test(line) ? '#c2a35a'
  : /^CONFIRM/i.test(line) ? WILKOW
  : TEXT_MUTED

export function DocAbstractsReport({ title, subtitle, scopeLabel, generatedAt, items }: DocAbstractsReportInput) {
  return (
    <ReportShell
      kicker="M&J Wilkow · Document Abstracts"
      title={title}
      subtitle={subtitle}
      metaRight={[scopeLabel, `Generated ${generatedAt}`]}
      orientation="portrait"
    >
      {items.length === 0 ? (
        <Text style={{ fontSize: 9, color: TEXT_FAINT }}>No abstracts available.</Text>
      ) : items.map((it, i) => <AbstractBlock key={i} item={it} last={i === items.length - 1} />)}
    </ReportShell>
  )
}

function AbstractBlock({ item, last }: { item: DocAbstractItem; last: boolean }) {
  const a = item.abstract ?? {}
  const parties = arr(a.parties)
  const keyTerms = arr(a.key_terms)
  const dates = arr(a.dates)
  const fin = arr(a.financial_terms)
  const obligations = arr(a.obligations)
  const openItems = arr(a.open_items)

  return (
    <View style={{ marginBottom: last ? 0 : 18 }} wrap={true}>
      {/* document heading */}
      <View wrap={false} style={{ borderLeftWidth: 3, borderLeftColor: WILKOW, backgroundColor: '#eef1f3', paddingVertical: 5, paddingHorizontal: 8, marginBottom: 6 }}>
        <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 11, color: WILKOW }}>{pdfSafe(s(a.doc_title) || item.docTitle)}</Text>
        <Text style={{ fontSize: 7, color: TEXT_MUTED, marginTop: 2 }}>
          {[item.roleLabel, s(a.doc_type) || item.docType, s(a.effective_date) ? `effective ${s(a.effective_date)}` : null].filter(Boolean).map(x => pdfSafe(String(x))).join('  ·  ')}
        </Text>
      </View>

      {parties.length > 0 && (
        <Text style={{ fontSize: 8, color: TEXT_MUTED, marginBottom: 6 }}>
          {parties.map((p: any) => `${pdfSafe(s(p.role))}: ${pdfSafe(s(p.name))}`).filter(Boolean).join('   |   ')}
        </Text>
      )}

      {s(a.summary) ? (
        <Text style={{ fontSize: 9, color: TEXT, lineHeight: 1.5, marginBottom: 8 }}>{pdfSafe(s(a.summary))}</Text>
      ) : null}

      {keyTerms.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <SectionLabel>Key Terms</SectionLabel>
          {keyTerms.map((t: any, i: number) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 2.5, paddingHorizontal: 2 }}>
              <Text style={{ width: 120, fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT_MUTED }}>{pdfSafe(s(t.label))}</Text>
              <Text style={{ flex: 1, fontSize: 7.5, color: TEXT }}>
                {pdfSafe(s(t.detail))}{s(t.section) ? <Text style={{ color: TEXT_FAINT }}>{`  (${pdfSafe(s(t.section))})`}</Text> : null}
              </Text>
            </View>
          ))}
        </View>
      )}

      {(dates.length > 0 || fin.length > 0) && (
        <View style={{ flexDirection: 'row', marginBottom: 8, gap: 16 }}>
          {dates.length > 0 && (
            <View style={{ flex: 1 }}>
              <SectionLabel>Key Dates</SectionLabel>
              {dates.map((d: any, i: number) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 1.5 }}>
                  <Text style={{ fontSize: 7.5, color: TEXT_MUTED, flex: 1, paddingRight: 6 }}>{pdfSafe(s(d.label))}</Text>
                  <Text style={{ fontSize: 7.5, color: TEXT }}>{pdfSafe(s(d.date))}</Text>
                </View>
              ))}
            </View>
          )}
          {fin.length > 0 && (
            <View style={{ flex: 1 }}>
              <SectionLabel>Financial Terms</SectionLabel>
              {fin.map((f: any, i: number) => (
                <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 1.5 }}>
                  <Text style={{ fontSize: 7.5, color: TEXT_MUTED, flex: 1, paddingRight: 6 }}>{pdfSafe(s(f.label))}</Text>
                  <Text style={{ fontSize: 7.5, color: TEXT }}>
                    {typeof f.amount === 'number' ? fmt(f.amount) : pdfSafe(s(f.text))}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {obligations.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <SectionLabel>Obligations</SectionLabel>
          {obligations.map((o: any, i: number) => (
            <Text key={i} style={{ fontSize: 7.5, color: TEXT, marginBottom: 1.5 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT_MUTED }}>{pdfSafe(s(o.party))}: </Text>
              {pdfSafe(s(o.obligation))}{s(o.section) ? <Text style={{ color: TEXT_FAINT }}>{`  (${pdfSafe(s(o.section))})`}</Text> : null}
            </Text>
          ))}
        </View>
      )}

      {s(a.notes) ? (
        <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique', color: TEXT_MUTED, marginBottom: 6 }}>{pdfSafe(s(a.notes))}</Text>
      ) : null}

      {openItems.length > 0 && (
        <View style={{ borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 4, marginBottom: 4 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: WILKOW_MIST, marginBottom: 3 }}>OPEN ITEMS</Text>
          {openItems.map((line: string, i: number) => (
            <Text key={i} style={{ fontSize: 7, color: PREFIX_COLOR(String(line)), marginBottom: 1 }}>• {pdfSafe(String(line))}</Text>
          ))}
        </View>
      )}

      {!last && <View style={{ borderBottomWidth: 0.5, borderBottomColor: RULE, marginTop: 6 }} />}
    </View>
  )
}

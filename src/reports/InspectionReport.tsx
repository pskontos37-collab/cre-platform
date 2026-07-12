import type { ReactNode } from 'react'
import { Document, Page, Text, View, Image, pdf } from '@react-pdf/renderer'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, pdfSafe } from './theme'
import { sectionAverages, type SectionResponse, type ScoreSummary } from '../lib/inspection'

export interface InspectionReportInput {
  propertyName: string
  formTitle: string
  formVersion: string
  inspectionDate: string
  inspectedBy: string
  weather: string
  specialEvents: string
  sections: SectionResponse[]
  photosByItem: Record<number, string[]>   // item number -> image data URLs (embedded)
  comments: string
  actionItems: string
  score: ScoreSummary
  generatedAt: string
}

export async function buildInspectionPdf(input: InspectionReportInput): Promise<Blob> {
  return pdf(<InspectionReport {...input} />).toBlob()
}

const scoreColor = (s: number | null): string => {
  switch (s) {
    case 1: return '#8e3d3d'
    case 2: return '#c25b52'
    case 3: return '#c2a35a'
    case 4: return '#4e8f60'
    case 5: return '#3f7d54'
    default: return TEXT_FAINT
  }
}
const ratingLabel = (a: number | null) => a == null ? '—' : a >= 4.5 ? 'Excellent' : a >= 3.5 ? 'Good' : a >= 2.5 ? 'Fair' : 'Needs Attention'
const avgColor = (a: number | null) => scoreColor(a == null ? null : Math.round(a))

const PAGE = { size: 'LETTER' as const, style: { paddingTop: 78, paddingBottom: 46, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 9, color: TEXT } }

function Header({ title, sub }: { title: string; sub: string }) {
  return (
    <View fixed style={{ position: 'absolute', top: 24, left: 40, right: 40, borderBottomWidth: 1.5, borderBottomColor: WILKOW, paddingBottom: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <Text style={{ fontSize: 6.5, letterSpacing: 2.2, color: WILKOW_MIST, fontFamily: 'Helvetica-Bold' }}>M&J WILKOW · PROPERTY INSPECTION</Text>
        <Text style={{ fontSize: 7, color: TEXT_FAINT }}>{pdfSafe(sub)}</Text>
      </View>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 11, color: WILKOW, marginTop: 3 }}>{pdfSafe(title)}</Text>
    </View>
  )
}

function Footer() {
  return (
    <View fixed style={{ position: 'absolute', bottom: 22, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: RULE, paddingTop: 5 }}>
      <Text style={{ fontSize: 6.5, color: WILKOW_MIST }}>M&J Wilkow · Confidential — internal use only</Text>
      <Text style={{ fontSize: 6.5, color: WILKOW_MIST }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  )
}

export function InspectionReport(p: InspectionReportInput) {
  const avg = p.score.average
  const secAvgs = sectionAverages(p.sections)
  const heroPhoto = Object.values(p.photosByItem).flat()[0] ?? null
  const headerSub = `${p.propertyName} · ${p.inspectionDate}`

  const flagged = p.sections.flatMap(sec =>
    sec.items.filter(it => !it.na && (it.score === 1 || it.score === 2 || it.score === 5))
      .map(it => ({ section: sec.title, n: it.n, label: it.label, score: it.score as number, detail: it.detail })))

  const gallery = p.sections.flatMap(sec =>
    sec.items.filter(it => (p.photosByItem[it.n]?.length ?? 0) > 0)
      .map(it => ({ section: sec.title, n: it.n, label: it.label, urls: p.photosByItem[it.n] })))

  return (
    <Document title={`${p.formTitle} — ${p.propertyName}`} author="M&J Wilkow" creator="M&J Wilkow Asset Management Platform">
      {/* ── COVER ── */}
      <Page size={PAGE.size} style={{ ...PAGE.style, paddingTop: 40 }}>
        <View style={{ borderBottomWidth: 2, borderBottomColor: WILKOW, paddingBottom: 10, marginBottom: 20 }}>
          <Text style={{ fontSize: 8, letterSpacing: 3, color: WILKOW_MIST, fontFamily: 'Helvetica-Bold' }}>M&J WILKOW · PROPERTY INSPECTION REPORT</Text>
        </View>

        <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: WILKOW }}>{pdfSafe(p.formTitle)}</Text>
        <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, color: TEXT, marginTop: 6 }}>{pdfSafe(p.propertyName)}</Text>
        <Text style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 8 }}>
          Inspected {p.inspectionDate}{p.inspectedBy ? `  ·  by ${pdfSafe(p.inspectedBy)}` : ''}{p.formVersion ? `  ·  ${p.formVersion} form` : ''}
        </Text>

        {/* score hero */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 24, marginBottom: 20 }}>
          <View style={{ width: 128, height: 128, borderRadius: 64, borderWidth: 6, borderColor: avgColor(avg), alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 40, color: TEXT }}>{avg == null ? '—' : avg.toFixed(1)}</Text>
            <Text style={{ fontSize: 8, color: TEXT_FAINT, marginTop: -2 }}>of 5.00</Text>
          </View>
          <View style={{ marginLeft: 24, flex: 1 }}>
            <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 20, color: avgColor(avg) }}>{ratingLabel(avg)}</Text>
            <View style={{ flexDirection: 'row', marginTop: 12 }}>
              <Stat label="Items Scored" value={String(p.score.scored)} />
              <Stat label="Flagged" value={String(p.score.flagged)} accent={p.score.flagged ? '#c25b52' : undefined} />
              <Stat label="Sections" value={String(p.sections.length)} last />
            </View>
          </View>
        </View>

        {heroPhoto ? (
          <Image src={heroPhoto} style={{ width: '100%', height: 300, objectFit: 'cover', borderRadius: 6 }} />
        ) : (
          <View style={{ borderWidth: 1, borderColor: RULE, borderRadius: 6, height: 120, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 9, color: TEXT_FAINT }}>No photos attached</Text>
          </View>
        )}

        {(p.weather.trim() || p.specialEvents.trim()) ? (
          <View style={{ flexDirection: 'row', marginTop: 16 }}>
            {p.weather.trim() ? <Meta label="Weather" value={p.weather} /> : null}
            {p.specialEvents.trim() ? <Meta label="Special Events / Promotions" value={p.specialEvents} /> : null}
          </View>
        ) : null}

        <Footer />
      </Page>

      {/* ── EXECUTIVE SUMMARY ── */}
      <Page size={PAGE.size} style={PAGE.style}>
        <Header title={p.formTitle} sub={headerSub} />

        <Label>Section Scores</Label>
        <View style={{ marginBottom: 18 }}>
          {secAvgs.map(s => (
            <View key={s.title} style={{ marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                <Text style={{ fontSize: 8.5, color: TEXT }}>{pdfSafe(s.title)}</Text>
                <Text style={{ fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: avgColor(s.average) }}>{s.average == null ? 'N/A' : s.average.toFixed(2)}</Text>
              </View>
              <View style={{ height: 7, borderRadius: 2, backgroundColor: '#eef1f3', overflow: 'hidden' }}>
                {s.average != null ? <View style={{ width: `${(s.average / 5) * 100}%`, height: 7, backgroundColor: avgColor(s.average) }} /> : null}
              </View>
            </View>
          ))}
        </View>

        <Label>Items Needing Attention {flagged.length ? `(${flagged.length})` : ''}</Label>
        {flagged.length ? (
          <View style={{ marginBottom: 18 }}>
            {flagged.map((f, i) => (
              <View key={i} wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 4 }}>
                <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#fff', backgroundColor: scoreColor(f.score), borderRadius: 3, width: 16, textAlign: 'center', paddingVertical: 1, marginTop: 1 }}>{f.score}</Text>
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={{ fontSize: 8.5, color: TEXT }}><Text style={{ color: TEXT_FAINT }}>{pdfSafe(f.section)} · #{f.n}  </Text>{pdfSafe(f.label)}</Text>
                  {f.detail.trim() ? <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Oblique', color: TEXT_MUTED, marginTop: 1.5 }}>{pdfSafe(f.detail)}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Text style={{ fontSize: 9, color: GREEN, marginBottom: 18 }}>No items were flagged (nothing scored 1, 2 or 5).</Text>
        )}

        {p.actionItems.trim() ? (<><Label>Action Items</Label><Text style={{ fontSize: 9, color: TEXT, lineHeight: 1.5, marginBottom: 16 }}>{pdfSafe(p.actionItems)}</Text></>) : null}
        {p.comments.trim() ? (<><Label>Comments</Label><Text style={{ fontSize: 9, color: TEXT, lineHeight: 1.5 }}>{pdfSafe(p.comments)}</Text></>) : null}

        <Footer />
      </Page>

      {/* ── DETAILED SCORECARD ── */}
      <Page size={PAGE.size} style={PAGE.style}>
        <Header title={p.formTitle} sub={headerSub} />
        <Label>Detailed Scorecard</Label>
        {p.sections.map(sec => {
          const secAvg = secAvgs.find(s => s.title === sec.title)?.average ?? null
          return (
            <View key={sec.title} style={{ marginBottom: 10 }} wrap={false}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#eef1f3', borderLeftWidth: 3, borderLeftColor: WILKOW, paddingVertical: 4, paddingHorizontal: 8, marginBottom: 2 }}>
                <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 10, color: WILKOW }}>{pdfSafe(sec.title)}</Text>
                <Text style={{ fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: avgColor(secAvg) }}>{secAvg == null ? 'N/A' : `${secAvg.toFixed(2)} / 5`}</Text>
              </View>
              {sec.items.map(it => {
                const blank = it.score == null && !it.na && !it.detail.trim()
                if (blank) return null
                return (
                  <View key={it.n} style={{ flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 3.5, paddingHorizontal: 4 }}>
                    <Text style={{ width: 16, fontSize: 7.5, color: TEXT_FAINT }}>{it.n}</Text>
                    <View style={{ flex: 1, paddingRight: 6 }}>
                      <Text style={{ fontSize: 8, color: TEXT }}>{pdfSafe(it.label)}</Text>
                      {it.detail.trim() ? <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique', color: TEXT_MUTED, marginTop: 1.5 }}>{pdfSafe(it.detail)}</Text> : null}
                    </View>
                    <Text style={{ width: 26, fontSize: 7.5, textAlign: 'center', color: TEXT_MUTED }}>{it.na ? 'N/A' : it.yn ? it.yn.toUpperCase() : '—'}</Text>
                    <View style={{ width: 22, alignItems: 'center' }}>
                      {it.na ? <Text style={{ fontSize: 7.5, color: TEXT_FAINT }}>—</Text>
                        : <Text style={{ fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: '#fff', textAlign: 'center', backgroundColor: scoreColor(it.score), borderRadius: 3, width: 16, paddingVertical: 1 }}>{it.score ?? '·'}</Text>}
                    </View>
                  </View>
                )
              })}
            </View>
          )
        })}
        <Footer />
      </Page>

      {/* ── PHOTO GALLERY ── */}
      {gallery.length ? (
        <Page size={PAGE.size} style={PAGE.style}>
          <Header title={p.formTitle} sub={headerSub} />
          <Label>Photo Documentation</Label>
          {gallery.map((g, gi) => (
            <View key={gi} style={{ marginBottom: 12 }} wrap={false}>
              <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: WILKOW, marginBottom: 4 }}>{pdfSafe(g.section)} · #{g.n}  <Text style={{ fontFamily: 'Helvetica', color: TEXT_MUTED }}>{pdfSafe(g.label)}</Text></Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {g.urls.map((src, i) => (
                  <Image key={i} src={src} style={{ width: 246, height: 168, objectFit: 'cover', borderRadius: 4, marginRight: 6, marginBottom: 6 }} />
                ))}
              </View>
            </View>
          ))}
          <Footer />
        </Page>
      ) : null}
    </Document>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.6, color: WILKOW_MIST, marginBottom: 8 }}>{typeof children === 'string' ? children.toUpperCase() : children}</Text>
}

function Stat({ label, value, accent, last }: { label: string; value: string; accent?: string; last?: boolean }) {
  return (
    <View style={{ marginRight: last ? 0 : 20 }}>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 18, color: accent ?? TEXT }}>{value}</Text>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT, marginTop: 2 }}>{label.toUpperCase()}</Text>
    </View>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, paddingRight: 12 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: TEXT_FAINT, marginBottom: 2 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontSize: 9, color: TEXT }}>{pdfSafe(value)}</Text>
    </View>
  )
}

import type { ReactNode } from 'react'
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { RULE, SERIF, TEXT, TEXT_MUTED, WILKOW, WILKOW_MIST } from './theme'

// Shared Wilkow-branded PDF chrome: landscape letter, letterhead repeated on
// every page, footer with page numbers. Report bodies render as children.
export function ReportShell({ kicker, title, subtitle, metaRight, orientation = 'landscape', pageNumbers = true, children }: {
  kicker: string
  title: string
  subtitle?: string
  metaRight?: string[]
  orientation?: 'landscape' | 'portrait'
  // Set false when the doc is one tenant of a larger merged pack — page numbers
  // are stamped globally after merge (buildAbstractsPackPdf) instead.
  pageNumbers?: boolean
  children: ReactNode
}) {
  return (
    <Document title={title} author="M&J Wilkow" creator="M&J Wilkow Asset Management Platform">
      <Page
        size="LETTER"
        orientation={orientation}
        style={{ paddingTop: 92, paddingBottom: 50, paddingHorizontal: 36, fontFamily: 'Helvetica', fontSize: 8.5, color: TEXT }}
      >
        {/* ── letterhead (repeats on every page) ── */}
        <View fixed style={{ position: 'absolute', top: 26, left: 36, right: 36, borderBottomWidth: 2, borderBottomColor: WILKOW, paddingBottom: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View>
              <Text style={{ fontSize: 7, letterSpacing: 2.4, color: WILKOW_MIST, fontFamily: 'Helvetica-Bold', marginBottom: 5 }}>
                {kicker.toUpperCase()}
              </Text>
              <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 17, color: WILKOW }}>{title}</Text>
              {subtitle ? <Text style={{ fontSize: 8, color: TEXT_MUTED, marginTop: 4 }}>{subtitle}</Text> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {(metaRight ?? []).map((m, i) => (
                <Text key={i} style={{ fontSize: 7.5, color: TEXT_MUTED, marginBottom: 2 }}>{m}</Text>
              ))}
            </View>
          </View>
        </View>

        {children}

        {/* ── footer (repeats on every page) ── */}
        <View fixed style={{ position: 'absolute', bottom: 24, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: RULE, paddingTop: 6 }}>
          <Text style={{ fontSize: 7, color: WILKOW_MIST }}>M&J Wilkow · Confidential — internal use only</Text>
          {pageNumbers
            ? <Text style={{ fontSize: 7, color: WILKOW_MIST }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
            : <Text />}
        </View>
      </Page>
    </Document>
  )
}

export function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', letterSpacing: 1.8, color: WILKOW_MIST, marginBottom: 6 }}>
      {children.toUpperCase()}
    </Text>
  )
}

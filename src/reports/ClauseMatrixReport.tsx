import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell } from './ReportShell'
import type { AbstractDoc } from './AbstractReport'
import { RULE, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, pdfSafe } from './theme'

export interface ClauseMatrixInput {
  title: string
  subtitle: string
  docs: AbstractDoc[]
  generatedAt: string
}

export async function buildClauseMatrixPdf(input: ClauseMatrixInput): Promise<Blob> {
  return pdf(<ClauseMatrixReport {...input} />).toBlob()
}

const trunc = (s: string, n = 260) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const cell = (v: string) => pdfSafe(trunc(v)).trim()

// Curated comparison columns (a subset of the abstract's key clauses) plus a
// leading tenant column. Widths sum to ~720pt (landscape letter usable width).
const COLS: Array<{ label: string; width: number; get: (a: any) => string }> = [
  { label: 'Tenant', width: 88, get: () => '' }, // filled from doc, not abstract
  { label: 'Co-tenancy', width: 120, get: a => a?.co_tenancy?.exists ? `${a.co_tenancy.exact_language_and_remedies ?? ''}${a.co_tenancy.section ? ` [${a.co_tenancy.section}]` : ''}` : 'None' },
  { label: 'Exclusives', width: 112, get: a => a?.exclusives?.exists ? `${a.exclusives.exact_language ?? ''}${a.exclusives.section ? ` [${a.exclusives.section}]` : ''}` : 'None' },
  { label: 'Options', width: 96, get: a => Array.isArray(a?.options) && a.options.length ? a.options.map((o: any) => `${o.term}${o.notice_period ? ` (notice ${o.notice_period})` : ''}`).join('; ') : 'None' },
  { label: '% Rent', width: 78, get: a => a?.percentage_rent?.applicable ? `${a.percentage_rent.rate_pct ?? '?'}% over ${a.percentage_rent.breakpoint ?? '?'}` : 'None' },
  { label: 'Termination / kickout', width: 116, get: a => a?.termination_kickout?.exists ? (a.termination_kickout.details ?? 'Yes') : 'None' },
  { label: 'Permitted use', width: 0, get: a => a?.permitted_use?.exact_language ?? '—' },
]

export function ClauseMatrixReport({ title, subtitle, docs, generatedAt }: ClauseMatrixInput) {
  const rows = [...docs].sort((a, b) => a.tenantName.localeCompare(b.tenantName))
  const w = (x: number): any => (x === 0 ? { flex: 1 } : { width: x })

  return (
    <ReportShell
      kicker="M&J Wilkow · Lease Abstracts"
      title={title}
      subtitle={subtitle}
      metaRight={[`Generated ${generatedAt}`, `${rows.length} ${rows.length === 1 ? 'tenant' : 'tenants'}`]}
    >
      {/* header row (repeats via fixed) */}
      <View fixed style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingBottom: 3, marginBottom: 1 }}>
        {COLS.map((c, i) => (
          <Text key={i} style={{ ...w(c.width), fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, color: TEXT_FAINT, paddingRight: 6 }}>
            {c.label.toUpperCase()}
          </Text>
        ))}
      </View>

      {rows.map((d, ri) => (
        <View key={ri} wrap={false} style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 4, backgroundColor: ri % 2 ? '#f7f8f9' : undefined }}>
          {COLS.map((c, ci) => (
            <Text key={ci} style={{ ...w(c.width), fontSize: 7, color: ci === 0 ? TEXT : TEXT_MUTED, fontFamily: ci === 0 ? 'Helvetica-Bold' : 'Helvetica', paddingRight: 6, lineHeight: 1.35 }}>
              {ci === 0 ? pdfSafe(d.tenantName) : cell(c.get(d.abstract ?? {}))}
            </Text>
          ))}
        </View>
      ))}

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 8, lineHeight: 1.5 }}>
        Cells summarize each clause (long language truncated). For exact wording and section citations, use the full
        abstract pack. "None" means the reviewed documents contained no such clause. Generated from lease_abstracts.
      </Text>
      {rows.length === 0 && (
        <Text style={{ fontSize: 9, color: TEXT_MUTED, marginTop: 12 }}>No abstracts in the selected scope.</Text>
      )}
    </ReportShell>
  )
}

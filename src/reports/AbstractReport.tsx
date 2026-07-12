import type { ReactNode } from 'react'
import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell } from './ReportShell'
import { RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, pdfSafe } from './theme'

// One abstracted lease, as stored in lease_abstracts.abstract (jsonb).
export interface AbstractDoc {
  propertyName: string
  tenantName: string
  abstract: any
  generatedAt: string | null
  sourceDocCount: number
}

export interface AbstractsReportInput {
  title: string          // e.g. "Lease Abstracts — KM East" or a single tenant name
  subtitle: string
  docs: AbstractDoc[]
  generatedAt: string
  showPropertyHeadings: boolean   // true when the pack spans multiple properties
  pageNumbers?: boolean
  totalCount?: number             // pack total (sub-docs render one tenant but show the pack count)
}

export async function buildAbstractsPdf(input: AbstractsReportInput): Promise<Blob> {
  return pdf(<AbstractsReport {...input} />).toBlob()
}

// Memory-safe pack builder. A single react-pdf document holding dozens of full
// abstracts (hundreds of pages) OOMs / hangs the tab intermittently. Instead we
// render each tenant's abstract on its own (small, reliable — same as the
// single-tenant export) and concatenate the resulting PDFs with pdf-lib, then
// stamp global page numbers. Handles 1..N tenants uniformly and never builds one
// giant tree. pdf-lib is dynamic-imported so it stays out of the main bundle.
export async function buildAbstractsPackPdf(input: AbstractsReportInput): Promise<Blob> {
  const { docs, ...rest } = input
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const merged = await PDFDocument.create()
  const footFont = await merged.embedFont(StandardFonts.Helvetica)

  const addBlob = async (blob: Blob) => {
    const src = await PDFDocument.load(await blob.arrayBuffer())
    const pages = await merged.copyPages(src, src.getPageIndices())
    for (const p of pages) merged.addPage(p)
  }

  // Render in batches: one react-pdf document per ~20 tenants. A 20-tenant doc
  // renders reliably (a 24-tenant property pack does), while ~5 batch passes for
  // a 98-tenant portfolio is far faster than 98 separate renders — and fonts
  // dedupe within each batch, so the merged file carries a few font subsets
  // rather than one per tenant. If a batch throws (one malformed abstract), it
  // is re-rendered tenant-by-tenant, substituting a placeholder for any failure.
  const BATCH = 20
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH)
    try {
      await addBlob(await pdf(<AbstractsReport {...rest} docs={batch} pageNumbers={false} totalCount={docs.length} />).toBlob())
    } catch (err) {
      console.warn('[pdf-report] batch render failed, falling back per-tenant', err)
      for (const d of batch) {
        try {
          await addBlob(await pdf(<AbstractsReport {...rest} docs={[d]} pageNumbers={false} totalCount={docs.length} />).toBlob())
        } catch (err2) {
          console.warn('[pdf-report] placeholder for', d.tenantName, err2)
          await addBlob(await pdf(<AbstractPlaceholder title={rest.title} subtitle={rest.subtitle} tenantName={d.tenantName} />).toBlob())
        }
      }
    }
  }

  // Global "Page i of N" bottom-right, aligned with the shell footer.
  const total = merged.getPageCount()
  merged.getPages().forEach((p, i) => {
    const { width } = p.getSize()
    p.drawText(`Page ${i + 1} of ${total}`, {
      x: width - 96, y: 26, size: 7, font: footFont, color: rgb(0.561, 0.635, 0.678),
    })
  })

  const bytes = await merged.save()
  return new Blob([bytes], { type: 'application/pdf' })
}

// Fallback page when one tenant's abstract can't be rendered — keeps the pack
// intact and tells the reader where to look.
function AbstractPlaceholder({ title, subtitle, tenantName }: { title: string; subtitle: string; tenantName: string }) {
  return (
    <ReportShell orientation="portrait" kicker="M&J Wilkow · Lease Abstracts" title={title} subtitle={subtitle} pageNumbers={false}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: WILKOW, paddingBottom: 6, marginBottom: 8 }}>
        <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14, color: TEXT }}>{pdfSafe(tenantName)}</Text>
      </View>
      <Text style={{ fontSize: 8.5, color: TEXT_MUTED, lineHeight: 1.5 }}>
        This abstract could not be rendered to PDF (unexpected data format). View it on screen in the Abstracts
        panel, or Regenerate it, then re-export. The rest of the pack is unaffected.
      </Text>
    </ReportShell>
  )
}

const P = (v: any) => (v == null || v === '' ? '' : pdfSafe(String(v)))
const money = (n: any) =>
  n == null || n === '' || isNaN(Number(n)) ? P(n) : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
// AI-generated abstracts occasionally return a list field as a string ("None")
// or object instead of an array — calling .map on it would throw and abort the
// whole (merged) pack. Coerce anything non-array to [] so a section just renders
// empty ("None found") instead of crashing.
const arr = (x: any): any[] => (Array.isArray(x) ? x : [])

export function AbstractsReport({ title, subtitle, docs, generatedAt, showPropertyHeadings, pageNumbers = true, totalCount }: AbstractsReportInput) {
  const n = totalCount ?? docs.length
  return (
    <ReportShell
      orientation="portrait"
      kicker="M&J Wilkow · Lease Abstracts"
      title={title}
      subtitle={subtitle}
      pageNumbers={pageNumbers}
      metaRight={[`Generated ${generatedAt}`, `${n} ${n === 1 ? 'abstract' : 'abstracts'}`]}
    >
      {docs.map((d, i) => (
        <View key={i} break={i > 0}>
          {showPropertyHeadings && (
            <View style={{ backgroundColor: '#eef1f3', borderLeftWidth: 3, borderLeftColor: WILKOW, paddingVertical: 3, paddingHorizontal: 8, marginBottom: 8 }}>
              <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 9, color: WILKOW }}>{pdfSafe(d.propertyName)}</Text>
            </View>
          )}
          <AbstractBody d={d} />
        </View>
      ))}
      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 10, lineHeight: 1.5 }}>
        AI-generated from the lease + amendments in the document corpus, following the firm's Lease Abstract Template.
        Verify against the source lease before relying on any term. Fields marked "Not found" flagged in Open Items.
      </Text>
    </ReportShell>
  )
}

function AbstractBody({ d }: { d: AbstractDoc }) {
  const a = d.abstract ?? {}
  return (
    <View>
      {/* title + provenance */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: WILKOW, paddingBottom: 6, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 14, color: TEXT }}>
            {P(a.trade_name) || P(d.tenantName)}
          </Text>
          {a.suite ? <Text style={{ fontSize: 8, color: TEXT_MUTED }}>Suite {P(a.suite)}</Text> : null}
        </View>
        <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 3 }}>
          {[a.tenant_legal_name ? P(a.tenant_legal_name) : null,
            d.generatedAt ? `abstract generated ${new Date(d.generatedAt).toLocaleDateString('en-US')}` : null,
            `${d.sourceDocCount} source ${d.sourceDocCount === 1 ? 'document' : 'documents'}`,
          ].filter(Boolean).join(' · ')}
        </Text>
      </View>

      <Section title="Snapshot">
        <Grid>
          <Fact k="Trade name (dba)" v={a.trade_name} />
          <Fact k="Tenant legal name" v={a.tenant_legal_name} />
          <Fact k="Suite" v={a.suite} />
          <Fact k="Square footage" v={a.square_footage?.toLocaleString?.('en-US') ?? a.square_footage} />
          <Fact k="Rent commencement" v={a.term?.rent_commencement} />
          <Fact k="Expiration" v={a.term?.expiration} />
          <Fact k="Term (yrs)" v={a.term?.term_years} />
          <Fact k="Guarantor" v={a.guarantor?.exists ? `${P(a.guarantor.name) || 'Yes'}${a.guarantor.section ? ` [${P(a.guarantor.section)}]` : ''}` : 'None'} />
        </Grid>
      </Section>

      <Section title={`Lease documents (${arr(a.lease_documents).length})`}>
        {arr(a.lease_documents).length === 0
          ? <Missing />
          : <Table head={['Type', 'Date', 'Signed', 'Notes']} widths={[130, 60, 44, 0]}
              rows={arr(a.lease_documents).map((x: any) => [P(x.type), P(x.date), P(x.signed), P(x.notes)])} />}
      </Section>

      <Section title="Base / minimum rent">
        {arr(a.base_rent_schedule).length === 0
          ? <Missing />
          : <Table head={['Start', 'End', '$ PSF', 'Monthly', 'Annual']} widths={[70, 70, 50, 80, 0]}
              rows={arr(a.base_rent_schedule).map((r: any) => [P(r.start), P(r.end), P(r.psf), money(r.monthly), money(r.annual)])} />}
      </Section>

      <Section title="Options">
        {arr(a.options).length === 0
          ? <Missing what="No renewal/extension options found" />
          : <Table head={['Term', 'Notice', 'Start', 'End', '$ PSF', 'Annual', 'Section']} widths={[70, 60, 56, 56, 40, 70, 0]}
              rows={arr(a.options).map((o: any) => [P(o.term), P(o.notice_period), P(o.start), P(o.end), P(o.psf), money(o.annual), P(o.section)])} />}
      </Section>

      <Section title="Percentage rent & sales reporting">
        <Grid>
          <Fact k="Percentage rent" v={a.percentage_rent?.applicable ? `${P(a.percentage_rent.rate_pct) || '?'}% over ${P(a.percentage_rent.breakpoint) || '?'}` : 'None'} />
          <Fact k="Section" v={a.percentage_rent?.section} />
          <Fact k="Sales reporting" v={a.sales_reporting?.reports ? (P(a.sales_reporting.frequency) || 'Yes') : 'Does not report'} />
          <Fact k="Notes" v={a.percentage_rent?.notes} wide />
        </Grid>
      </Section>

      <Section title="Reimbursements — CAM / RET / Insurance">
        <Long k="CAM methodology" v={a.cam?.methodology} />
        <Long k="CAM exact language" v={a.cam?.details_exact_language} />
        <Long k="Pro-rata share / denominator" v={a.cam?.prorata_share_calc} />
        <Long k="Definition of shopping center" v={a.cam?.shopping_center_definition} />
        <Long k="Admin fee" v={a.cam?.admin_fee} />
        <Long k="Caps / exclusions" v={a.cam?.caps_exclusions} />
        <Long k="Audit rights" v={a.cam?.audit_rights ? `Yes${a.cam?.audit_years_back ? ` — ${P(a.cam.audit_years_back)}` : ''}` : a.cam?.audit_rights === false ? 'No' : null} />
        <Long k={`Real estate tax methodology ${a.real_estate_tax?.section ? `[${P(a.real_estate_tax.section)}]` : ''}`} v={a.real_estate_tax?.methodology} />
        <Long k="RET caps on sale / reassessment" v={a.real_estate_tax?.sale_reassessment_caps} />
        <Long k={`Insurance methodology ${a.insurance?.section ? `[${P(a.insurance.section)}]` : ''}`} v={a.insurance?.methodology} />
      </Section>

      <Section title="Key clauses">
        <Long k={`Co-tenancy ${a.co_tenancy?.section ? `[${P(a.co_tenancy.section)}]` : ''}`} v={a.co_tenancy?.exists ? a.co_tenancy.exact_language_and_remedies : 'None'} />
        <Long k="Replacement tenants permitted" v={a.co_tenancy?.replacement_tenants_permitted} />
        <Long k={`Exclusives ${a.exclusives?.section ? `[${P(a.exclusives.section)}]` : ''}`} v={a.exclusives?.exists ? a.exclusives.exact_language : 'None'} />
        <Long k={`Termination / kickout ${a.termination_kickout?.section ? `[${P(a.termination_kickout.section)}]` : ''}`} v={a.termination_kickout?.exists ? a.termination_kickout.details : 'None'} />
        <Long k={`Permitted use ${a.permitted_use?.section ? `[${P(a.permitted_use.section)}]` : ''}`} v={a.permitted_use?.exact_language} />
        <Long k={`Prohibited uses ${a.prohibited_uses?.section ? `[${P(a.prohibited_uses.section)}]` : ''}`} v={a.prohibited_uses?.exact_language} />
        <Long k="Radius clause" v={a.radius_clause?.exists ? a.radius_clause.details : 'None'} />
        <Long k="Continuous operations" v={a.continuous_operations?.exists ? a.continuous_operations.details : 'None'} />
        <Long k="Relocation rights" v={a.relocation_rights?.exists ? `${P(a.relocation_rights.who_pays)} ${P(a.relocation_rights.notes)}`.trim() : 'None'} />
        <Long k="Recapture rights" v={a.recapture_rights?.exists ? a.recapture_rights.details : 'None'} />
        <Long k="Assignment & subletting" v={[a.assignment_subletting?.allowed, a.assignment_subletting?.liability_continues_post_assignment, a.assignment_subletting?.notes].filter(Boolean).map(P).join(' · ')} />
        <Long k="Option to purchase" v={a.option_to_purchase?.exists ? a.option_to_purchase.details : 'None'} />
      </Section>

      <Section title="Deposits, allowances, signage & delivery">
        <Grid>
          <Fact k="Security deposit" v={a.security_deposit?.exists ? `${P(a.security_deposit.type)} ${money(a.security_deposit.total)}`.trim() : 'None'} />
          <Fact k="Tenant allowance" v={a.tenant_allowance?.exists ? `${money(a.tenant_allowance.total)}${a.tenant_allowance.psf ? ` ($${P(a.tenant_allowance.psf)}/SF)` : ''}` : 'None'} />
          <Fact k="Parking" v={a.parking?.spaces_per_1000 ? `${P(a.parking.spaces_per_1000)}/1000 SF` : a.parking?.notes} />
          <Fact k="Signage — pylon/monument" v={a.signage?.pylon_monument_right == null ? a.signage?.notes : a.signage.pylon_monument_right ? `Yes ${P(a.signage?.notes)}`.trim() : 'No'} />
          <Fact k="Estoppel delivery" v={a.estoppel?.timing_for_delivery} />
          <Fact k="SNDA delivery" v={a.snda?.timing_for_delivery} />
        </Grid>
        {a.additional_rights_notes ? <Long k="More / notes" v={a.additional_rights_notes} /> : null}
      </Section>

      {arr(a.open_items).length > 0 && (
        <View style={{ marginTop: 8, backgroundColor: '#faf6ec', borderWidth: 0.75, borderColor: '#e4d9b8', borderRadius: 3, paddingVertical: 6, paddingHorizontal: 9 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: '#8a6d3b', marginBottom: 3 }}>OPEN ITEMS / MISSING DOCUMENTS</Text>
          {arr(a.open_items).map((x: string, i: number) => (
            <Text key={i} style={{ fontSize: 7.5, color: TEXT, marginBottom: 2, lineHeight: 1.45 }}>• {pdfSafe(String(x))}</Text>
          ))}
        </View>
      )}
    </View>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

// Not wrap={false}: verbatim clause language can exceed a page, and clipping
// legal text would be worse than a section splitting across a page break.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginBottom: 9 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.4, color: WILKOW_MIST, marginBottom: 4 }}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{children}</View>
}

function Fact({ k, v, wide }: { k: string; v: any; wide?: boolean }) {
  const val = P(v)
  return (
    <View style={{ width: wide ? '100%' : '50%', paddingRight: 12, marginBottom: 5 }}>
      <Text style={{ fontSize: 6, color: TEXT_FAINT, letterSpacing: 0.5, marginBottom: 1 }}>{k.toUpperCase()}</Text>
      <Text style={{ fontSize: 8, color: TEXT }}>{val || '—'}</Text>
    </View>
  )
}

// Every template field renders — an empty one says so, so gaps are visible.
function Long({ k, v }: { k: string; v: any }) {
  const val = P(v)
  const missing = val === ''
  return (
    <View style={{ marginBottom: 5 }}>
      <Text style={{ fontSize: 6, color: TEXT_FAINT, letterSpacing: 0.5, marginBottom: 1 }}>{k.toUpperCase()}</Text>
      <Text style={{ fontSize: 7.5, color: missing ? TEXT_FAINT : TEXT_MUTED, lineHeight: 1.45, fontStyle: missing ? 'italic' : 'normal' }}>
        {missing ? 'Not found in reviewed documents — see Open items' : val}
      </Text>
    </View>
  )
}

function Missing({ what = 'None found in the reviewed documents' }: { what?: string }) {
  return <Text style={{ fontSize: 7.5, color: TEXT_FAINT, fontStyle: 'italic' }}>{what} — see Open items</Text>
}

// widths: fixed pt per column; 0 = flex(1) to fill the rest
function Table({ head, widths, rows }: { head: string[]; widths: number[]; rows: string[][] }) {
  const cell = (w: number): any => (w === 0 ? { flex: 1 } : { width: w })
  return (
    <View>
      <View style={{ flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: WILKOW, paddingBottom: 2 }}>
        {head.map((h, i) => (
          <Text key={i} style={{ ...cell(widths[i]), fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, color: TEXT_FAINT, paddingRight: 6 }}>{h.toUpperCase()}</Text>
        ))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 2.5 }}>
          {r.map((c, ci) => (
            <Text key={ci} style={{ ...cell(widths[ci]), fontSize: 7.5, color: TEXT, paddingRight: 6 }}>{c || '—'}</Text>
          ))}
        </View>
      ))}
    </View>
  )
}

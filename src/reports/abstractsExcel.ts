// Excel builders for the Abstracts page export bar — the .xlsx counterparts of
// ClauseMatrixReport (one comparison grid) and the full abstract pack (multi-
// sheet workbook). Unlike the PDF matrix, Excel cells carry the FULL clause
// language (no truncation) — the grid is filterable/sortable instead of pretty-
// printed. exceljs is dynamic-imported so it stays out of the main bundle.
import type { AbstractDoc } from './AbstractReport'

const WILKOW_ARGB = 'FF466371'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface AbstractsXlsxInput {
  title: string
  subtitle: string
  docs: AbstractDoc[]
  generatedAt: string
}

const S = (v: any) => (v == null || v === '' ? '' : String(v))
// AI abstracts occasionally return a list field as a string or object — coerce
// to [] so a sheet just comes out empty instead of throwing mid-build.
const arr = (x: any): any[] => (Array.isArray(x) ? x : [])
const num = (v: any): number | string => (v == null || v === '' || isNaN(Number(v)) ? S(v) : Number(v))
const yn = (b: any) => (b ? 'Yes' : b === false ? 'No' : '')

// Clause getters shared by the matrix sheet and the Key Clauses sheet — same
// fields as the PDF matrix columns, but full text.
const coTenancy = (a: any) => a?.co_tenancy?.exists ? `${S(a.co_tenancy.exact_language_and_remedies)}${a.co_tenancy.section ? ` [${S(a.co_tenancy.section)}]` : ''}` : 'None'
const exclusives = (a: any) => a?.exclusives?.exists
  ? [a.exclusives.exact_language, a.exclusives.remedies ? `REMEDIES: ${a.exclusives.remedies}` : null, a.exclusives.conditions ? `CONDITIONS: ${a.exclusives.conditions}` : null].filter(Boolean).map(S).join('\n') + (a.exclusives.section ? ` [${S(a.exclusives.section)}]` : '')
  : 'None'
const optionsSummary = (a: any) => arr(a?.options).length
  ? arr(a.options).map((o: any) => `${S(o.term)}${o.status ? ` — ${S(o.status)}` : ''}${o.notice_by ? ` (notice by ${S(o.notice_by)})` : o.notice_period ? ` (notice ${S(o.notice_period)})` : ''}`).join('; ')
  : 'None'
const pctRent = (a: any) => a?.percentage_rent?.applicable ? `${S(a.percentage_rent.rate_pct) || '?'}% over ${S(a.percentage_rent.breakpoint) || '?'}` : 'None'
const termination = (a: any) => a?.termination_kickout?.exists ? (S(a.termination_kickout.details) || 'Yes') : 'None'
const permittedUse = (a: any) => S(a?.permitted_use?.exact_language)

interface Col { header: string; width: number; get: (d: AbstractDoc, a: any) => string | number }

async function newWorkbook() {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'M&J Wilkow CRE Platform'
  return wb
}

// One tabular worksheet: branded header row, frozen pane, autofilter, wrapped
// top-aligned body cells.
function addGridSheet(wb: any, name: string, cols: Col[], docs: AbstractDoc[], rowsFor?: (d: AbstractDoc, a: any) => any[][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = cols.map(c => ({ header: c.header, width: c.width }))
  const head = ws.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WILKOW_ARGB } }
  head.alignment = { vertical: 'middle' }

  for (const d of docs) {
    const a = d.abstract ?? {}
    if (rowsFor) {
      for (const r of rowsFor(d, a)) ws.addRow(r)
    } else {
      ws.addRow(cols.map(c => c.get(d, a)))
    }
  }
  ws.eachRow((row: any, n: number) => {
    if (n === 1) return
    row.alignment = { vertical: 'top', wrapText: true }
    row.font = { size: 9.5 }
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } }
  return ws
}

function addAboutSheet(wb: any, input: AbstractsXlsxInput, extra: string) {
  const about = wb.addWorksheet('About')
  about.getColumn(1).width = 110
  about.addRow([input.title]).font = { bold: true, size: 13, color: { argb: WILKOW_ARGB } }
  about.addRow([input.subtitle])
  about.addRow([`Generated ${input.generatedAt} · M&J Wilkow CRE Platform`])
  about.addRow([])
  const note = about.addRow([extra + ' AI-generated from the lease + amendments in the document corpus — verify against the source lease before relying on any term.'])
  note.alignment = { wrapText: true, vertical: 'top' }
  note.font = { italic: true, size: 9, color: { argb: 'FF8FA2AD' } }
}

async function toBlob(wb: any): Promise<Blob> {
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: XLSX_MIME })
}

const sorted = (docs: AbstractDoc[]) =>
  [...docs].sort((a, b) => a.propertyName.localeCompare(b.propertyName) || a.tenantName.localeCompare(b.tenantName))

// ── Clause matrix workbook ───────────────────────────────────────────────────
export async function buildClauseMatrixXlsx(input: AbstractsXlsxInput): Promise<Blob> {
  const wb = await newWorkbook()
  const docs = sorted(input.docs)
  const multi = new Set(docs.map(d => d.propertyName)).size > 1

  const cols: Col[] = [
    ...(multi ? [{ header: 'Property', width: 24, get: (d: AbstractDoc) => d.propertyName }] : []),
    { header: 'Tenant', width: 26, get: d => d.tenantName },
    { header: 'Co-tenancy', width: 55, get: (_d, a) => coTenancy(a) },
    { header: 'Exclusives', width: 55, get: (_d, a) => exclusives(a) },
    { header: 'Options', width: 42, get: (_d, a) => optionsSummary(a) },
    { header: '% Rent', width: 22, get: (_d, a) => pctRent(a) },
    { header: 'Termination / Kickout', width: 45, get: (_d, a) => termination(a) },
    { header: 'Permitted Use', width: 55, get: (_d, a) => permittedUse(a) },
  ]
  addGridSheet(wb, 'Clause Matrix', cols, docs)
  addAboutSheet(wb, input, 'Cells carry the full clause language (unlike the PDF matrix, nothing is truncated). "None" means the reviewed documents contained no such clause.')
  return toBlob(wb)
}

// ── Full abstracts workbook ──────────────────────────────────────────────────
// The PDF pack is one narrative document per tenant; the Excel counterpart is
// a set of normalized sheets — one row per tenant on Summary/Key Clauses, one
// row per schedule line on the table sheets — so it can be filtered and pivoted.
export async function buildAbstractsXlsx(input: AbstractsXlsxInput): Promise<Blob> {
  const wb = await newWorkbook()
  const docs = sorted(input.docs)

  const id: Col[] = [
    { header: 'Property', width: 24, get: d => d.propertyName },
    { header: 'Tenant', width: 26, get: d => d.tenantName },
  ]

  addGridSheet(wb, 'Summary', [
    ...id,
    { header: 'Trade Name', width: 22, get: (_d, a) => S(a.trade_name) },
    { header: 'Legal Name', width: 30, get: (_d, a) => S(a.tenant_legal_name) },
    { header: 'Suite', width: 10, get: (_d, a) => S(a.suite) },
    { header: 'SF', width: 10, get: (_d, a) => num(a.square_footage) },
    { header: 'Rent Commencement', width: 18, get: (_d, a) => S(a.term?.rent_commencement) },
    { header: 'Expiration', width: 14, get: (_d, a) => S(a.term?.expiration) },
    { header: 'Term (yrs)', width: 10, get: (_d, a) => num(a.term?.term_years) },
    { header: 'Options', width: 42, get: (_d, a) => optionsSummary(a) },
    { header: '% Rent', width: 22, get: (_d, a) => pctRent(a) },
    { header: 'Guarantor', width: 24, get: (_d, a) => a.guarantor?.exists ? (S(a.guarantor.name) || 'Yes') : 'None' },
    { header: 'Security Deposit', width: 18, get: (_d, a) => a.security_deposit?.exists ? `${S(a.security_deposit.type)} ${S(a.security_deposit.total)}`.trim() : 'None' },
    { header: 'Tenant Allowance', width: 18, get: (_d, a) => a.tenant_allowance?.exists ? `${S(a.tenant_allowance.total)}${a.tenant_allowance.psf ? ` ($${S(a.tenant_allowance.psf)}/SF)` : ''}` : 'None' },
    { header: 'Co-tenancy?', width: 12, get: (_d, a) => yn(a.co_tenancy?.exists) },
    { header: 'Exclusives?', width: 12, get: (_d, a) => yn(a.exclusives?.exists) },
    { header: 'Termination?', width: 12, get: (_d, a) => yn(a.termination_kickout?.exists) },
    { header: 'Abstract Generated', width: 16, get: d => d.generatedAt ? new Date(d.generatedAt).toLocaleDateString('en-US') : '' },
    { header: 'Source Docs', width: 11, get: d => d.sourceDocCount },
  ], docs)

  addGridSheet(wb, 'Key Clauses', [
    ...id,
    { header: 'Co-tenancy', width: 55, get: (_d, a) => coTenancy(a) },
    { header: 'Exclusives', width: 55, get: (_d, a) => exclusives(a) },
    { header: 'Use Restrictions on Tenant', width: 45, get: (_d, a) => a.use_restrictions_on_tenant?.exists ? S(a.use_restrictions_on_tenant.exact_language) : a.use_restrictions_on_tenant ? 'None' : '' },
    { header: 'Termination / Kickout', width: 45, get: (_d, a) => termination(a) },
    { header: 'Permitted Use', width: 45, get: (_d, a) => permittedUse(a) },
    { header: 'Prohibited Uses', width: 40, get: (_d, a) => S(a.prohibited_uses?.exact_language) },
    { header: 'Radius', width: 28, get: (_d, a) => a.radius_clause?.exists ? S(a.radius_clause.details) : 'None' },
    { header: 'Continuous Operations', width: 28, get: (_d, a) => a.continuous_operations?.exists ? S(a.continuous_operations.details) : 'None' },
    { header: 'Relocation', width: 24, get: (_d, a) => a.relocation_rights?.exists ? `${S(a.relocation_rights.who_pays)} ${S(a.relocation_rights.notes)}`.trim() : 'None' },
    { header: 'Recapture', width: 24, get: (_d, a) => a.recapture_rights?.exists ? S(a.recapture_rights.details) : 'None' },
    { header: 'Assignment & Subletting', width: 40, get: (_d, a) => [a.assignment_subletting?.allowed, a.assignment_subletting?.liability_continues_post_assignment, a.assignment_subletting?.notes].filter(Boolean).map(S).join(' · ') },
    { header: 'CAM Methodology', width: 45, get: (_d, a) => S(a.cam?.methodology) },
    { header: 'RE Tax Methodology', width: 45, get: (_d, a) => S(a.real_estate_tax?.methodology) },
    { header: 'Insurance Methodology', width: 40, get: (_d, a) => S(a.insurance?.methodology) },
  ], docs)

  addGridSheet(wb, 'Rent Schedule', [
    ...id,
    { header: 'Start', width: 13, get: () => '' },
    { header: 'End', width: 13, get: () => '' },
    { header: '$ PSF', width: 10, get: () => '' },
    { header: 'Monthly', width: 13, get: () => '' },
    { header: 'Annual', width: 13, get: () => '' },
  ], docs, (d, a) => arr(a.base_rent_schedule).map((r: any) =>
    [d.propertyName, d.tenantName, S(r.start), S(r.end), num(r.psf), num(r.monthly), num(r.annual)]))

  addGridSheet(wb, 'Options', [
    ...id,
    { header: 'Term', width: 20, get: () => '' },
    { header: 'Status', width: 12, get: () => '' },
    { header: 'Notice By / Period', width: 18, get: () => '' },
    { header: 'Start', width: 13, get: () => '' },
    { header: 'End', width: 13, get: () => '' },
    { header: '$ PSF', width: 10, get: () => '' },
    { header: 'Annual', width: 13, get: () => '' },
    { header: 'Section', width: 12, get: () => '' },
  ], docs, (d, a) => arr(a.options).map((o: any) =>
    [d.propertyName, d.tenantName, `${o.landlord_reminder_required ? '[LL reminder] ' : ''}${S(o.term)}`, S(o.status), S(o.notice_by) || S(o.notice_period), S(o.start), S(o.end), num(o.psf), num(o.annual), S(o.section)]))

  addGridSheet(wb, 'Critical Dates', [
    ...id,
    { header: 'Date', width: 13, get: () => '' },
    { header: 'Event', width: 55, get: () => '' },
    { header: 'Source', width: 30, get: () => '' },
  ], docs, (d, a) => [...arr(a.critical_dates)]
    .sort((x: any, y: any) => String(x.date ?? '').localeCompare(String(y.date ?? '')))
    .map((c: any) => [d.propertyName, d.tenantName, S(c.date), S(c.event), S(c.source)]))

  addGridSheet(wb, 'Open Items', [
    ...id,
    { header: 'Open Item / Missing Document', width: 80, get: () => '' },
  ], docs, (d, a) => arr(a.open_items).map((x: any) => [d.propertyName, d.tenantName, S(x)]))

  addAboutSheet(wb, input, 'One row per tenant on Summary and Key Clauses; one row per schedule line on the table sheets. Empty cells mean the field was not found in the reviewed documents (see Open Items).')
  return toBlob(wb)
}

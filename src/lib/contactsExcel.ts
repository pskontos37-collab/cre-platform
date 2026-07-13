// Excel export / import for the Contacts directory (tenant_contacts).
//
// A single COLUMNS table is the source of truth for both the export sheet and
// the downloadable import template, so a file exported from the app maps
// straight back in on import. exceljs is dynamic-imported (kept out of the
// main bundle) — see the callers in ContactsPage.
import type { TenantContact, ContactDraft, ContactType } from '../hooks/useTenantContacts'
import { CONTACT_TYPES, CONTACT_TYPE_LABEL } from '../hooks/useTenantContacts'

// Flat, string-valued view of a contact for the spreadsheet grid.
export interface ContactRow {
  property: string
  tenant: string
  contactType: string
  contactName: string
  title: string
  company: string
  attn: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  zip: string
  country: string
  primary: string
  copyTo: string
  notes: string
  // export-only, ignored on import
  source: string
  verified: string
  updated: string
}

interface Col {
  header: string
  key: keyof ContactRow
  width: number
  importable: boolean       // false = export-only (skipped in template + on parse)
}

const COLUMNS: Col[] = [
  { header: 'Property',        key: 'property',     width: 24, importable: true },
  { header: 'Tenant',          key: 'tenant',       width: 26, importable: true },
  { header: 'Contact Type',    key: 'contactType',  width: 16, importable: true },
  { header: 'Contact Name',    key: 'contactName',  width: 22, importable: true },
  { header: 'Title / Role',    key: 'title',        width: 20, importable: true },
  { header: 'Company / Entity',key: 'company',      width: 26, importable: true },
  { header: 'Attn',            key: 'attn',         width: 18, importable: true },
  { header: 'Email',           key: 'email',        width: 26, importable: true },
  { header: 'Phone',           key: 'phone',        width: 16, importable: true },
  { header: 'Address Line 1',  key: 'addressLine1', width: 26, importable: true },
  { header: 'Address Line 2',  key: 'addressLine2', width: 20, importable: true },
  { header: 'City',            key: 'city',         width: 16, importable: true },
  { header: 'State',           key: 'state',        width: 8,  importable: true },
  { header: 'ZIP',             key: 'zip',          width: 10, importable: true },
  { header: 'Country',         key: 'country',      width: 12, importable: true },
  { header: 'Primary',         key: 'primary',      width: 9,  importable: true },
  { header: 'Copy-To',         key: 'copyTo',       width: 9,  importable: true },
  { header: 'Notes',           key: 'notes',        width: 34, importable: true },
  { header: 'Source',          key: 'source',       width: 14, importable: false },
  { header: 'Verified',        key: 'verified',     width: 10, importable: false },
  { header: 'Updated',         key: 'updated',      width: 14, importable: false },
]

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function contactToRow(c: TenantContact, propertyNames: Record<string, string>): ContactRow {
  const s = (v: string | null | undefined) => v ?? ''
  return {
    property:     propertyNames[c.propertyId] ?? c.propertyId,
    tenant:       c.tenantName,
    contactType:  CONTACT_TYPE_LABEL[c.contactType],
    contactName:  s(c.contactName),
    title:        s(c.title),
    company:      s(c.company),
    attn:         s(c.attn),
    email:        s(c.email),
    phone:        s(c.phone),
    addressLine1: s(c.addressLine1),
    addressLine2: s(c.addressLine2),
    city:         s(c.city),
    state:        s(c.state),
    zip:          s(c.zip),
    country:      s(c.country),
    primary:      c.isPrimary ? 'Yes' : '',
    copyTo:       c.copyTo ? 'Yes' : '',
    notes:        s(c.notes),
    source:       c.source,
    verified:     c.verified ? 'Yes' : '',
    updated:      c.updatedAt ? c.updatedAt.slice(0, 10) : '',
  }
}

const WILKOW_ARGB = 'FF466371'

// ── export ──────────────────────────────────────────────────────────────────
export async function exportContactsXlsx(
  contacts: TenantContact[],
  propertyNames: Record<string, string>,
  scopeLabel: string,
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'M&J Wilkow Asset Management Platform'
  const ws = wb.addWorksheet('Contacts', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }))
  for (const c of contacts) ws.addRow(contactToRow(c, propertyNames))

  const head = ws.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WILKOW_ARGB } }
  head.alignment = { vertical: 'middle' }
  head.height = 20
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }

  // A short "About" sheet documenting the scope + import round-trip.
  const about = wb.addWorksheet('About')
  about.getColumn(1).width = 90
  about.addRow(['M&J Wilkow — Tenant Contacts Export'])
  about.getRow(1).font = { bold: true, size: 13, color: { argb: WILKOW_ARGB } }
  about.addRow([`Scope: ${scopeLabel}`])
  about.addRow([`Rows: ${contacts.length}`])
  about.addRow([''])
  about.addRow(['Editable columns (A–R) map back into the app on import; Source / Verified / Updated are export-only.'])
  about.addRow(['Valid Contact Type values: ' + CONTACT_TYPES.map(t => t.label).join(', ')])

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: XLSX_MIME })
}

// ── import template ───────────────────────────────────────────────────────────
export async function buildContactsImportTemplate(
  propertyNames: string[],
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'M&J Wilkow Asset Management Platform'

  const cols = COLUMNS.filter(c => c.importable)
  const ws = wb.addWorksheet('Contacts', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = cols.map(c => ({ header: c.header, key: c.key, width: c.width }))

  // One illustrative example row (clearly marked so it isn't mistaken for data).
  ws.addRow({
    property: propertyNames[0] ?? 'Exact property name',
    tenant: 'EXAMPLE — delete this row',
    contactType: 'Billing / AP',
    contactName: 'Jane Doe', title: 'AP Manager', company: 'Acme Retail LLC',
    email: 'jane@acme.com', phone: '(312) 555-0100',
    addressLine1: '123 Main St', city: 'Chicago', state: 'IL', zip: '60601',
    primary: 'Yes', copyTo: '', notes: 'Optional free text',
  } as Partial<ContactRow>)

  const head = ws.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WILKOW_ARGB } }
  head.height = 20
  ws.getRow(2).font = { italic: true, color: { argb: 'FF8FA2AD' } }

  // Reference sheet: exact property names + valid contact types the importer accepts.
  const ref = wb.addWorksheet('Reference')
  ref.getColumn(1).width = 40
  ref.getColumn(2).width = 40
  ref.addRow(['Valid Contact Type', 'Valid Property Name'])
  ref.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  ref.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WILKOW_ARGB } }
  const maxLen = Math.max(CONTACT_TYPES.length, propertyNames.length)
  for (let i = 0; i < maxLen; i++) {
    ref.addRow([CONTACT_TYPES[i]?.label ?? '', propertyNames[i] ?? ''])
  }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: XLSX_MIME })
}

// ── import parse ──────────────────────────────────────────────────────────────
export interface ParsedContactRow {
  rowNumber: number          // 1-based spreadsheet row (for error reporting)
  draft: ContactDraft | null
  errors: string[]
}

export interface ParseResult {
  rows: ParsedContactRow[]
  validCount: number
  errorCount: number
}

// Accept either the label ("Billing / AP") or the key ("billing"), case-insensitive.
const TYPE_BY_LABEL = new Map<string, ContactType>(
  CONTACT_TYPES.flatMap(t => [
    [t.label.toLowerCase(), t.key],
    [t.key.toLowerCase(), t.key],
    [t.short.toLowerCase(), t.key],
  ] as [string, ContactType][]),
)

const cellStr = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'object') {
    // exceljs hyperlink / rich-text cell
    const anyV = v as { text?: string; hyperlink?: string; result?: unknown }
    if (typeof anyV.text === 'string') return anyV.text.trim()
    if (anyV.result != null) return String(anyV.result).trim()
    return ''
  }
  return String(v).trim()
}

const isYes = (v: string) => /^(y|yes|true|1|x)$/i.test(v.trim())

// propertyIdByName: case-insensitive lookup of the exact property name -> id.
// tenantLookup: optional (propertyId + normalized tenant) -> { tenantId, leaseId }.
export async function parseContactsXlsx(
  file: File,
  propertyIdByName: Map<string, string>,
  tenantLookup?: Map<string, { tenantId: string | null; leaseId: string | null }>,
): Promise<ParseResult> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.getWorksheet('Contacts') ?? wb.worksheets[0]
  if (!ws) return { rows: [], validCount: 0, errorCount: 0 }

  // Map header text -> column index from row 1.
  const headerToField = new Map<string, keyof ContactRow>()
  for (const c of COLUMNS) headerToField.set(c.header.toLowerCase(), c.key)
  const colField: Record<number, keyof ContactRow> = {}
  ws.getRow(1).eachCell((cell, col) => {
    const f = headerToField.get(cellStr(cell.value).toLowerCase())
    if (f) colField[col] = f
  })

  const out: ParsedContactRow[] = []
  const lastRow = ws.rowCount
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r)
    const vals = {} as Record<keyof ContactRow, string>
    for (const c of COLUMNS) vals[c.key] = ''
    let anyValue = false
    row.eachCell((cell, col) => {
      const f = colField[col]
      if (!f) return
      const s = cellStr(cell.value)
      vals[f] = s
      if (s) anyValue = true
    })
    if (!anyValue) continue   // skip blank rows

    const errors: string[] = []
    // skip the template's example row
    if (/^EXAMPLE\b/i.test(vals.tenant)) continue

    const propId = propertyIdByName.get(vals.property.trim().toLowerCase())
    if (!vals.property.trim()) errors.push('Property is required')
    else if (!propId) errors.push(`Unknown property "${vals.property}" (must match an existing property name exactly)`)

    if (!vals.tenant.trim()) errors.push('Tenant is required')

    const type = TYPE_BY_LABEL.get(vals.contactType.trim().toLowerCase())
    if (!vals.contactType.trim()) errors.push('Contact Type is required')
    else if (!type) errors.push(`Unknown contact type "${vals.contactType}"`)

    let draft: ContactDraft | null = null
    if (errors.length === 0 && propId && type) {
      const match = tenantLookup?.get(`${propId}::${vals.tenant.trim().toLowerCase()}`)
      draft = {
        propertyId: propId,
        tenantId: match?.tenantId ?? null,
        leaseId: match?.leaseId ?? null,
        tenantName: vals.tenant.trim(),
        contactType: type,
        contactName: vals.contactName,
        title: vals.title,
        company: vals.company,
        attn: vals.attn,
        email: vals.email,
        phone: vals.phone,
        addressLine1: vals.addressLine1,
        addressLine2: vals.addressLine2,
        city: vals.city,
        state: vals.state,
        zip: vals.zip,
        country: vals.country,
        isPrimary: isYes(vals.primary),
        copyTo: isYes(vals.copyTo),
        notes: vals.notes,
      }
    }
    out.push({ rowNumber: r, draft, errors })
  }

  const validCount = out.filter(r => r.draft && r.errors.length === 0).length
  return { rows: out, validCount, errorCount: out.length - validCount }
}

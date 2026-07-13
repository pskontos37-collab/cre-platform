import { useMemo, useState, type CSSProperties, type ChangeEvent, type ReactNode } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useTenantContacts, useTenantOptions,
  createContact, updateContact, deleteContact, setContactVerified, importContacts, formatAddress,
  CONTACT_TYPES, CONTACT_TYPE_LABEL,
  type TenantContact, type ContactType, type ContactDraft, type TenantOption,
} from '../hooks/useTenantContacts'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { useAuth } from '../contexts/AuthContext'
import { RelationshipsTab } from './RelationshipsTab'
import { exportContactsXlsx, buildContactsImportTemplate, parseContactsXlsx, type ParseResult } from '../lib/contactsExcel'

// Trigger a browser download for a generated blob.
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ── M&J Wilkow corporate palette (wilkow.com) — matches the other ops pages ──
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const TYPE_COLOR: Record<ContactType, string> = {
  legal_notice: WILKOW,
  billing:      'var(--green)',
  operational:  'var(--amber)',
  corporate:    '#7c6fb0',
  general:      'var(--text-muted)',
}

const hasAddress = (c: TenantContact) =>
  !!(c.addressLine1 || c.city || c.state || c.zip || c.company)

// ── page shell: corporate header + tabs ──────────────────────────────────────
type Tab = 'tenant' | 'relationships'

export function ContactsPage() {
  const { appUser } = useAuth()
  const canRelationships = appUser?.role === 'asset_manager' || appUser?.role === 'admin'
  const [tab, setTab] = useState<Tab>('tenant')
  const activeTab: Tab = tab === 'relationships' && !canRelationships ? 'tenant' : tab

  const tabBtn = (t: Tab): CSSProperties => ({
    fontSize: 13, fontWeight: 650, padding: '8px 4px', marginRight: 22, cursor: 'pointer',
    background: 'none', border: 'none', borderBottom: `2px solid ${activeTab === t ? WILKOW : 'transparent'}`,
    color: activeTab === t ? 'var(--text)' : 'var(--text-muted)',
  })

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1080 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
          M&amp;J Wilkow · Contacts Directory
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
          Contacts
        </div>
      </div>
      <div style={{ borderBottom: `2px solid ${WILKOW}`, marginBottom: 18, marginTop: 12 }}>
        <button style={tabBtn('tenant')} onClick={() => setTab('tenant')}>Tenant Contacts</button>
        {canRelationships && (
          <button style={tabBtn('relationships')} onClick={() => setTab('relationships')}>Relationships</button>
        )}
      </div>
      {activeTab === 'tenant' ? <TenantContactsTab /> : <RelationshipsTab />}
    </div>
  )
}

// ── tenant contacts tab ──────────────────────────────────────────────────────
function TenantContactsTab() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error, refetch } = useTenantContacts(propertyIds)
  const { data: tenantOptions } = useTenantOptions(propertyIds)
  const contacts = data ?? []

  const [typeFilter, setTypeFilter] = useState<ContactType | null>(null)
  const [search, setSearch] = useState('')
  const [noticeView, setNoticeView] = useState(false)     // compact legal-notice layout
  const [editing, setEditing] = useState<TenantContact | 'new' | null>(null)
  const [exportMenu, setExportMenu] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)

  const counts = useMemo(() => {
    const c = {} as Record<ContactType, number>
    for (const t of CONTACT_TYPES) c[t.key] = 0
    for (const k of contacts) c[k.contactType] = (c[k.contactType] ?? 0) + 1
    return c
  }, [contacts])

  const effectiveTypeFilter: ContactType | null = noticeView ? 'legal_notice' : typeFilter

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return contacts
      .filter(c => !effectiveTypeFilter || c.contactType === effectiveTypeFilter)
      .filter(c => !q || [c.tenantName, c.contactName, c.company, c.email, c.attn, c.city, c.state]
        .some(v => v?.toLowerCase().includes(q)))
  }, [contacts, effectiveTypeFilter, search])

  // property → tenant → contacts
  const byProperty = useMemo(() => {
    const props = new Map<string, Map<string, TenantContact[]>>()
    for (const c of visible) {
      const pName = propertyNames[c.propertyId] ?? '—'
      if (!props.has(pName)) props.set(pName, new Map())
      const tmap = props.get(pName)!
      const list = tmap.get(c.tenantName) ?? []
      list.push(c)
      tmap.set(c.tenantName, list)
    }
    return Array.from(props.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pName, tmap]) => ({
        propertyName: pName,
        tenants: Array.from(tmap.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([tName, list]) => ({ tenantName: tName, contacts: sortContacts(list) })),
      }))
  }, [visible, propertyNames])

  async function handleDelete(c: TenantContact) {
    if (!confirm(`Delete the ${CONTACT_TYPE_LABEL[c.contactType]} contact for ${c.tenantName}?`)) return
    await deleteContact(c.id)
    refetch()
  }

  // Property-name -> id (case-insensitive), and tenant -> ids, for the importer.
  const propertyIdByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, name] of Object.entries(propertyNames)) m.set(name.trim().toLowerCase(), id)
    return m
  }, [propertyNames])
  const tenantLookup = useMemo(() => {
    const m = new Map<string, { tenantId: string | null; leaseId: string | null }>()
    for (const t of tenantOptions ?? []) m.set(`${t.propertyId}::${t.tenantName.trim().toLowerCase()}`, { tenantId: t.tenantId, leaseId: t.leaseId })
    return m
  }, [tenantOptions])
  const scopedPropertyNames = useMemo(
    () => propertyIds.map(id => propertyNames[id]).filter(Boolean).sort() as string[],
    [propertyIds, propertyNames])

  async function runExport(which: 'view' | 'all') {
    setExportMenu(false)
    setExportBusy(true)
    try {
      const rows = which === 'view' ? visible : contacts
      const filterBits = [
        effectiveTypeFilter ? CONTACT_TYPE_LABEL[effectiveTypeFilter] : null,
        search.trim() ? `search "${search.trim()}"` : null,
      ].filter(Boolean)
      const scopeLabel = which === 'view'
        ? `Current view${filterBits.length ? ` (${filterBits.join(', ')})` : ''} — ${scopedPropertyNames.length} propert${scopedPropertyNames.length === 1 ? 'y' : 'ies'}`
        : `All loaded contacts — ${scopedPropertyNames.length} propert${scopedPropertyNames.length === 1 ? 'y' : 'ies'}`
      const blob = await exportContactsXlsx(rows, propertyNames, scopeLabel)
      downloadBlob(blob, `Wilkow-Contacts-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <>
      {/* intro + add */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 720 }}>
          Billing, operational, corporate and <b>legal-notice</b> contacts for every tenant, by property.
          Legal-notice rows carry the mailing address from the lease’s Notices clause — switch on
          <b> Notice addresses</b> for a copy-ready view when sending default notices or estoppels.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setExportMenu(m => !m)}
              disabled={exportBusy || contacts.length === 0}
              style={{ ...ghostBtn, opacity: contacts.length === 0 ? 0.5 : 1 }}
              title={contacts.length === 0 ? 'No contacts to export' : 'Export contacts to Excel'}
            >
              {exportBusy ? 'Exporting…' : '⬇ Export Excel ▾'}
            </button>
            {exportMenu && (
              <div style={exportMenuStyle}>
                <button onClick={() => runExport('view')} style={menuItem}>
                  Current view <span style={{ color: 'var(--text-faint)' }}>· {visible.length}</span>
                </button>
                <button onClick={() => runExport('all')} style={menuItem}>
                  All loaded <span style={{ color: 'var(--text-faint)' }}>· {contacts.length}</span>
                </button>
              </div>
            )}
          </div>
          <button onClick={() => setImporting(true)} style={ghostBtn} title="Import contacts from an Excel file">⬆ Import</button>
          <button onClick={() => setEditing('new')} style={primaryBtn}>+ Add contact</button>
        </div>
      </div>

      {/* ── type chips + controls ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        {CONTACT_TYPES.filter(t => counts[t.key] > 0).map(t => {
          const on = !noticeView && typeFilter === t.key
          const color = TYPE_COLOR[t.key]
          return (
            <button
              key={t.key}
              disabled={noticeView}
              onClick={() => setTypeFilter(on ? null : t.key)}
              style={{
                fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99,
                cursor: noticeView ? 'default' : 'pointer', opacity: noticeView && t.key !== 'legal_notice' ? 0.4 : 1,
                background: 'var(--surface-2)', color: on ? color : 'var(--text-muted)',
                border: `1px solid ${on ? color : 'var(--border-2)'}`,
                boxShadow: on ? `0 0 0 1px ${color}` : 'none',
              }}
            >
              {t.icon} {t.label} · {counts[t.key]}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNoticeView(v => !v)}
          title="Show only legal-notice recipients in a copy-ready layout"
          style={{
            fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
            background: noticeView ? WILKOW : 'var(--surface-2)', color: noticeView ? '#fff' : WILKOW,
            border: `1px solid ${WILKOW}`,
          }}
        >
          ⚖️ Notice addresses
        </button>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search tenants, people…"
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', width: 190 }}
        />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load contacts" subtitle={error} />}
      {!loading && !error && contacts.length === 0 && (
        <EmptyState icon="📇" title="No contacts yet"
          subtitle="Add one with “+ Add contact”, or run scripts/extract_notice_addresses.ps1 to seed legal-notice addresses from the leases" />
      )}
      {!loading && !error && contacts.length > 0 && visible.length === 0 && (
        <EmptyState icon="🔍" title="Nothing matches" subtitle="Clear the type filter or search above" />
      )}

      {byProperty.map(prop => (
        <div key={prop.propertyName} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 10 }}>
            {prop.propertyName} <span style={{ color: 'var(--text-faint)', letterSpacing: 0 }}>· {prop.tenants.length} tenant{prop.tenants.length === 1 ? '' : 's'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {prop.tenants.map(t => (
              <TenantCard
                key={t.tenantName}
                tenantName={t.tenantName}
                contacts={t.contacts}
                noticeView={noticeView}
                onEdit={setEditing}
                onDelete={handleDelete}
                onVerify={async (c) => { await setContactVerified(c.id, true); refetch() }}
              />
            ))}
          </div>
        </div>
      ))}

      {editing && (
        <ContactModal
          initial={editing === 'new' ? null : editing}
          tenantOptions={tenantOptions ?? []}
          propertyNames={propertyNames}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch() }}
        />
      )}

      {importing && (
        <ContactImportModal
          propertyIdByName={propertyIdByName}
          tenantLookup={tenantLookup}
          templatePropertyNames={scopedPropertyNames}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); refetch() }}
        />
      )}
    </>
  )
}

// ── import modal ──────────────────────────────────────────────────────────────
function ContactImportModal({ propertyIdByName, tenantLookup, templatePropertyNames, onClose, onImported }: {
  propertyIdByName: Map<string, string>
  tenantLookup: Map<string, { tenantId: string | null; leaseId: string | null }>
  templatePropertyNames: string[]
  onClose: () => void
  onImported: () => void
}) {
  const [parsing, setParsing] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  async function downloadTemplate() {
    try {
      const blob = await buildContactsImportTemplate(templatePropertyNames)
      downloadBlob(blob, 'Wilkow-Contacts-Import-Template.xlsx')
    } catch (e: any) {
      setErr(e?.message ?? 'Could not build template')
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setResult(null); setErr(null); setDone(null)
    setParsing(true)
    try {
      setResult(await parseContactsXlsx(file, propertyIdByName, tenantLookup))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not read the file')
    } finally {
      setParsing(false)
    }
  }

  async function commit() {
    if (!result) return
    const drafts = result.rows.filter(r => r.draft && r.errors.length === 0).map(r => r.draft!)
    if (drafts.length === 0) return
    setCommitting(true); setErr(null)
    try {
      const n = await importContacts(drafts)
      setDone(n)
      setTimeout(onImported, 900)
    } catch (e: any) {
      setErr(e?.message ?? 'Import failed')
      setCommitting(false)
    }
  }

  const badRows = result?.rows.filter(r => r.errors.length > 0) ?? []

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...modal, maxWidth: 680 }}>
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Import contacts</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          Download the template, fill in the rows, then upload it here. Property names must match exactly
          (the template’s <b>Reference</b> tab lists valid names and contact types). Imported rows are tagged
          <b> source: import</b>. Existing contacts are never overwritten — every valid row is added.
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <button onClick={downloadTemplate} style={ghostBtn}>⬇ Download template</button>
          <label style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {parsing ? 'Reading…' : (fileName ? '↻ Choose another file' : '📄 Choose Excel file')}
            <input type="file" accept=".xlsx" onChange={onFile} style={{ display: 'none' }} />
          </label>
          {fileName && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fileName}</span>}
        </div>

        {err && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 12 }}>{err}</div>}

        {result && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--green)', fontWeight: 650 }}>✓ {result.validCount} ready to import</span>
              {result.errorCount > 0 && <span style={{ fontSize: 13, color: 'var(--red)', fontWeight: 650 }}>✕ {result.errorCount} with issues (skipped)</span>}
            </div>
            {badRows.length > 0 && (
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-2)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface-2)' }}>
                {badRows.map(r => (
                  <div key={r.rowNumber} style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                    <b style={{ color: 'var(--text)' }}>Row {r.rowNumber}:</b> {r.errors.join('; ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {done != null && (
          <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 650, marginBottom: 12 }}>✓ Imported {done} contact{done === 1 ? '' : 's'}.</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
          <button onClick={onClose} style={ghostBtn} disabled={committing}>Close</button>
          <button
            onClick={commit}
            style={{ ...primaryBtn, opacity: !result || result.validCount === 0 || committing ? 0.5 : 1 }}
            disabled={!result || result.validCount === 0 || committing}
          >
            {committing ? 'Importing…' : `Import ${result?.validCount ?? 0} contact${(result?.validCount ?? 0) === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// notice first, then primary, then by type order, then name
function sortContacts(list: TenantContact[]): TenantContact[] {
  const order = CONTACT_TYPES.reduce((m, t, i) => { m[t.key] = i; return m }, {} as Record<ContactType, number>)
  return [...list].sort((a, b) =>
    (order[a.contactType] - order[b.contactType]) ||
    (Number(b.isPrimary) - Number(a.isPrimary)) ||
    (Number(a.copyTo) - Number(b.copyTo)) ||
    (a.contactName ?? a.company ?? '').localeCompare(b.contactName ?? b.company ?? ''))
}

// ── tenant card ────────────────────────────────────────────────────────────
function TenantCard({ tenantName, contacts, noticeView, onEdit, onDelete, onVerify }: {
  tenantName: string
  contacts: TenantContact[]
  noticeView: boolean
  onEdit: (c: TenantContact) => void
  onDelete: (c: TenantContact) => void
  onVerify: (c: TenantContact) => void
}) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${WILKOW}`, borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{tenantName}</div>
      <div style={{ display: 'grid', gridTemplateColumns: noticeView ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {contacts.map(c => (
          <ContactBlock key={c.id} c={c} onEdit={onEdit} onDelete={onDelete} onVerify={onVerify} />
        ))}
      </div>
    </div>
  )
}

function ContactBlock({ c, onEdit, onDelete, onVerify }: {
  c: TenantContact
  onEdit: (c: TenantContact) => void
  onDelete: (c: TenantContact) => void
  onVerify: (c: TenantContact) => void
}) {
  const color = TYPE_COLOR[c.contactType]
  const addr = hasAddress(c) ? formatAddress(c) : null
  const [copied, setCopied] = useState(false)

  async function copyAddr() {
    try {
      await navigator.clipboard.writeText(addr!)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard may be blocked */ }
  }

  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 9, padding: '10px 12px', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color, background: 'var(--surface)', border: `1px solid ${color}`, borderRadius: 5, padding: '1px 6px' }}>
          {CONTACT_TYPE_LABEL[c.contactType]}
        </span>
        {c.copyTo && <span style={pillGrey}>copy to</span>}
        {c.isPrimary && <span style={pillGrey}>primary</span>}
        {c.source === 'ai_extraction' && (
          <span title={c.sourceSection ? `From lease ${c.sourceSection}` : 'Extracted from the lease'}
            style={{ ...pillGrey, color: c.verified ? 'var(--green)' : 'var(--amber)', borderColor: c.verified ? 'var(--green-border)' : 'var(--amber-border)' }}>
            {c.verified ? '✓ verified' : '✨ from lease'}
          </span>
        )}
      </div>

      {(c.contactName || c.title) && (
        <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}>
          {c.contactName}{c.title ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {c.title}</span> : null}
        </div>
      )}
      {c.email && <div style={{ fontSize: 12 }}><a href={`mailto:${c.email}`} style={{ color: WILKOW }}>{c.email}</a></div>}
      {c.phone && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.phone}</div>}

      {addr && (
        <pre style={{ margin: '6px 0 0', fontFamily: 'inherit', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.35 }}>{addr}</pre>
      )}
      {c.notes && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 5, fontStyle: 'italic' }}>{c.notes}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
        {addr && (
          <button onClick={copyAddr} style={linkBtn}>{copied ? '✓ copied' : '⧉ copy address'}</button>
        )}
        {c.source === 'ai_extraction' && !c.verified && (
          <button onClick={() => onVerify(c)} style={{ ...linkBtn, color: 'var(--green)' }}>mark verified</button>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={() => onEdit(c)} style={linkBtn}>edit</button>
        <button onClick={() => onDelete(c)} style={{ ...linkBtn, color: 'var(--red)' }}>delete</button>
      </div>
    </div>
  )
}

// ── add / edit modal ──────────────────────────────────────────────────────
function ContactModal({ initial, tenantOptions, propertyNames, onClose, onSaved }: {
  initial: TenantContact | null
  tenantOptions: TenantOption[]
  propertyNames: Record<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const editingExisting = !!initial
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // form state
  const [propertyId, setPropertyId] = useState(initial?.propertyId ?? '')
  const [tenantName, setTenantName] = useState(initial?.tenantName ?? '')
  const [tenantId, setTenantId] = useState<string | null>(initial?.tenantId ?? null)
  const [leaseId, setLeaseId] = useState<string | null>(initial?.leaseId ?? null)
  const [contactType, setContactType] = useState<ContactType>(initial?.contactType ?? 'legal_notice')
  const [f, setF] = useState({
    contactName: initial?.contactName ?? '', title: initial?.title ?? '', company: initial?.company ?? '',
    attn: initial?.attn ?? '', email: initial?.email ?? '', phone: initial?.phone ?? '',
    addressLine1: initial?.addressLine1 ?? '', addressLine2: initial?.addressLine2 ?? '',
    city: initial?.city ?? '', state: initial?.state ?? '', zip: initial?.zip ?? '',
    country: initial?.country ?? '', notes: initial?.notes ?? '',
  })
  const [isPrimary, setIsPrimary] = useState(initial?.isPrimary ?? false)
  const [copyTo, setCopyTo] = useState(initial?.copyTo ?? false)
  const [customTenant, setCustomTenant] = useState(false)   // typed name vs picked from the lease list

  // tenants available for the chosen property (only in create mode)
  const tenantsForProp = useMemo(
    () => tenantOptions.filter(t => t.propertyId === propertyId),
    [tenantOptions, propertyId])
  const propIds = useMemo(
    () => Array.from(new Set(tenantOptions.map(t => t.propertyId))),
    [tenantOptions])

  const showAddr = contactType === 'legal_notice' || contactType === 'billing' || contactType === 'corporate'

  function pickTenant(value: string) {
    if (value === '__free') { setCustomTenant(true); setTenantName(''); setTenantId(null); setLeaseId(null); return }
    const opt = tenantsForProp.find(t => t.tenantName === value)
    setCustomTenant(false)
    setTenantName(value)
    setTenantId(opt?.tenantId ?? null)
    setLeaseId(opt?.leaseId ?? null)
  }

  async function save() {
    setErr(null)
    if (!propertyId) { setErr('Choose a property'); return }
    if (!tenantName.trim()) { setErr('Enter a tenant name'); return }
    const draft: ContactDraft = {
      propertyId, tenantId, leaseId, tenantName, contactType,
      ...f, isPrimary, copyTo,
    }
    setSaving(true)
    try {
      if (initial) await updateContact(initial.id, draft)
      else await createContact(draft)
      onSaved()
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed')
      setSaving(false)
    }
  }

  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF(prev => ({ ...prev, [k]: e.target.value }))

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modal}>
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          {editingExisting ? 'Edit contact' : 'Add contact'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          {editingExisting ? `${tenantName} · ${propertyNames[propertyId] ?? ''}` : 'Fill in what you have — everything but property, tenant and type is optional.'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* property + tenant (locked when editing) */}
          <Field label="Property">
            {editingExisting
              ? <div style={readonlyVal}>{propertyNames[propertyId] ?? '—'}</div>
              : <select value={propertyId} onChange={e => { setPropertyId(e.target.value); setTenantName(''); setTenantId(null); setLeaseId(null) }} style={input}>
                  <option value="">Choose…</option>
                  {propIds.map(id => <option key={id} value={id}>{propertyNames[id] ?? id}</option>)}
                </select>}
          </Field>
          <Field label="Tenant">
            {editingExisting
              ? <div style={readonlyVal}>{tenantName}</div>
              : (tenantsForProp.length > 0 && !customTenant)
                ? <select value={tenantName} onChange={e => pickTenant(e.target.value)} style={input} disabled={!propertyId}>
                    <option value="">Choose…</option>
                    {tenantsForProp.map(t => <option key={t.leaseId} value={t.tenantName}>{t.tenantName}</option>)}
                    <option value="__free">— type a name —</option>
                  </select>
                : <input autoFocus={customTenant} value={tenantName} onChange={e => { setTenantName(e.target.value); setTenantId(null); setLeaseId(null) }} placeholder="Tenant name" style={input} disabled={!propertyId} />}
          </Field>

          <Field label="Contact type">
            <select value={contactType} onChange={e => setContactType(e.target.value as ContactType)} style={input}>
              {CONTACT_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Flags">
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', height: 34 }}>
              <label style={checkLbl}><input type="checkbox" checked={isPrimary} onChange={e => setIsPrimary(e.target.checked)} /> Primary</label>
              {contactType === 'legal_notice' &&
                <label style={checkLbl}><input type="checkbox" checked={copyTo} onChange={e => setCopyTo(e.target.checked)} /> Copy-to</label>}
            </div>
          </Field>

          <Field label="Contact name"><input value={f.contactName} onChange={set('contactName')} style={input} /></Field>
          <Field label="Title / role"><input value={f.title} onChange={set('title')} style={input} /></Field>
          <Field label="Email"><input value={f.email} onChange={set('email')} type="email" style={input} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} style={input} /></Field>

          {showAddr && <>
            <Field label="Company / entity to address" span2><input value={f.company} onChange={set('company')} placeholder="e.g. tenant legal name or parent" style={input} /></Field>
            <Field label="Attn:"><input value={f.attn} onChange={set('attn')} placeholder="e.g. General Counsel" style={input} /></Field>
            <Field label="" ><span /></Field>
            <Field label="Address line 1" span2><input value={f.addressLine1} onChange={set('addressLine1')} style={input} /></Field>
            <Field label="Address line 2" span2><input value={f.addressLine2} onChange={set('addressLine2')} style={input} /></Field>
            <Field label="City"><input value={f.city} onChange={set('city')} style={input} /></Field>
            <Field label="State / ZIP">
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={f.state} onChange={set('state')} placeholder="ST" style={{ ...input, width: 70 }} />
                <input value={f.zip} onChange={set('zip')} placeholder="ZIP" style={{ ...input, flex: 1 }} />
              </div>
            </Field>
          </>}

          <Field label="Notes" span2><textarea value={f.notes} onChange={set('notes')} rows={2} style={{ ...input, resize: 'vertical' }} /></Field>
        </div>

        {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={ghostBtn} disabled={saving}>Cancel</button>
          <button onClick={save} style={primaryBtn} disabled={saving}>{saving ? 'Saving…' : editingExisting ? 'Save changes' : 'Add contact'}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, span2, children }: { label: string; span2?: boolean; children: ReactNode }) {
  return (
    <div style={{ gridColumn: span2 ? '1 / span 2' : undefined }}>
      {label && <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.06em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 4 }}>{label}</div>}
      {children}
    </div>
  )
}

// ── shared inline styles ─────────────────────────────────────────────────────
const primaryBtn: CSSProperties = { fontSize: 12.5, fontWeight: 650, padding: '7px 16px', borderRadius: 8, cursor: 'pointer', background: WILKOW, color: '#fff', border: 'none' }
const ghostBtn: CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '7px 16px', borderRadius: 8, cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-2)' }
const linkBtn: CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }
const pillGrey: CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 5, padding: '1px 5px' }
const input: CSSProperties = { fontSize: 12.5, padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' }
const readonlyVal: CSSProperties = { fontSize: 12.5, padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)' }
const checkLbl: CSSProperties = { fontSize: 12, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }
const exportMenuStyle: CSSProperties = { position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 4, minWidth: 180, display: 'flex', flexDirection: 'column' }
const menuItem: CSSProperties = { fontSize: 12.5, textAlign: 'left', padding: '7px 10px', borderRadius: 6, border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 12 }
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', zIndex: 1000, overflowY: 'auto' }
const modal: CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '22px 24px', width: '100%', maxWidth: 620, boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }

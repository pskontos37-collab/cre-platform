import { useMemo, useState, type CSSProperties, type ChangeEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useAmContacts, useDealOptions,
  createAmContact, updateAmContact, deleteAmContact, toggleAmFavorite,
  AM_CATEGORIES,
  type AmContact, type AmCategory, type AmContactDraft, type DealOption,
} from '../hooks/useAmContacts'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function RelationshipsTab() {
  const { data: properties } = useProperties()
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error, refetch } = useAmContacts(true)
  const { data: deals } = useDealOptions(true)
  const contacts = data ?? []

  const [catFilter, setCatFilter] = useState<AmCategory | null>(null)
  const [search, setSearch] = useState('')
  const [favOnly, setFavOnly] = useState(false)
  const [editing, setEditing] = useState<AmContact | 'new' | null>(null)

  const counts = useMemo(() => {
    const c = {} as Record<AmCategory, number>
    for (const cat of AM_CATEGORIES) c[cat.key] = 0
    for (const k of contacts) c[k.category] = (c[k.category] ?? 0) + 1
    return c
  }, [contacts])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return contacts
      .filter(c => !catFilter || c.category === catFilter)
      .filter(c => !favOnly || c.isFavorite)
      .filter(c => !q || [c.contactName, c.company, c.represents, c.email, c.market, c.specialty, c.dealName,
        ...(c.tags ?? [])].some(v => v?.toLowerCase().includes(q)))
  }, [contacts, catFilter, favOnly, search])

  const byCategory = useMemo(() => {
    const m = new Map<AmCategory, AmContact[]>()
    for (const c of visible) {
      const list = m.get(c.category) ?? []
      list.push(c)
      m.set(c.category, list)
    }
    return AM_CATEGORIES
      .map(cat => ({ cat, list: (m.get(cat.key) ?? []).sort(sortContacts) }))
      .filter(x => x.list.length > 0)
  }, [visible])

  async function handleDelete(c: AmContact) {
    if (!confirm(`Delete ${c.contactName || c.company || 'this contact'}?`)) return
    await deleteAmContact(c.id)
    refetch()
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 720 }}>
          The asset-management rolodex — tenant real-estate departments, leasing brokers, attorneys, lenders and
          capital partners gathered through negotiations. Tag a contact to a pipeline deal or asset so you can find
          the right person when you’re working a deal. <b>Asset managers &amp; admin only.</b>
        </div>
        <button onClick={() => setEditing('new')} style={primaryBtn}>+ Add contact</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        {AM_CATEGORIES.filter(c => counts[c.key] > 0).map(c => {
          const on = catFilter === c.key
          return (
            <button
              key={c.key}
              onClick={() => setCatFilter(on ? null : c.key)}
              style={{
                fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                background: 'var(--surface-2)', color: on ? WILKOW : 'var(--text-muted)',
                border: `1px solid ${on ? WILKOW : 'var(--border-2)'}`,
                boxShadow: on ? `0 0 0 1px ${WILKOW}` : 'none',
              }}
            >
              {c.icon} {c.label} · {counts[c.key]}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFavOnly(v => !v)}
          style={{
            fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
            background: favOnly ? WILKOW : 'var(--surface-2)', color: favOnly ? '#fff' : WILKOW,
            border: `1px solid ${WILKOW}`,
          }}
        >
          ★ Favorites
        </button>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search people, firms, tags…"
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', width: 200 }}
        />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load relationship contacts" subtitle={error} />}
      {!loading && !error && contacts.length === 0 && (
        <EmptyState icon="🤝" title="No relationship contacts yet"
          subtitle="Add brokers, tenant RE reps, attorneys, lenders and partners with “+ Add contact”" />
      )}
      {!loading && !error && contacts.length > 0 && visible.length === 0 && (
        <EmptyState icon="🔍" title="Nothing matches" subtitle="Clear the category / favorites filter or search above" />
      )}

      {byCategory.map(({ cat, list }) => (
        <div key={cat.key} style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 10 }}>
            {cat.icon} {cat.label} <span style={{ color: 'var(--text-faint)', letterSpacing: 0 }}>· {list.length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {list.map(c => (
              <ContactCard
                key={c.id}
                c={c}
                propertyNames={propertyNames}
                onEdit={setEditing}
                onDelete={handleDelete}
                onToggleFav={async () => { await toggleAmFavorite(c.id, !c.isFavorite); refetch() }}
              />
            ))}
          </div>
        </div>
      ))}

      {editing && (
        <RelationshipModal
          initial={editing === 'new' ? null : editing}
          deals={deals ?? []}
          properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
          propertyNames={propertyNames}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refetch() }}
        />
      )}
    </>
  )
}

function sortContacts(a: AmContact, b: AmContact): number {
  return (Number(b.isFavorite) - Number(a.isFavorite)) ||
    (a.company ?? a.contactName ?? '').localeCompare(b.company ?? b.contactName ?? '')
}

// ── card ──────────────────────────────────────────────────────────────────
function ContactCard({ c, propertyNames, onEdit, onDelete, onToggleFav }: {
  c: AmContact
  propertyNames: Record<string, string>
  onEdit: (c: AmContact) => void
  onDelete: (c: AmContact) => void
  onToggleFav: () => void
}) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${WILKOW}`, borderRadius: 11, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          {(c.contactName || c.title) && (
            <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>
              {c.contactName}{c.title ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {c.title}</span> : null}
            </div>
          )}
          {c.company && <div style={{ fontSize: 12.5, color: c.contactName ? 'var(--text-muted)' : 'var(--text)', fontWeight: c.contactName ? 400 : 700 }}>{c.company}</div>}
          {c.represents && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>represents {c.represents}</div>}
        </div>
        <button onClick={onToggleFav} title={c.isFavorite ? 'Unfavorite' : 'Favorite'}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: c.isFavorite ? '#e0a800' : 'var(--text-faint)', lineHeight: 1 }}>
          {c.isFavorite ? '★' : '☆'}
        </button>
      </div>

      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {c.email && <div style={{ fontSize: 12 }}><a href={`mailto:${c.email}`} style={{ color: WILKOW }}>{c.email}</a></div>}
        {c.phone && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.phone}{c.mobile ? ` · ${c.mobile} (m)` : ''}</div>}
        {!c.phone && c.mobile && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.mobile} (m)</div>}
      </div>

      {(c.market || c.specialty) && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
          {[c.specialty, c.market].filter(Boolean).join(' · ')}
        </div>
      )}

      {(c.tags?.length || c.dealName || c.propertyIds?.length) && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
          {c.dealName && (
            <Link to="/pipeline" style={{ ...tagPill, color: WILKOW, borderColor: WILKOW, textDecoration: 'none' }}>📈 {c.dealName}</Link>
          )}
          {(c.propertyIds ?? []).map(pid => (
            <Link key={pid} to={`/properties/${pid}`} style={{ ...tagPill, textDecoration: 'none' }}>🏢 {propertyNames[pid] ?? 'Property'}</Link>
          ))}
          {(c.tags ?? []).map(t => <span key={t} style={tagPill}>{t}</span>)}
        </div>
      )}

      {c.notes && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6, fontStyle: 'italic' }}>{c.notes}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
        {c.lastContacted && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>last contact {fmtDate(c.lastContacted)}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => onEdit(c)} style={linkBtn}>edit</button>
        <button onClick={() => onDelete(c)} style={{ ...linkBtn, color: 'var(--red)' }}>delete</button>
      </div>
    </div>
  )
}

// ── add / edit modal ──────────────────────────────────────────────────────
function RelationshipModal({ initial, deals, properties, propertyNames, onClose, onSaved }: {
  initial: AmContact | null
  deals: DealOption[]
  properties: { id: string; name: string }[]
  propertyNames: Record<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const editingExisting = !!initial
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [category, setCategory] = useState<AmCategory>(initial?.category ?? 'broker')
  const [f, setF] = useState({
    contactName: initial?.contactName ?? '', title: initial?.title ?? '', company: initial?.company ?? '',
    represents: initial?.represents ?? '', email: initial?.email ?? '', phone: initial?.phone ?? '',
    mobile: initial?.mobile ?? '', addressLine1: initial?.addressLine1 ?? '', addressLine2: initial?.addressLine2 ?? '',
    city: initial?.city ?? '', state: initial?.state ?? '', zip: initial?.zip ?? '',
    market: initial?.market ?? '', specialty: initial?.specialty ?? '', source: initial?.source ?? '',
    lastContacted: initial?.lastContacted ?? '', notes: initial?.notes ?? '',
    tags: (initial?.tags ?? []).join(', '),
  })
  const [dealId, setDealId] = useState<string>(initial?.dealId ?? '')
  const [propertyIds, setPropertyIds] = useState<string[]>(initial?.propertyIds ?? [])
  const [isFavorite, setIsFavorite] = useState(initial?.isFavorite ?? false)

  function toggleProp(id: string) {
    setPropertyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function save() {
    setErr(null)
    if (!f.contactName.trim() && !f.company.trim()) { setErr('Enter a contact name or a firm'); return }
    const draft: AmContactDraft = {
      category,
      contactName: f.contactName, title: f.title, company: f.company, represents: f.represents,
      email: f.email, phone: f.phone, mobile: f.mobile,
      addressLine1: f.addressLine1, addressLine2: f.addressLine2, city: f.city, state: f.state, zip: f.zip,
      market: f.market, specialty: f.specialty, source: f.source, notes: f.notes,
      lastContacted: f.lastContacted || null,
      tags: f.tags.split(',').map(t => t.trim()).filter(Boolean),
      dealId: dealId || null,
      propertyIds,
      isFavorite,
    }
    setSaving(true)
    try {
      if (initial) await updateAmContact(initial.id, draft)
      else await createAmContact(draft)
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
        <div style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: 'var(--text)', marginBottom: 14 }}>
          {editingExisting ? 'Edit relationship contact' : 'Add relationship contact'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Category">
            <select value={category} onChange={e => setCategory(e.target.value as AmCategory)} style={input}>
              {AM_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Flags">
            <label style={{ ...checkLbl, height: 34 }}>
              <input type="checkbox" checked={isFavorite} onChange={e => setIsFavorite(e.target.checked)} /> ★ Favorite
            </label>
          </Field>

          <Field label="Contact name"><input value={f.contactName} onChange={set('contactName')} style={input} /></Field>
          <Field label="Title / role"><input value={f.title} onChange={set('title')} style={input} /></Field>
          <Field label="Firm / company"><input value={f.company} onChange={set('company')} style={input} /></Field>
          <Field label="Represents"><input value={f.represents} onChange={set('represents')} placeholder="e.g. Starbucks, the seller" style={input} /></Field>

          <Field label="Email"><input value={f.email} onChange={set('email')} type="email" style={input} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} style={input} /></Field>
          <Field label="Mobile"><input value={f.mobile} onChange={set('mobile')} style={input} /></Field>
          <Field label="Last contacted"><input value={f.lastContacted} onChange={set('lastContacted')} type="date" style={input} /></Field>

          <Field label="Market / region"><input value={f.market} onChange={set('market')} placeholder="e.g. Chicago, Southeast" style={input} /></Field>
          <Field label="Specialty"><input value={f.specialty} onChange={set('specialty')} placeholder="e.g. retail leasing, CMBS" style={input} /></Field>

          <Field label="Tags (comma-separated)" span2><input value={f.tags} onChange={set('tags')} placeholder="anchor deals, quick responder" style={input} /></Field>

          <Field label="Link to pipeline deal" span2>
            <select value={dealId} onChange={e => setDealId(e.target.value)} style={input}>
              <option value="">— none —</option>
              {deals.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>

          <Field label="Associated properties" span2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 108, overflowY: 'auto', border: '1px solid var(--border-2)', borderRadius: 7, padding: 8, background: 'var(--surface-2)' }}>
              {properties.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>No properties available</span>}
              {properties.map(p => {
                const on = propertyIds.includes(p.id)
                return (
                  <button key={p.id} type="button" onClick={() => toggleProp(p.id)}
                    style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 99, cursor: 'pointer',
                      background: on ? WILKOW : 'var(--surface)', color: on ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${on ? WILKOW : 'var(--border-2)'}` }}>
                    {propertyNames[p.id] ?? p.name}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Source (how we got them)" span2><input value={f.source} onChange={set('source')} placeholder="e.g. 2025 GLA renewal, referral from J. Smith" style={input} /></Field>
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
const tagPill: CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 99, padding: '2px 8px' }
const input: CSSProperties = { fontSize: 12.5, padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' }
const checkLbl: CSSProperties = { fontSize: 12, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', zIndex: 1000, overflowY: 'auto' }
const modal: CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '22px 24px', width: '100%', maxWidth: 640, boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }

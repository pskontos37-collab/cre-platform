import { CSSProperties, FormEvent, ReactNode, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties } from '../hooks/useProperties'
import {
  WorkOrder, WoComment, WoPhoto, PortalUserRow, VendorBookRow,
  useWorkOrders, usePortalUsers, useVendorBook,
  fetchOrderThread, signPhotoUrl, setWorkOrderStatus,
  addStaffComment, createStaffWorkOrder,
  routeToVendor, recommendVendors, vendorUniverse,
  createPortalUser, resetPortalPassword, setPortalUserActive, tempPassword,
} from '../hooks/useWorkOrders'
import {
  WO_CATEGORIES, WO_PRIORITIES, WO_STATUSES, OPEN_STATUSES,
  categoryIcon, categoryLabel, statusMeta, priorityColor, woNumber,
} from '../lib/workOrderMeta'

// Staff work-order management (/workorders): the queue tenants feed from the
// /portal tenant app, plus staff-entered orders and portal-login admin.
// Share https://<app>/portal with tenants — that page has its own login.

const inputStyle: CSSProperties = {
  padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box',
}
const labelStyle: CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4,
}
const btn: CSSProperties = {
  padding: '7px 13px', borderRadius: 7, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
}
const primaryBtn: CSSProperties = { ...btn, background: 'var(--accent)', border: 'none', color: '#fff' }

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—')
const daysOpen = (o: WorkOrder) => {
  const end = o.completedAt ? new Date(o.completedAt).getTime() : Date.now()
  return Math.max(0, Math.round((end - new Date(o.createdAt).getTime()) / 86400000))
}

export function WorkOrdersPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const propertyIds = useMemo(() => (properties ?? []).map(p => p.id), [properties])
  const propertyNames = useMemo(
    () => Object.fromEntries((properties ?? []).map(p => [p.id, p.name])), [properties])

  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = () => setRefreshKey(k => k + 1)
  const { data: orders, loading, error } = useWorkOrders(propertyIds, propertyNames, refreshKey)
  const { data: vendorBook } = useVendorBook(propertyIds)

  const [tab, setTab] = useState<'queue' | 'portal'>('queue')
  const [statusFilter, setStatusFilter] = useState<'open' | 'all' | string>('open')
  const [propertyFilter, setPropertyFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showNewOrder, setShowNewOrder] = useState(false)

  const all = orders ?? []
  const filtered = useMemo(() => all.filter(o => {
    if (statusFilter === 'open' && !OPEN_STATUSES.includes(o.status)) return false
    if (statusFilter !== 'open' && statusFilter !== 'all' && o.status !== statusFilter) return false
    if (propertyFilter && o.propertyId !== propertyFilter) return false
    if (search) {
      const q = search.toLowerCase()
      const hay = `${woNumber(o.woNumber)} ${o.tenantName} ${o.title} ${o.unitLabel ?? ''} ${categoryLabel(o.category)}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }), [all, statusFilter, propertyFilter, search])

  const openOrders = all.filter(o => OPEN_STATUSES.includes(o.status))
  const emergencies = openOrders.filter(o => o.priority === 'emergency')
  const unrouted = openOrders.filter(o => !o.assignedVendor)
  const avgAge = openOrders.length
    ? Math.round(openOrders.reduce((s, o) => s + daysOpen(o), 0) / openOrders.length) : 0

  const selected = all.find(o => o.id === selectedId) ?? null

  return (
    <div style={{ padding: '4px 0 40px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Work Orders</h1>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Tenant maintenance requests from the <b>/portal</b> tenant app plus staff-entered orders.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={tab === 'queue' ? primaryBtn : btn} onClick={() => setTab('queue')}>Queue</button>
          <button style={tab === 'portal' ? primaryBtn : btn} onClick={() => setTab('portal')}>Portal access</button>
        </div>
      </div>

      {tab === 'portal' ? (
        <PortalAccessTab propertyIds={propertyIds} propertyNames={propertyNames}
          properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))} />
      ) : (
        <>
          {/* KPI band */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Kpi label="Open" value={openOrders.length} />
            <Kpi label="Emergency" value={emergencies.length} color={emergencies.length ? 'var(--red)' : undefined} />
            <Kpi label="Not routed" value={unrouted.length} color={unrouted.length ? 'var(--amber)' : undefined} />
            <Kpi label="Avg days open" value={avgAge} />
          </div>

          {/* filters */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <button style={statusFilter === 'open' ? primaryBtn : btn} onClick={() => setStatusFilter('open')}>Open</button>
            {WO_STATUSES.map(s => (
              <button key={s.value} style={statusFilter === s.value ? primaryBtn : btn}
                onClick={() => setStatusFilter(s.value)}>{s.label}</button>
            ))}
            <button style={statusFilter === 'all' ? primaryBtn : btn} onClick={() => setStatusFilter('all')}>All</button>
            <select style={{ ...inputStyle, minWidth: 160 }} value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)}>
              <option value="">All properties</option>
              {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input style={{ ...inputStyle, flex: 1, minWidth: 180 }} placeholder="Search tenant, title, WO number…"
              value={search} onChange={e => setSearch(e.target.value)} />
            <button style={btn} onClick={() => setShowNewOrder(true)}>+ Log order</button>
          </div>

          {error && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 10 }}>{error}</div>}
          {loading && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading work orders…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '30px 20px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
              No work orders match. Tenant-submitted requests will appear here the moment they come in.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map(o => (
              <OrderRow key={o.id} order={o} selected={o.id === selectedId}
                onClick={() => setSelectedId(o.id === selectedId ? null : o.id)} />
            ))}
          </div>

          {selected && appUser && (
            <DetailPanel key={selected.id} order={selected}
              allOrders={all} vendorBook={vendorBook ?? []}
              me={{ id: appUser.id, name: appUser.full_name ?? appUser.email }}
              onClose={() => setSelectedId(null)} onChanged={refresh} />
          )}

          {showNewOrder && appUser && (
            <NewStaffOrderModal
              properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
              createdBy={appUser.id}
              onClose={() => setShowNewOrder(false)}
              onCreated={() => { setShowNewOrder(false); refresh() }} />
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 2, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  )
}

function OrderRow({ order: o, selected, onClick }: { order: WorkOrder; selected: boolean; onClick: () => void }) {
  const meta = statusMeta(o.status)
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', cursor: 'pointer',
      padding: '11px 14px', borderRadius: 9,
      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--surface)',
    }}>
      <span style={{ fontSize: 18 }}>{categoryIcon(o.category)}</span>
      <span style={{ width: 86, fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>{woNumber(o.woNumber)}</span>
      <span style={{ flex: 2, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.locationType === 'common_area' && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 5px', marginRight: 7, verticalAlign: 'middle',
            }}>
              COMMON AREA
            </span>
          )}
          {o.title}
        </span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {o.tenantName}{o.unitLabel ? ` · ${o.unitLabel}` : ''} · {o.propertyName}
          {o.assignedVendor ? <span style={{ color: 'var(--text-muted)' }}> · → {o.assignedVendor}</span> : ''}
        </span>
      </span>
      <span style={{ width: 84, fontSize: 11.5, fontWeight: 700, color: priorityColor(o.priority), textTransform: 'capitalize', flexShrink: 0 }}>
        {o.priority}
      </span>
      <span style={{ width: 70, fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>{daysOpen(o)}d</span>
      <span style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', flexShrink: 0,
        color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 999, padding: '2px 9px',
      }}>
        {meta.label}
      </span>
    </button>
  )
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ order, allOrders, vendorBook, me, onClose, onChanged }: {
  order: WorkOrder
  allOrders: WorkOrder[]
  vendorBook: VendorBookRow[]
  me: { id: string; name: string }
  onClose: () => void
  onChanged: () => void
}) {
  const [comments, setComments] = useState<WoComment[]>([])
  const [photos, setPhotos] = useState<(WoPhoto & { url: string | null })[]>([])
  const [comment, setComment] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [resolution, setResolution] = useState(order.resolutionNotes ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function loadThread() {
    try {
      const t = await fetchOrderThread(order.id)
      setComments(t.comments)
      setPhotos(await Promise.all(t.photos.map(async p => ({ ...p, url: await signPhotoUrl(p.storagePath) }))))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { loadThread() }, [order.id])

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null)
    try { await fn(); onChanged() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }

  async function sendComment(e: FormEvent) {
    e.preventDefault()
    if (!comment.trim()) return
    setBusy(true); setErr(null)
    try {
      await addStaffComment(order.id, me, comment.trim(), isInternal)
      setComment('')
      await loadThread()
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)) }
    setBusy(false)
  }

  const nextActions: { label: string; status: string; style?: CSSProperties }[] = []
  if (order.status === 'new') nextActions.push({ label: 'Acknowledge', status: 'acknowledged' })
  if (['new', 'acknowledged', 'on_hold'].includes(order.status)) nextActions.push({ label: 'Start work', status: 'in_progress' })
  if (order.status === 'in_progress') nextActions.push({ label: 'Put on hold', status: 'on_hold' })
  if (!['completed', 'cancelled'].includes(order.status)) {
    nextActions.push({ label: 'Complete', status: 'completed', style: { borderColor: 'var(--green)', color: 'var(--green)' } })
    nextActions.push({ label: 'Cancel', status: 'cancelled', style: { color: 'var(--text-faint)' } })
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(480px, 92vw)', zIndex: 60,
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
      boxShadow: '-12px 0 32px rgba(0,0,0,0.25)', overflowY: 'auto', padding: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            {woNumber(order.woNumber)} · {order.propertyName} · via {order.source === 'portal' ? 'tenant portal' : 'staff'}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3 }}>{order.title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
            {order.tenantName}{order.unitLabel ? ` · ${order.unitLabel}` : ''}
            {order.contactPhone ? ` · ${order.contactPhone}` : ''}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>
            {categoryIcon(order.category)} {categoryLabel(order.category)} ·{' '}
            <span style={{ color: priorityColor(order.priority), fontWeight: 700, textTransform: 'capitalize' }}>{order.priority}</span>
            {' '}· opened {fmtDate(order.createdAt)} ({daysOpen(order)}d)
            {' '}· {order.permissionToEnter ? 'entry OK' : '⚠ NO entry without tenant present'}
          </div>
          {order.locationType === 'common_area' && (
            <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 700, marginTop: 4 }}>
              📍 Common area{order.locationDetail ? ` — ${order.locationDetail}` : ''}
            </div>
          )}
        </div>
        <button onClick={onClose} style={{ ...btn, padding: '4px 10px' }}>✕</button>
      </div>

      {order.description && (
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
          {order.description}
        </div>
      )}

      {photos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {photos.map(p => p.url && (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
              <img src={p.url} alt={p.caption ?? 'photo'} style={{ width: 78, height: 78, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
            </a>
          ))}
        </div>
      )}

      {/* status + assignment */}
      <div style={{ marginTop: 16 }}>
        <label style={labelStyle}>Status — currently <b style={{ color: statusMeta(order.status).color }}>{statusMeta(order.status).label}</b></label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {nextActions.map(a => (
            <button key={a.status} disabled={busy} style={{ ...btn, ...a.style }}
              onClick={() => run(() => setWorkOrderStatus(order, a.status, a.status === 'completed' ? resolution : undefined))}>
              {a.label}
            </button>
          ))}
        </div>
        {!['completed', 'cancelled'].includes(order.status) && (
          <div style={{ marginTop: 10 }}>
            <label style={labelStyle}>Resolution note (sent to tenant on complete)</label>
            <input style={{ ...inputStyle, width: '100%' }} value={resolution}
              onChange={e => setResolution(e.target.value)} placeholder="What was done…" />
          </div>
        )}
      </div>

      <RoutingBlock order={order} allOrders={allOrders} vendorBook={vendorBook} busy={busy} run={run} />

      {/* thread */}
      <div style={{ marginTop: 18 }}>
        <label style={labelStyle}>Thread (internal notes shaded, hidden from the tenant)</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {comments.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No comments yet.</div>}
          {comments.map(c => (
            <div key={c.id} style={{
              padding: '9px 11px', borderRadius: 8, fontSize: 12.5,
              border: `1px solid ${c.isInternal ? 'var(--amber)' : 'var(--border)'}`,
              background: c.isInternal ? 'color-mix(in srgb, var(--amber) 8%, transparent)' : 'var(--bg)',
            }}>
              <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 3 }}>
                {c.authorKind === 'tenant' ? `${c.authorName ?? 'Tenant'} (tenant)` : c.authorName ?? 'Staff'}
                {c.isInternal ? ' · INTERNAL' : ''} · {new Date(c.createdAt).toLocaleString()}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
        </div>
        <form onSubmit={sendComment} style={{ marginTop: 10 }}>
          <textarea style={{ ...inputStyle, width: '100%', minHeight: 60, resize: 'vertical' }}
            placeholder={isInternal ? 'Internal note (never shown to the tenant)…' : 'Reply to the tenant…'}
            value={comment} onChange={e => setComment(e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)} />
              Internal note
            </label>
            <button type="submit" disabled={busy || !comment.trim()}
              style={{ ...primaryBtn, opacity: busy || !comment.trim() ? 0.5 : 1 }}>
              {isInternal ? 'Add note' : 'Send to tenant'}
            </button>
          </div>
        </form>
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{err}</div>}
    </div>
  )
}

// ── Contractor routing ───────────────────────────────────────────────────────
// No prefilled staff names: orders route to a contractor. Recommendations are
// ranked from (1) learned history — who this property's orders in this
// category were routed to before — and (2) the service-agreements vendor book
// (current contract-holder first). Every routing made here becomes training
// data for the next recommendation.

function RoutingBlock({ order, allOrders, vendorBook, busy, run }: {
  order: WorkOrder
  allOrders: WorkOrder[]
  vendorBook: VendorBookRow[]
  busy: boolean
  run: (fn: () => Promise<void>) => void
}) {
  const [custom, setCustom] = useState('')
  const suggestions = useMemo(
    () => recommendVendors(allOrders, vendorBook, order.propertyId, order.category)
      .filter(s => s.vendor.toLowerCase() !== (order.assignedVendor ?? '').toLowerCase()),
    [allOrders, vendorBook, order.propertyId, order.category, order.assignedVendor])
  const universe = useMemo(() => vendorUniverse(allOrders, vendorBook), [allOrders, vendorBook])

  return (
    <div style={{ marginTop: 16 }}>
      <label style={labelStyle}>Route to contractor</label>

      {order.assignedVendor ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '9px 12px', borderRadius: 8, border: '1px solid var(--accent)', marginBottom: 8,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>→ {order.assignedVendor}</span>
          <button disabled={busy} style={{ ...btn, padding: '3px 9px', fontSize: 11 }}
            onClick={() => run(() => routeToVendor(order.id, null))}>
            Unroute
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 8 }}>Not routed yet.</div>
      )}

      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {suggestions.map((s, i) => (
            <button key={s.vendor} disabled={busy}
              onClick={() => run(() => routeToVendor(order.id, s.vendor))}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: '8px 11px', borderRadius: 8,
                border: `1px solid ${i === 0 ? 'var(--green)' : 'var(--border)'}`, background: 'var(--bg)',
              }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                {i === 0 ? '★ ' : ''}{s.vendor}
              </span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>
                {s.reason}
              </span>
            </button>
          ))}
        </div>
      )}
      {suggestions.length === 0 && !order.assignedVendor && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 8 }}>
          No history or matching service contract for {categoryLabel(order.category).toLowerCase()} at this
          property yet — route below and the system remembers for next time.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <input list="wo-vendor-universe" style={{ ...inputStyle, flex: 1 }}
          placeholder="Other contractor…" value={custom} onChange={e => setCustom(e.target.value)} />
        <datalist id="wo-vendor-universe">
          {universe.map(v => <option key={v} value={v} />)}
        </datalist>
        <button disabled={busy || !custom.trim()} style={{ ...btn, opacity: busy || !custom.trim() ? 0.5 : 1 }}
          onClick={() => { const v = custom.trim(); setCustom(''); run(() => routeToVendor(order.id, v)) }}>
          Route
        </button>
      </div>
    </div>
  )
}

// ── Staff-entered order (phone call / walk-in) ───────────────────────────────

function NewStaffOrderModal({ properties, createdBy, onClose, onCreated }: {
  properties: { id: string; name: string }[]
  createdBy: string
  onClose: () => void
  onCreated: () => void
}) {
  const [form, setForm] = useState({
    propertyId: '', tenantName: '', unitLabel: '', category: 'other',
    priority: 'normal', title: '', description: '', contactPhone: '', locationDetail: '',
  })
  const [commonArea, setCommonArea] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await createStaffWorkOrder({
        ...form, createdBy,
        locationType: commonArea ? 'common_area' : 'unit',
        locationDetail: commonArea ? form.locationDetail : '',
      })
      onCreated()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title="Log a work order" subtitle="For requests that arrive by phone / email / walk-in." onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Property</label>
            <select style={{ ...inputStyle, width: '100%' }} value={form.propertyId} required
              onChange={e => set('propertyId', e.target.value)}>
              <option value="">Choose…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Tenant</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.tenantName} required
              onChange={e => set('tenantName', e.target.value)} placeholder="Tenant name" />
          </div>
          <div>
            <label style={labelStyle}>Suite / unit</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.unitLabel}
              onChange={e => set('unitLabel', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Contact phone</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.contactPhone}
              onChange={e => set('contactPhone', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Category</label>
            <select style={{ ...inputStyle, width: '100%' }} value={form.category}
              onChange={e => set('category', e.target.value)}>
              {WO_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Priority</label>
            <select style={{ ...inputStyle, width: '100%' }} value={form.priority}
              onChange={e => set('priority', e.target.value)}>
              {WO_PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={commonArea} onChange={e => setCommonArea(e.target.checked)} />
          Common-area issue (not inside the tenant's space)
        </label>
        {commonArea && (
          <div>
            <label style={labelStyle}>Where in the common area?</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.locationDetail}
              onChange={e => set('locationDetail', e.target.value)}
              placeholder="e.g. parking lot light pole near main entrance" />
          </div>
        )}
        <div>
          <label style={labelStyle}>Title</label>
          <input style={{ ...inputStyle, width: '100%' }} value={form.title} required maxLength={140}
            onChange={e => set('title', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea style={{ ...inputStyle, width: '100%', minHeight: 70, resize: 'vertical' }}
            value={form.description} onChange={e => set('description', e.target.value)} />
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={btn} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : 'Create order'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ── Portal access tab ────────────────────────────────────────────────────────

function PortalAccessTab({ propertyIds, propertyNames, properties }: {
  propertyIds: string[]
  propertyNames: Record<string, string>
  properties: { id: string; name: string }[]
}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: users, loading, error } = usePortalUsers(propertyIds, propertyNames, refreshKey)
  const [showCreate, setShowCreate] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const portalUrl = `${window.location.origin}/portal`

  async function doReset(u: PortalUserRow) {
    const pw = tempPassword()
    if (!window.confirm(`Reset the portal password for ${u.email}? A new temporary password will be generated.`)) return
    try {
      await resetPortalPassword(u.id, pw)
      setNotice(`Temporary password for ${u.email}: ${pw} — share it with the tenant; they must change it at first sign-in.`)
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  async function doToggle(u: PortalUserRow) {
    try {
      await setPortalUserActive(u.id, !u.isActive)
      setRefreshKey(k => k + 1)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div>
      <div style={{
        border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px',
        background: 'var(--surface)', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14,
      }}>
        Tenants sign in at <b style={{ color: 'var(--text)' }}>{portalUrl}</b>{' '}
        <button style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
          onClick={() => navigator.clipboard.writeText(portalUrl)}>copy link</button>
        {' '}— portal logins are separate from staff accounts and can only see their own tenant's requests.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>Tenant portal logins</div>
        <button style={primaryBtn} onClick={() => setShowCreate(true)}>+ New login</button>
      </div>

      {notice && (
        <div style={{ fontSize: 12.5, color: 'var(--text)', border: '1px solid var(--green)', borderRadius: 8, padding: '9px 12px', marginBottom: 10 }}>
          {notice}
        </div>
      )}
      {(error || err) && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 10 }}>{error || err}</div>}
      {loading && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading…</div>}
      {!loading && (users ?? []).length === 0 && (
        <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '26px 20px', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
          No tenant logins yet. Create one per tenant contact and share the portal link + temporary password.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(users ?? []).map(u => (
          <div key={u.id} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 9,
            border: '1px solid var(--border)', background: 'var(--surface)', opacity: u.isActive ? 1 : 0.55,
          }}>
            <span style={{ flex: 2, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{u.tenantName}{u.unitLabel ? ` · ${u.unitLabel}` : ''}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>
                {u.contactName ? `${u.contactName} · ` : ''}{u.email} · {u.propertyName}
              </span>
            </span>
            <span style={{ width: 130, fontSize: 11.5, color: 'var(--text-faint)', flexShrink: 0 }}>
              {u.lastLoginAt ? `last login ${fmtDate(u.lastLoginAt)}` : 'never signed in'}
            </span>
            {u.mustChangePassword && (
              <span style={{ fontSize: 10.5, color: 'var(--amber)', fontWeight: 700, flexShrink: 0 }}>TEMP PW</span>
            )}
            <button style={{ ...btn, padding: '4px 10px', fontSize: 11.5 }} onClick={() => doReset(u)}>Reset password</button>
            <button style={{ ...btn, padding: '4px 10px', fontSize: 11.5 }} onClick={() => doToggle(u)}>
              {u.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        ))}
      </div>

      {showCreate && (
        <CreatePortalUserModal properties={properties}
          onClose={() => setShowCreate(false)}
          onCreated={(email, pw) => {
            setShowCreate(false)
            setRefreshKey(k => k + 1)
            setNotice(`Login created. Temporary password for ${email}: ${pw} — share it with the tenant; they must change it at first sign-in.`)
          }} />
      )}
    </div>
  )
}

function CreatePortalUserModal({ properties, onClose, onCreated }: {
  properties: { id: string; name: string }[]
  onClose: () => void
  onCreated: (email: string, password: string) => void
}) {
  const [form, setForm] = useState({
    propertyId: '', tenantName: '', unitLabel: '', email: '', contactName: '', phone: '',
  })
  const [password] = useState(tempPassword())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await createPortalUser({ ...form, password })
      onCreated(form.email.trim().toLowerCase(), password)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
      setBusy(false)
    }
  }

  return (
    <Modal title="New tenant portal login" subtitle="The tenant signs in with this email + the temporary password below, then sets their own." onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Property</label>
            <select style={{ ...inputStyle, width: '100%' }} value={form.propertyId} required
              onChange={e => set('propertyId', e.target.value)}>
              <option value="">Choose…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Tenant name</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.tenantName} required
              onChange={e => set('tenantName', e.target.value)} placeholder="As it appears on the lease" />
          </div>
          <div>
            <label style={labelStyle}>Suite / unit</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.unitLabel}
              onChange={e => set('unitLabel', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Contact name</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.contactName}
              onChange={e => set('contactName', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Email (their login)</label>
            <input style={{ ...inputStyle, width: '100%' }} type="email" value={form.email} required
              onChange={e => set('email', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Phone</label>
            <input style={{ ...inputStyle, width: '100%' }} value={form.phone}
              onChange={e => set('phone', e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: 12.5, border: '1px dashed var(--border)', borderRadius: 8, padding: '9px 12px' }}>
          Temporary password: <b>{password}</b>{' '}
          <button type="button" style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
            onClick={() => navigator.clipboard.writeText(password)}>copy</button>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={btn} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create login'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function Modal({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode
}) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(560px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: 20, maxHeight: '84vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ ...btn, padding: '4px 10px' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
